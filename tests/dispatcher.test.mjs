// Integration: spawn the real dispatcher exactly as Claude Code hooks do —
// `node polygraph.mjs <event>` with the payload on stdin. This is the
// process-level contract; unit tests cover the libs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'polygraph.mjs');
const SID = 's_test1';

function sandbox(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function runHook(payload, cwd) {
  const res = spawnSync(process.execPath, [SCRIPT, payload.hook_event_name || ''], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function ledgerEntries(dir) {
  const file = path.join(dir, '.polygraph', 'ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const base = (dir, extra) => ({ session_id: SID, cwd: dir, permission_mode: 'default', ...extra });

test('scripted session produces the expected ledger (M0 golden path)', () => {
  const dir = sandbox({
    'package.json': '{"scripts":{"test":"vitest run"}}',
    'pytest.ini': '',
  });
  fs.mkdirSync(path.join(dir, '.git')); // fake repo → gitignore handling active

  const steps = [
    base(dir, { hook_event_name: 'SessionStart', source: 'startup' }),
    base(dir, {
      hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'toolu_1',
      tool_input: { file_path: path.join(dir, 'src', 'auth.ts'), content: 'export const x = 1;\n' },
      tool_response: {},
    }),
    base(dir, {
      hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'toolu_2',
      tool_input: { file_path: path.join(dir, 'src', 'auth.ts'), old_string: 'x', new_string: 'xy' },
      tool_response: {},
    }),
    base(dir, {
      // observed 2.1.59 success shape: NO exit-code field (live probe)
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_3',
      tool_input: { command: 'npx vitest run', description: 'Run tests' },
      tool_response: { stdout: '4 passed', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
    }),
    base(dir, {
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_4',
      tool_input: { command: 'some-opaque-tool', run_in_background: true },
      tool_response: { blob: 'no code here' },
    }),
    base(dir, {
      // observed failure channel: error text leads "Exit code N"
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_5',
      tool_input: { command: 'pytest -q' },
      error: 'Exit code 1\n2 failed, 14 passed\n\n2 failed, 14 passed',
      is_interrupt: false,
    }),
  ];
  for (const step of steps) {
    const { status, stdout } = runHook(step, dir);
    assert.equal(status, 0, `hook must exit 0 (${step.hook_event_name})`);
    assert.equal(stdout, '', `ledger hooks are silent (FR-2.9): ${stdout}`);
  }

  const entries = ledgerEntries(dir);
  assert.equal(entries.length, 6);

  assert.equal(entries[0].kind, 'session_start');
  assert.equal(entries[0].source, 'startup');
  assert.equal(entries[0].id, undefined);

  assert.deepEqual(
    entries.slice(1).map((e) => [e.id, e.kind]),
    [['E1', 'file_write'], ['E2', 'file_write'], ['E3', 'command'], ['E4', 'command'], ['E5', 'tool_fail']]
  );

  const [w1, w2, green, opaque, fail] = entries.slice(1);
  assert.equal(w1.file_path, 'src/auth.ts'); // absolute → repo-relative, forward slashes
  assert.equal(w1.bytes, 20);
  assert.equal(w2.tool_name, 'Edit');
  assert.equal(w2.bytes, 2);

  assert.equal(green.command, 'npx vitest run');
  assert.equal(green.exit_code, 0);
  assert.equal(green.exit_source, 'harness_event'); // no exit field on 2.1.59 — event channel is ground truth
  assert.equal(green.matched_runner, 'npm');
  assert.equal(green.background, false);

  assert.equal(opaque.exit_code, null); // FR-2.6: unknown ≠ pass
  assert.equal(opaque.exit_source, 'unknown');
  assert.equal(opaque.background, true);
  assert.equal(opaque.matched_runner, null);

  assert.equal(fail.kind, 'tool_fail');
  assert.equal(fail.matched_runner, 'pytest');
  assert.equal(fail.exit_code, 1); // real code parsed from the failure channel
  assert.equal(fail.exit_source, 'failure_text');
  assert.match(fail.error_excerpt, /2 failed/);

  // shape probe captured on first Bash event (FR-2.5)
  const probe = JSON.parse(fs.readFileSync(path.join(dir, '.polygraph', 'debug', 'tool_response_shape.json'), 'utf8'));
  assert.deepEqual(probe.tool_response_shape, {
    stdout: 'string(8)', stderr: 'string(0)', interrupted: 'boolean', isImage: 'boolean', noOutputExpected: 'boolean',
  });

  // .gitignore negation block (FR-0.2): .polygraph/* + !config.json
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(gi, /\.polygraph\/\*/);
  assert.match(gi, /!\.polygraph\/config\.json/);

  // session runtime state keyed by session id; harness_event is not a
  // parse strategy and must not be cached
  const sess = JSON.parse(fs.readFileSync(path.join(dir, '.polygraph', 'session.json'), 'utf8'));
  assert.deepEqual(sess.sessions[SID].runners.sort(), ['npm', 'pytest']);
  assert.equal(sess.sessions[SID].exit_code_strategy, undefined);
});

test('unparseable stdin → exit 0 with systemMessage, never a crash (FR-0.4)', () => {
  const dir = sandbox();
  for (const bad of ['{{{not json', 'null', '42', '[]', '']) {
    const res = spawnSync(process.execPath, [SCRIPT, 'PostToolUse'], {
      input: bad, cwd: dir, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(res.status, 0, `exit 0 for stdin ${JSON.stringify(bad)}`);
    const out = JSON.parse(res.stdout);
    assert.match(out.systemMessage, /polygraph: internal error/);
  }
});

test('mode off in config.json → total no-op, no state writes (§13.1)', () => {
  const dir = sandbox({ '.polygraph/config.json': '{"v":1,"mode":"off"}' });
  const { status, stdout } = runHook(base(dir, {
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't',
    tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 },
  }), dir);
  assert.equal(status, 0);
  assert.equal(stdout, '');
  assert.equal(ledgerEntries(dir).length, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.polygraph', 'session.json')));
});

test('a throw INSIDE the gate degrades loudly — FR-0.4 "gate skipped", never the ✓ banner', () => {
  // The dispatcher-level catch is the last line of the M3=0% guarantee: even
  // a future total-function audit miss (any uncaught throw in evaluateGate/
  // onStop) must surface as an internal-error systemMessage, NEVER a clean
  // pass. Force a throw AFTER a would-be PASS: receipt.md is a directory, so
  // writeReceipt() throws mid-onStop with the pass decision already computed.
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, '.polygraph'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.polygraph', 'receipt.md')); // rename onto a dir → EPERM/EISDIR
  fs.writeFileSync(path.join(dir, '.polygraph', 'POLYGRAPH.md'), `# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:${SID} created:t baseline:none -->

## Sources
- P1 (t): x → .polygraph/prompts/P1.txt

## Requirements
- [x] R1: work (source: P1) [evidence: manual]
`);
  const res = runHook(base(dir, { hook_event_name: 'Stop', stop_hook_active: false }), dir);
  assert.equal(res.status, 0, 'exit 0 (fail-open, never exit 2)');
  const out = JSON.parse(res.stdout);
  assert.match(out.systemMessage, /polygraph: internal error — gate skipped \(/, 'loud degradation with cause');
  assert.ok(!/✓ polygraph/.test(out.systemMessage), 'NEVER the pass banner');
  assert.equal(out.decision, undefined, 'never a block either — just an honest skip');
});

test('Stop and UserPromptSubmit are safe no-ops at M0', () => {
  const dir = sandbox();
  for (const event of ['Stop', 'UserPromptSubmit']) {
    const { status, stdout } = runHook(base(dir, { hook_event_name: event, prompt: 'x', stop_hook_active: false }), dir);
    assert.equal(status, 0);
    assert.equal(stdout, '');
  }
});

test('non-git project: no .gitignore is created', () => {
  const dir = sandbox();
  runHook(base(dir, { hook_event_name: 'SessionStart', source: 'startup' }), dir);
  assert.ok(!fs.existsSync(path.join(dir, '.gitignore')));
});

// ---- M2: contract capture (FR-1.*) -----------------------------------------

const IMPERATIVE = 'add rate limiting to the API and update the docs accordingly';

test('qualifying prompt: P1 + snapshot + baseline + instruction with exact header', () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, '.git')); // fake repo marker; headSha still null → baseline none
  const { status, stdout } = runHook(base(dir, { hook_event_name: 'UserPromptSubmit', prompt: IMPERATIVE }), dir);
  assert.equal(status, 0);
  const out = JSON.parse(stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(out.suppressOutput, true); // §9.1 normative output field
  assert.match(ctx, /Contract P1 recorded/);
  assert.match(ctx, /<!-- polygraph:v1 session:s_test1 created:\S+ baseline:none -->/);
  assert.equal(fs.readFileSync(path.join(dir, '.polygraph', 'prompts', 'P1.txt'), 'utf8'), IMPERATIVE);
  const kinds = ledgerEntries(dir).map((e) => e.kind);
  assert.ok(kinds.includes('prompt') && kinds.includes('baseline'), `ledger has prompt+baseline: ${kinds}`);
  // FR-1.3 snapshot fields pinned (mutation-survivor finding)
  const pEntry = ledgerEntries(dir).find((e) => e.kind === 'prompt');
  assert.equal(pEntry.chars, IMPERATIVE.length);
  assert.equal(pEntry.excerpt, IMPERATIVE.slice(0, 400));
  assert.match(pEntry.sha256, /^[0-9a-f]{64}$/);
  const sess = JSON.parse(fs.readFileSync(path.join(dir, '.polygraph', 'session.json'), 'utf8'));
  assert.equal(sess.sessions[SID].qualifying_prompts, 1);
});

test('pure question: silent, no P entry, no contract machinery (§15.2)', () => {
  const dir = sandbox();
  const { status, stdout } = runHook(base(dir, {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'what is the difference between a monad and a functor in practice?',
  }), dir);
  assert.equal(status, 0);
  assert.equal(stdout, '');
  assert.ok(!ledgerEntries(dir).some((e) => e.kind === 'prompt'));
});

test('second qualifying prompt: P2 accumulates, no header re-issued', () => {
  const dir = sandbox();
  runHook(base(dir, { hook_event_name: 'UserPromptSubmit', prompt: IMPERATIVE }), dir);
  fs.writeFileSync(path.join(dir, '.polygraph', 'POLYGRAPH.md'), '# POLYGRAPH CONTRACT\n', 'utf8'); // contract now exists
  const out = JSON.parse(runHook(base(dir, {
    hook_event_name: 'UserPromptSubmit', prompt: 'also remove the deprecated v1 endpoints please',
  }), dir).stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Contract P2 recorded/);
  assert.ok(!ctx.includes('polygraph:v1'), 'follow-up carries no header line');
});

test('C1 primal lie: qualifying prompt + NO contract + Stop ⇒ block', () => {
  const dir = sandbox();
  runHook(base(dir, { hook_event_name: 'UserPromptSubmit', prompt: IMPERATIVE }), dir);
  const out = JSON.parse(runHook(base(dir, { hook_event_name: 'Stop', stop_hook_active: false }), dir).stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /no contract despite 1 qualifying prompt/);
});

test('verdict CLI merges per item — sibling verdicts survive (M3 live-canary fix)', () => {
  const dir = sandbox();
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, 'verdict', ...args], { cwd: dir, encoding: 'utf8', timeout: 15000 });
  assert.match(run('R1', 'met', 'looks right', 'src/a.ts:1-10').stdout, /verdict recorded — R1 met/);
  assert.match(run('R3', 'unmet', 'call site missed', 'src/b.ts:88').stdout, /R3 unmet/);
  run('R1', 'unclear', 'second thoughts', ''); // re-verdict replaces R1 only
  const data = JSON.parse(fs.readFileSync(path.join(dir, '.polygraph', 'verdicts.json'), 'utf8'));
  const byItem = Object.fromEntries(data.verdicts.map((v) => [v.item, v.verdict]));
  assert.deepEqual(byItem, { R1: 'unclear', R3: 'unmet' }, 'merge preserves siblings, replaces same-item');
  assert.deepEqual(data.verdicts.find((v) => v.item === 'R3').evidence, ['src/b.ts:88']);
  // junk input fails open with usage, never a crash
  assert.match(run('notanid', 'met', 'x').stdout, /usage:/);
});

test('resume reminder lists open contract items (FR-2.10)', () => {
  const dir = sandbox({
    '.polygraph/POLYGRAPH.md': `# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:s_old created:t baseline:none -->

## Sources
- P1 (t): x → .polygraph/prompts/P1.txt

## Requirements
- [ ] R1: finish the thing (source: P1) [evidence: diff]
- [x] R2: done thing (source: P1) [evidence: manual]
- [?] R3: unclear thing (source: P1) [evidence: manual] — needs clarification
`,
  });
  const out = JSON.parse(runHook(base(dir, { hook_event_name: 'SessionStart', source: 'resume' }), dir).stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /open contract: R1 \(open\), R3 \(\[\?\]\)/);
  // fresh startup with the same contract: no reminder noise
  const fresh = runHook(base(dir, { hook_event_name: 'SessionStart', source: 'startup' }), dir);
  assert.equal(fresh.stdout, '');
});
