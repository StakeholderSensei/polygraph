import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipPrompt, contractInstruction } from '../scripts/lib/prompts.mjs';
import { DEFAULT_CONFIG } from '../scripts/lib/state.mjs';

const cfg = DEFAULT_CONFIG;
const skip = (p) => shouldSkipPrompt(p, cfg);

// FR-1.2 skip matrix
const cases = [
  ['/polygraph:status', true, 'slash-command'],
  ['fix it', true, 'too-short'], // < 20 chars
  ['what is a monad and why should I care about it?', true, 'pure-question'],
  ['explain the difference between let and const in JS', true, 'pure-question'],
  ['can you explain how the event loop schedules timers?', true, 'pure-question'],
  ['how do I fix the login bug in src/auth.ts today?', false, null], // question word + imperative "fix"
  ['what happens here? ```js\nfoo()\n``` and why', false, null], // code fence defeats the skip
  ['add rate limiting to the API and update the docs', false, null],
  ['Rename getUserData everywhere and migrate the tests.', false, null],
  ['per favore aggiungi il rate limiting alle API del progetto', false, null], // non-English imperative: not skipped (defaults are EN; question_words is a config key)
];
for (const [prompt, expected, reason] of cases) {
  test(`skip(${JSON.stringify(prompt.slice(0, 40))}) → ${expected}`, () => {
    const r = skip(prompt);
    assert.equal(r.skip, expected);
    if (reason) assert.equal(r.reason, reason);
  });
}

test('question-word match is word-boundary aware ("whatever" is not "what")', () => {
  assert.equal(skip('whatever you decide, refactor the config loader now').skip, false);
});

test("contractions count as questions: \"what's the difference…\" skips (M2 finding)", () => {
  assert.deepEqual(skip("what's the difference between let and const in JS?"),
    { skip: true, reason: 'pure-question' });
  assert.equal(skip("who's responsible for the auth module in this codebase?").skip, true);
});

test('regex-metachar keywords never throw and match literally (c++)', () => {
  const custom = { ...cfg, imperative_keywords: ['c++', 'fix('] };
  assert.equal(skip.constructor, Function); // sanity
  const r = shouldSkipPrompt('how does the c++ linker resolve symbols across units?', custom);
  assert.equal(r.skip, false, "'c++' present as a word ⇒ imperative override, no SyntaxError");
  const q = shouldSkipPrompt('why is the sky blue on some evenings and red on others?', custom);
  assert.equal(q.skip, true, 'bad-metachar keyword must not break pure-question skips');
});

test('non-ASCII keywords match with Unicode boundaries (ändern, aggiungi)', () => {
  const custom = { ...cfg, question_words: [...cfg.question_words, 'wie', 'perché'], imperative_keywords: [...cfg.imperative_keywords, 'ändern', 'aggiungi'] };
  const de = shouldSkipPrompt('wie kann ich die Funktion ändern, bitte ändern Sie sie jetzt', custom);
  assert.equal(de.skip, false, 'German imperative inside a question must qualify');
  const it = shouldSkipPrompt('perché questo codice è così lento in produzione oggi?', custom);
  assert.equal(it.skip, true, 'capitalized config entries match case-insensitively');
});

test('slash check runs on the RAW prompt: whitespace-led paths are not slash commands', () => {
  assert.equal(skip('  /src/auth.ts is broken — fix the token refresh logic').skip, false);
  assert.equal(skip('/polygraph:status').skip, true);
});

test('instruction: creation variant carries the exact header line; follow-up does not', () => {
  const header = '<!-- polygraph:v1 session:s1 created:2026-07-13T00:00:00Z baseline:abc123 -->';
  const create = contractInstruction('P1', header);
  assert.ok(create.includes(header), 'exact header line included verbatim');
  assert.match(create, /STARTING with this exact line/);
  assert.match(create, /defer it \(/); // the supersession lesson, compressed
  assert.match(create, /\[evidence: cmd\]/);
  const followUp = contractInstruction('P2', null);
  assert.ok(!followUp.includes('polygraph:v1'), 'no header on accumulation');
  assert.match(followUp, /append/);
});

test('instruction stays inside the ≤180-token budget (NFR-P2, ~4 chars/token)', () => {
  const header = '<!-- polygraph:v1 session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee created:2026-07-13T12:00:00.000Z baseline:0123456789abcdef0123456789abcdef01234567 -->';
  const len = contractInstruction('P12', header).length;
  assert.ok(len / 4 <= 180, `instruction ≈${Math.round(len / 4)} tokens — over budget`);
});
