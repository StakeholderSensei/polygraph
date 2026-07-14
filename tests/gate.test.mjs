// The gate matrix: evaluateGate() driven directly over fabricated state.
// End-to-end (spawned dispatcher) coverage lives in bench/scenarios/m1-*.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { evaluateGate } from '../scripts/lib/gate.mjs';
import { ensureStateDir, ensureGitignore, DEFAULT_CONFIG, updateSessionState } from '../scripts/lib/state.mjs';
import { appendEntry } from '../scripts/lib/ledger.mjs';
import { verdictLine } from '../scripts/lib/receipts.mjs';

const SID = 's_gate';

function world({ git = true } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-test-'));
  const g = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  let baseline = 'none';
  if (git) {
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
    fs.writeFileSync(path.join(cwd, 'README.md'), 'seed');
    g('add', '.'); g('commit', '-qm', 'seed');
    baseline = g('rev-parse', 'HEAD');
  }
  const paths = ensureStateDir(cwd);
  if (git) ensureGitignore(cwd); // what SessionStart does — keeps git add/reset off the state dir
  const write = (rel, content) => {
    const f = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content, 'utf8');
    return appendEntry(paths, 'e', { kind: 'file_write', session_id: SID, tool_name: 'Write', file_path: rel.replaceAll('\\', '/'), bytes: content.length });
  };
  const run = (command, exit, opts = {}) => appendEntry(paths, 'e', {
    kind: 'command', session_id: SID, command,
    background: opts.background === true, exit_code: exit,
    exit_source: exit === null ? 'unknown' : 'harness_event',
    matched_runner: opts.runner ?? null, ...(opts.watch ? { watch: true } : {}),
  });
  const contract = (items, { confession = '', extraHeader = '' } = {}) => {
    fs.writeFileSync(paths.contract, `# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:${SID} created:t baseline:${baseline}${extraHeader} -->

## Sources
- P1 (t): ask → .polygraph/prompts/P1.txt

## Requirements
${items.join('\n')}
${confession}`, 'utf8');
  };
  const gate = (over = {}) => evaluateGate({
    cwd, paths, config: { ...DEFAULT_CONFIG, ...over.config }, sessionId: SID,
    stopHookActive: over.stopHookActive ?? false, dryRun: over.dryRun ?? false,
  });
  return { cwd, paths, g, write, run, contract, gate, baseline: () => baseline, git: g };
}

// ---- happy paths -------------------------------------------------------------

test('honest completion: diff evidence + git corroboration ⇒ PASS', () => {
  const w = world();
  const e = w.write('src/auth.ts', 'export const x = 1;');
  w.contract([`- [x] R1: add auth module (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  const r = w.gate();
  assert.equal(r.decision, 'pass', JSON.stringify(r.failedIds));
  assert.equal(r.items[0].status, '✅');
});

test('advisory: no contract ⇒ never blocks, observes only (§15.8)', () => {
  const w = world();
  assert.equal(w.gate().decision, 'advisory');
});

test('mode off short-circuits everything', () => {
  const w = world();
  assert.equal(w.gate({ config: { mode: 'off' } }).decision, 'off');
});

// ---- the three target lies (§2.1) ---------------------------------------------

test('LIE untouched file: pointer exists but file not in changed set ⇒ BLOCK citing path', () => {
  const w = world();
  const e = w.write('src/auth.ts', 'x');
  fs.rmSync(path.join(w.cwd, 'src/auth.ts')); // reverted — no diff remains
  w.contract([`- [x] R1: add auth (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  const r = w.gate();
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /claimed file has no diff: src\/auth\.ts/);
});

test('LIE stale test pass: source edited after green run ⇒ BLOCK C4 citing staleness', () => {
  const w = world();
  const e1 = w.write('src/a.ts', 'v1');
  w.run('npx vitest run', 0, { runner: 'npm' });
  const e2 = w.write('src/a.ts', 'v2'); // invalidates the green run
  w.contract([
    `- [x] R1: change a (source: P1) [evidence: diff] → evidence: ${e2.id}`,
  ]);
  const r = w.gate({ config: { require_tests: 'always' } });
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /no test run after last source write .* is stale/);
  void e1;
});

test('LIE dropped requirement: open item ⇒ BLOCK citing the R-id', () => {
  const w = world();
  w.contract(['- [ ] R3: rename call sites (source: P1) [evidence: diff]']);
  const r = w.gate();
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /R3/);
});

// ---- C3 per-type table (A4) -----------------------------------------------------

test('unproven check-off (no pointer) blocks — and the reason lists citable ids', () => {
  const w = world();
  const e = w.write('src/real-work.ts', 'x');
  w.contract(['- [x] R1: did stuff (source: P1) [evidence: diff]']);
  const reason = w.gate().reason;
  assert.match(reason, /unproven check-off/);
  assert.match(reason, new RegExp(`Recorded evidence you can cite: .*${e.id}=write src/real-work\\.ts`));
});

test('nonexistent pointer blocks', () => {
  const w = world();
  w.contract(['- [x] R1: did stuff (source: P1) [evidence: diff] → evidence: E999']);
  assert.match(w.gate().reason, /nonexistent evidence E999/);
});

test('diff item done via Bash gets the redo-or-confess hint (never "retag" — C2b trap)', () => {
  const w = world();
  const e = w.run('npx prettier --write src/', 0);
  fs.writeFileSync(path.join(w.cwd, 'src.formatted'), 'x');
  w.contract([`- [x] R1: format code (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  const r = w.gate();
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /redo it via Edit\/Write to earn diff evidence, or confess/);
  assert.match(r.reason, /Do NOT edit the item's \[evidence:\] tag/);
  assert.ok(!/retag as/.test(r.reason), 'the C2b-trap advice must be gone');
});

test('formatter via Bash tagged [evidence: cmd] passes (teach-don’t-relax)', () => {
  const w = world();
  const e = w.run('npx prettier --write src/', 0);
  w.contract([`- [x] R1: format code (source: P1) [evidence: cmd] → evidence: ${e.id}`]);
  assert.equal(w.gate().decision, 'pass');
});

test('fabricated cmd pointer (background / unknown / nonzero) blocks', () => {
  const w = world();
  const bg = w.run('migrate.sh', 0, { background: true });
  const unk = w.run('opaque', null);
  const red = w.run('migrate.sh', 1);
  for (const e of [bg, unk, red]) {
    w.contract([`- [x] R1: run migration (source: P1) [evidence: cmd] → evidence: ${e.id}`]);
    fs.rmSync(w.paths.shadow, { force: true }); // isolate C2b across variants
    const r = w.gate();
    assert.equal(r.decision, 'block', `expected block for ${JSON.stringify(e)}`);
    assert.match(r.reason, /verifiably succeed/);
  }
});

test('∃-semantics: red run + later green run BOTH cited ⇒ pass (honest retry workflow)', () => {
  const w = world();
  const red = w.run('pytest -q', 1, { runner: 'pytest' });
  const green = w.run('pytest -q', 0, { runner: 'pytest' });
  w.contract([`- [x] R1: tests green (source: P1) [evidence: test] → evidence: ${red.id},${green.id}`]);
  assert.equal(w.gate({ config: { require_tests: 'never' } }).decision, 'pass',
    'appending the fresh green pointer next to the old red one must not block');

  const failedCmd = w.run('migrate.sh', 1);
  const okCmd = w.run('migrate.sh', 0);
  w.contract([`- [x] R1: run migration (source: P1) [evidence: cmd] → evidence: ${failedCmd.id},${okCmd.id}`]);
  fs.rmSync(w.paths.shadow, { force: true });
  assert.equal(w.gate({ config: { require_tests: 'never' } }).decision, 'pass');
});

test('C4 latest-wins: a runner tool_fail with UNPARSEABLE exit supersedes an earlier green (§12.2)', () => {
  const w = world();
  w.write('src/a.ts', 'v1');
  w.run('npx vitest run', 0, { runner: 'npm' }); // green
  appendEntry(w.paths, 'e', { // timed-out run: harness failure, no parseable code
    kind: 'tool_fail', session_id: SID, tool_name: 'Bash', command: 'npx vitest run',
    matched_runner: 'npm', exit_code: null, exit_source: 'unknown', error_excerpt: 'Command timed out',
  });
  const e = w.write('src/b.ts', 'x'); // ensure C4 required
  w.run('sleep 1', 0); // non-runner noise
  w.contract([`- [x] R1: work (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  const r = w.gate({ config: { require_tests: 'always' } });
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /latest test run .* (no verifiable outcome|failed)/);
});

test('tamper is case-insensitive: .Polygraph/ledger.jsonl write blocks (NFR-C3)', () => {
  const w = world();
  const e = w.write('src/a.ts', 'x');
  appendEntry(w.paths, 'e', { kind: 'file_write', session_id: SID, tool_name: 'Write', file_path: '.Polygraph/ledger.jsonl', bytes: 5 });
  w.contract([`- [x] R1: work (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  const r = w.gate();
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /tamper/);
  // and the case-variant of the model-owned contract stays exempt
  const w2 = world();
  const e2 = w2.write('src/a.ts', 'x');
  appendEntry(w2.paths, 'e', { kind: 'file_write', session_id: SID, tool_name: 'Edit', file_path: './.POLYGRAPH/POLYGRAPH.md', bytes: 5 });
  w2.contract([`- [x] R1: work (source: P1) [evidence: diff] → evidence: ${e2.id}`]);
  assert.equal(w2.gate().decision, 'pass');
});

test('C2b-reworded item renders ❌, never ✅ under a blocked id (FR-4.4)', () => {
  const w = world();
  const e = w.write('src/a.ts', 'x');
  w.contract([`- [x] R1: original text (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  w.gate(); // bless
  w.contract([`- [x] R1: reworded text (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  const r = w.gate();
  assert.equal(r.decision, 'block');
  const row = r.items.find((i) => i.id === 'R1');
  assert.equal(row.status, '❌');
  assert.match(row.evidence, /contract tampered: reworded/);
});

test('cross-session stale direction: B edits source after A\'s green run ⇒ C4 blocks (A2 §19)', () => {
  const w = world();
  w.write('src/a.ts', 'v1');
  const green = appendEntry(w.paths, 'e', {
    kind: 'command', session_id: 'session_A', command: 'npx vitest run',
    background: false, exit_code: 0, exit_source: 'harness_event', matched_runner: 'npm',
  });
  const later = w.write('src/a.ts', 'v2'); // session s_gate = "B", after A's green
  w.contract([`- [x] R1: change a (source: P1) [evidence: diff] → evidence: ${later.id}`]);
  const r = w.gate({ config: { require_tests: 'always' } });
  assert.equal(r.decision, 'block');
  assert.match(r.reason, new RegExp(`last green run ${green.id} is stale`));
});

test('fresh repo with ZERO commits: baseline none ⇒ git n/a, ledger evidence passes (A1 §19)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-test-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd });
  const paths = ensureStateDir(cwd);
  ensureGitignore(cwd);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'x');
  const e = appendEntry(paths, 'e', { kind: 'file_write', session_id: SID, tool_name: 'Write', file_path: 'a.txt', bytes: 1 });
  fs.writeFileSync(paths.contract, `# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:${SID} created:t baseline:none -->

## Sources
- P1 (t): ask → .polygraph/prompts/P1.txt

## Requirements
- [x] R1: create a (source: P1) [evidence: diff] → evidence: ${e.id}
`);
  const r = evaluateGate({ cwd, paths, config: { ...DEFAULT_CONFIG }, sessionId: SID });
  assert.equal(r.decision, 'pass');
  assert.equal(r.git.corroboration, false);
});

test('test-tagged item: per-item stale predicate is load-bearing when C4 is n/a (A4)', () => {
  const w = world();
  const run = w.run('pytest -q', 0, { runner: 'pytest' });
  w.write('src/a.py', 'changed after green');
  w.contract([`- [x] R1: regression test green (source: P1) [evidence: test] → evidence: ${run.id}`]);
  const r = w.gate({ config: { require_tests: 'never' } }); // C4 disabled
  assert.equal(r.checks.C4.status, 'na');
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /stale/);
  assert.equal(r.items[0].status, '🕒');
});

test('manual items never block, in any mode, and the PASS banner carries the asterisk', () => {
  const w = world();
  const e = w.write('src/ui.tsx', 'x');
  w.contract([
    `- [x] R1: build UI (source: P1) [evidence: diff] → evidence: ${e.id}`,
    '- [x] R2: looks right on mobile (source: P1) [evidence: manual]',
  ]);
  // strict additionally needs a C5 verdict for the diff item (M3) — manual
  // items themselves stay outside C5 in every mode
  fs.writeFileSync(w.paths.verdicts, JSON.stringify({ v: 1, verdicts: [
    { item: 'R1', verdict: 'met', rationale: 'ok', ts: '2099-01-01T00:00:00Z' },
  ] }), 'utf8');
  for (const mode of ['standard', 'strict', 'confess']) {
    fs.rmSync(w.paths.shadow, { force: true });
    const r = w.gate({ config: { mode } });
    assert.equal(r.decision, 'pass', `mode ${mode}: ${JSON.stringify(r.failedIds)}`);
    assert.equal(r.counts.manual, 1);
    assert.match(verdictLine(r), /PASSED \(1 manual unverified\)/);
  }
});

// ---- C2 / C2b ---------------------------------------------------------------------

test('[~] without (user: P<n>) blocks; with it, passes as deferred', () => {
  const w = world();
  w.contract(['- [~] R1: docs (source: P1) [evidence: diff] — deferred']);
  assert.equal(w.gate().decision, 'block');
  w.contract(['- [~] R1: docs (source: P1) [evidence: diff] — deferred (user: P1)']);
  fs.rmSync(w.paths.shadow, { force: true });
  assert.equal(w.gate().decision, 'pass');
});

test('[?] is a warning in standard, open in strict', () => {
  const w = world();
  w.contract(['- [?] R1: make it better (source: P1) [evidence: manual] — needs clarification']);
  assert.equal(w.gate().decision, 'pass');
  fs.rmSync(w.paths.shadow, { force: true });
  assert.equal(w.gate({ config: { mode: 'strict' } }).decision, 'block');
});

test('C2b: deleting a requirement blocks with the supersession lesson', () => {
  const w = world();
  const e = w.write('src/a.ts', 'x');
  w.contract([
    `- [x] R1: part one (source: P1) [evidence: diff] → evidence: ${e.id}`,
    '- [ ] R2: part two (source: P1) [evidence: diff]',
  ]);
  w.gate(); // blesses R1+R2 (and blocks on open R2 — irrelevant here)
  w.contract([`- [x] R1: part one (source: P1) [evidence: diff] → evidence: ${e.id}`]); // R2 vanished
  const r = w.gate();
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /C2b contract-monotonicity: R2 removed/);
  assert.match(r.reason, /supersede it/);
});

// ---- tamper (A3) ---------------------------------------------------------------------

test('model Edit on engine-owned state ⇒ tamper block; POLYGRAPH.md is exempt', () => {
  const w = world();
  const e = w.write('src/a.ts', 'x');
  appendEntry(w.paths, 'e', { kind: 'file_write', session_id: SID, tool_name: 'Edit', file_path: '.polygraph/POLYGRAPH.md', bytes: 10 });
  w.contract([`- [x] R1: work (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  assert.equal(w.gate().decision, 'pass', 'contract writes are model-owned');

  appendEntry(w.paths, 'e', { kind: 'file_write', session_id: SID, tool_name: 'Edit', file_path: '.polygraph/ledger.jsonl', bytes: 10 });
  fs.rmSync(w.paths.shadow, { force: true });
  const r = w.gate();
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /tamper/);
});

test('config.json tamper block names the sanctioned paths', () => {
  const w = world();
  const e = w.write('src/a.ts', 'x');
  appendEntry(w.paths, 'e', { kind: 'file_write', session_id: SID, tool_name: 'Write', file_path: '.polygraph/config.json', bytes: 10 });
  w.contract([`- [x] R1: work (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  const r = w.gate();
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /ask the user to edit \.polygraph\/config\.json or run \/polygraph:mode/);
});

// ---- confession & loop guard (FR-3.7 / FR-3.1) ------------------------------------------

test('confession superset ⇒ stop allowed regardless of failures; under-confession still blocks', () => {
  const w = world();
  w.contract(
    ['- [ ] R1: a (source: P1) [evidence: diff]', '- [ ] R2: b (source: P1) [evidence: diff]'],
    { confession: '\n## POLYGRAPH CONFESSION\nstatus: incomplete\nunmet: R1, R2, C4, TAMPER\nnote: honest\n' }
  );
  assert.equal(w.gate().decision, 'confess-accepted');

  w.contract(
    ['- [ ] R1: a (source: P1) [evidence: diff]', '- [ ] R2: b (source: P1) [evidence: diff]'],
    { confession: '\n## POLYGRAPH CONFESSION\nstatus: incomplete\nunmet: R1\nnote: partial\n' }
  );
  const r = w.gate();
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /under-confesses.*R2/);
});

test('loop guard: budget exhausted ⇒ nudge once, then warned allow — never a 3rd block', () => {
  const w = world();
  w.contract(['- [ ] R1: a (source: P1) [evidence: diff]']);
  updateSessionState(w.cwd, SID, { block_count: 2 }); // budget (max_blocks=2) spent
  const first = w.gate({ stopHookActive: true });
  assert.equal(first.decision, 'confess-nudge');
  updateSessionState(w.cwd, SID, { confess_nudged: true });
  const second = w.gate({ stopHookActive: true });
  assert.equal(second.decision, 'confess-allow');
});

test('confess mode never emits a block across failures', () => {
  const w = world();
  w.contract(['- [ ] R1: a (source: P1) [evidence: diff]']);
  const first = w.gate({ config: { mode: 'confess' } });
  assert.equal(first.decision, 'confess-nudge');
  updateSessionState(w.cwd, SID, { confess_nudged: true });
  assert.equal(w.gate({ config: { mode: 'confess' } }).decision, 'confess-allow');
});

// ---- A1 baseline behaviors --------------------------------------------------------------

test('mid-session commit: committed work still verifies (baseline anchor)', () => {
  const w = world();
  const e = w.write('src/auth.ts', 'x');
  w.git('add', '.'); w.git('commit', '-qm', 'work committed mid-session');
  w.contract([`- [x] R1: add auth (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  const r = w.gate();
  assert.equal(r.decision, 'pass', 'diff HEAD would be empty here — baseline anchor must save it');
});

test('honest new untracked file passes (?? paths in changed set)', () => {
  const w = world();
  const e = w.write('brand-new.txt', 'x'); // never staged
  w.contract([`- [x] R1: create file (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  assert.equal(w.gate().decision, 'pass');
});

test('rebase/reset below baseline ⇒ git n/a, ledger evidence still required and sufficient', () => {
  const w = world();
  const e = w.write('src/a.ts', 'x');
  w.git('add', '.'); w.git('commit', '-qm', 'c2');
  const c2 = w.git('rev-parse', 'HEAD');
  w.contract([`- [x] R1: work (source: P1) [evidence: diff] → evidence: ${e.id}`], { });
  // rewrite contract header to use c2 as baseline, then reset below it
  const text = fs.readFileSync(w.paths.contract, 'utf8').replace(/baseline:\S+/, `baseline:${c2}`);
  fs.writeFileSync(w.paths.contract, text);
  w.git('reset', '-q', '--hard', w.baseline());
  const r = w.gate();
  assert.equal(r.git.corroboration, false);
  assert.equal(r.decision, 'pass', 'file_write evidence suffices when git is n/a — never a block on baseline loss');
});

test('no git repo at all: diff items pass on ledger evidence, receipts say n/a', () => {
  const w = world({ git: false });
  const e = w.write('src/a.ts', 'x');
  w.contract([`- [x] R1: work (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  const r = w.gate();
  assert.equal(r.decision, 'pass');
  assert.match(r.git.summary, /n\/a/);
});

// ---- C5 verifier-verdicts (M3, §11/A4) ---------------------------------------------------

function writeVerdicts(w, verdicts) {
  fs.writeFileSync(w.paths.verdicts, JSON.stringify({ v: 1, session_id: SID, verdicts }), 'utf8');
}
const ts = (h) => `2099-01-01T${String(h).padStart(2, '0')}:00:00Z`; // far future = fresh vs any write

test('strict: [x] diff item without a verdict blocks and names the verifier + items', () => {
  const w = world();
  const e = w.write('src/a.ts', 'x');
  w.contract([`- [x] R1: work (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  const r = w.gate({ config: { mode: 'strict' } });
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /FAILED C5.*R1 needs a fresh verifier verdict/s);
  assert.match(r.reason, /Run the polygraph-verifier subagent on: R1/);
});

test('strict: fresh met verdict passes and receipts show ✔verifier', () => {
  const w = world();
  const e = w.write('src/a.ts', 'x');
  w.contract([`- [x] R1: work (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  writeVerdicts(w, [{ item: 'R1', verdict: 'met', rationale: 'checked', ts: ts(1) }]);
  const r = w.gate({ config: { mode: 'strict' } });
  assert.equal(r.decision, 'pass', JSON.stringify(r.failedIds));
  assert.match(r.items[0].evidence, /✔verifier/);
});

test('a fresh UNMET verdict blocks in ANY mode (never ignored) with the rationale quoted', () => {
  const w = world();
  const e = w.write('src/a.ts', 'x');
  w.contract([`- [x] R1: rename all call sites (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  writeVerdicts(w, [{ item: 'R1', verdict: 'unmet', rationale: 'worker.ts still calls oldName()', ts: ts(1) }]);
  const r = w.gate(); // standard
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /UNMET: worker\.ts still calls oldName/);
  assert.equal(r.items[0].status, '❌');
});

test('unclear verdict: warning in standard, open in strict (mirrors [?])', () => {
  const w = world();
  const e = w.write('src/a.ts', 'x');
  w.contract([`- [x] R1: improve perf (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  writeVerdicts(w, [{ item: 'R1', verdict: 'unclear', rationale: 'no measurable criterion', ts: ts(1) }]);
  const std = w.gate();
  assert.equal(std.decision, 'pass');
  // the row must NOT read verified ✅ — an unclear verdict is a warning glyph
  assert.equal(std.items[0].status, '❓', 'unclear verdict renders ❓, never ✅ (no laundering)');
  fs.rmSync(w.paths.shadow, { force: true });
  assert.equal(w.gate({ config: { mode: 'strict' } }).decision, 'block');
});

test('stale verdict (edit after verdict ts) is not trusted — strict requires a fresh one', () => {
  const w = world();
  w.contract(['- [ ] R1: placeholder so shadow blesses (source: P1) [evidence: manual]']);
  writeVerdicts(w, [{ item: 'R1', verdict: 'met', rationale: 'was fine', ts: '2000-01-01T00:00:00Z' }]);
  const e = w.write('src/a.ts', 'v2'); // AFTER the verdict
  w.contract([`- [x] R1: placeholder so shadow blesses (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  fs.rmSync(w.paths.shadow, { force: true });
  const r = w.gate({ config: { mode: 'strict' } });
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /existing verdict is stale/);
});

test('verifier_max_items cap: beyond it items render ⚠ unverified, never a block (§11.1)', () => {
  const w = world();
  const e1 = w.write('src/a.ts', 'x');
  const e2 = w.write('src/b.ts', 'y');
  w.contract([
    `- [x] R1: part a (source: P1) [evidence: diff] → evidence: ${e1.id}`,
    `- [x] R2: part b (source: P1) [evidence: diff] → evidence: ${e2.id}`,
  ]);
  const r = w.gate({ config: { mode: 'strict', verifier_max_items: 1 } });
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.needsVerifier, ['R1'], 'only the capped head is demanded');
  assert.equal(r.items[1].status, '⚠');
  assert.match(r.items[1].evidence, /over verifier cap/);
});

// ---- gate-authored repair: syntax-and-restoration only, never semantics -----------------

test('C1-repair: canary-style mangled lines are re-serialized with markers/pointers preserved', () => {
  const w = world();
  const e = w.write('src/a.ts', 'x');
  fs.writeFileSync(w.paths.contract, `# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:${SID} created:t baseline:none -->

## Sources
- P1 (t): ask → .polygraph/prompts/P1.txt

## Requirements
- [x] R1: Create greet.js file (source: P1) → evidence: ${e.id}
- [ ] R2: Verify with node command
`, 'utf8');
  const r = w.gate();
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /REPAIR — copy these exact lines/);
  assert.match(r.reason, new RegExp(`- \\[x\\] R1: Create greet\\.js file \\(source: P1\\) \\[evidence: diff\\|test\\|cmd\\|manual\\] → evidence: ${e.id}`), 'marker+pointer preserved, type left as a choice slot');
  assert.match(r.reason, /- \[ \] R2: Verify with node command \(source: P1\) \[evidence: diff\|test\|cmd\|manual\]/, 'single-source fill is deterministic');
});

test('C1-repair reconstructs a lost header + Sources from the ledger (canary #3 pattern)', () => {
  const w = world();
  appendEntry(w.paths, null, { kind: 'baseline', session_id: SID, sha: w.baseline() });
  appendEntry(w.paths, null, { kind: 'prompt', id: 'P1', session_id: SID, sha256: 'x', chars: 20, excerpt: 'add a rate limiter to the api' });
  const e = w.write('src/a.ts', 'x');
  fs.writeFileSync(w.paths.contract, `<!-- polygraph:v1 -->
# POLYGRAPH CONTRACT

## Requirements
- [x] R1: add limiter (source: P1) [evidence: diff] → evidence: ${e.id}
`, 'utf8');
  const r = w.gate();
  assert.equal(r.decision, 'block');
  assert.match(r.reason, new RegExp(`<!-- polygraph:v1 session:${SID} created:\\S+ baseline:${w.baseline()} -->`), 'header rebuilt from the ledger baseline entry');
  assert.match(r.reason, /## Sources\n- P1 \(.*\): add a rate limiter to the api → \.polygraph\/prompts\/P1\.txt/, 'Sources rebuilt from prompt snapshots');
});

test('C2b-repair: the blessed original line is emitted VERBATIM for restoration; restoring passes', () => {
  const w = world();
  const e = w.write('src/a.ts', 'x');
  const original = `- [x] R1: original wording (source: P1) [evidence: diff] → evidence: ${e.id}`;
  w.contract([original]);
  assert.equal(w.gate().decision, 'pass'); // blesses v2 shadow with the line
  w.contract([`- [x] R1: reworded wording (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  const r = w.gate();
  assert.equal(r.decision, 'block');
  assert.ok(r.reason.includes(original), 'blessed line verbatim in the repair block');
  w.contract([original]); // model copies it back
  assert.equal(w.gate().decision, 'pass');
});

test('no laundering: a repaired [x] without pointers still fails C3 after the copy', () => {
  const w = world();
  fs.writeFileSync(w.paths.contract, `# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:${SID} created:t baseline:none -->

## Sources
- P1 (t): ask → .polygraph/prompts/P1.txt

## Requirements
- [x] R1: did stuff with no proof at all
`, 'utf8');
  const first = w.gate();
  assert.equal(first.decision, 'block');
  const repaired = /(- \[x\] R1: did stuff with no proof at all \(source: P1\) \[evidence: [^\]]+\])/.exec(first.reason)?.[1];
  assert.ok(repaired, 'repair offered');
  // model copies the repair, choosing 'diff' for the type slot
  w.contract([repaired.replace('diff|test|cmd|manual', 'diff')]);
  const second = w.gate();
  assert.equal(second.decision, 'block', 'grammar fixed, truth still enforced');
  assert.match(second.reason, /unproven check-off/);
});

test('reason cap: ≤1500 chars plain, ≤2250 with a repair block (FR-3.6 amended)', () => {
  const w = world();
  const mangled = Array.from({ length: 8 }, (_, i) => `- [ ] R${i + 1}: ${'very long requirement text '.repeat(6)}${i}`);
  fs.writeFileSync(w.paths.contract, `# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:${SID} created:t baseline:none -->

## Sources
- P1 (t): ask → .polygraph/prompts/P1.txt

## Requirements
${mangled.join('\n')}
`, 'utf8');
  const r = w.gate();
  assert.equal(r.decision, 'block');
  assert.ok(r.reason.length <= 2250, `repair reason ${r.reason.length} > 2250`);
});

// ---- misc guarantees ------------------------------------------------------------------

test('deterministic replay (NFR-R3): same state ⇒ identical decision object', () => {
  const w = world();
  const e = w.write('src/a.ts', 'x');
  w.contract([`- [x] R1: work (source: P1) [evidence: diff] → evidence: ${e.id}`]);
  const a = w.gate({ dryRun: true });
  const b = w.gate({ dryRun: true });
  assert.deepEqual(
    { d: a.decision, f: a.failedIds, s: a.items.map((i) => i.status) },
    { d: b.decision, f: b.failedIds, s: b.items.map((i) => i.status) }
  );
});

test('unparseable contract ⇒ C1 fail ⇒ block (malformed must not silently pass)', () => {
  const w = world();
  fs.writeFileSync(w.paths.contract, '# POLYGRAPH CONTRACT\nno header here\n## Requirements\n- [x] R1 broken line\n');
  const r = w.gate();
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /C1 contract-parse/);
});
