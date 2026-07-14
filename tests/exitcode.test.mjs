import test from 'node:test';
import assert from 'node:assert/strict';
import { extractExitCode, deriveBashExit } from '../scripts/lib/exitcode.mjs';

const cases = [
  [{ exit_code: 0 }, 0, 'key:exit_code'],
  [{ exitCode: 2 }, 2, 'key:exitCode'],
  [{ code: 1 }, 1, 'key:code'],
  [{ status: 0 }, 0, 'key:status'],
  [{ result: { exit_code: 137 } }, 137, 'key:exit_code'], // 1-level nested
  [{ exit_code: '3' }, 3, 'key:exit_code'], // numeric string accepted
  [{ stdout: 'blah\nExit code: 4\n' }, 4, 'text'],
  [{ stderr: 'some output\nexited with code 5' }, 5, 'text'], // trailing anchored line
];

for (const [response, expected, strategy] of cases) {
  test(`extracts ${expected} via ${strategy} from ${JSON.stringify(response)}`, () => {
    const r = extractExitCode(response);
    assert.equal(r.exit_code, expected);
    assert.equal(r.exit_source, 'tool_response');
    assert.equal(r.strategy, strategy);
  });
}

test('unknown shape → null + exit_source unknown (FR-2.6: unknown ≠ pass)', () => {
  const r = extractExitCode({ some: 'thing', is_error: false });
  assert.equal(r.exit_code, null);
  assert.equal(r.exit_source, 'unknown');
});

test('is_error:false alone NEVER fabricates exit 0 (M3 guard)', () => {
  const r = extractExitCode({ is_error: false, stdout: 'all good' });
  assert.equal(r.exit_code, null);
  assert.equal(r.exit_source, 'unknown');
});

test('non-integer values are rejected', () => {
  const r = extractExitCode({ exit_code: 'success', code: 1.5, status: true });
  assert.equal(r.exit_code, null);
});

// Anti-fabrication guards on the text heuristic (FR-2.5 trailing line ONLY).
test('incidental "exited with code 0" mid-output NEVER fabricates a pass', () => {
  const r = extractExitCode({ stdout: 'child exited with code 0\n3 tests FAILED\n' });
  assert.equal(r.exit_code, null);
  assert.equal(r.exit_source, 'unknown');
});

test('trailing line with extra prefix words does not match (fully anchored)', () => {
  const r = extractExitCode({ stderr: 'watcher process exited with code 0' });
  assert.equal(r.exit_code, null);
});

test('cached text strategy cannot shadow a real integer field', () => {
  const r = extractExitCode({ exit_code: 1, stdout: 'step exited with code 0' }, 'text');
  assert.equal(r.exit_code, 1);
  assert.equal(r.strategy, 'key:exit_code');
});

test('cached strategy is tried first and reported', () => {
  const r = extractExitCode({ exit_code: 9, code: 7 }, 'key:code');
  assert.equal(r.exit_code, 7);
  assert.equal(r.strategy, 'key:code');
});

test('stale cached strategy falls through to the ladder', () => {
  const r = extractExitCode({ exit_code: 9 }, 'key:code');
  assert.equal(r.exit_code, 9);
  assert.equal(r.strategy, 'key:exit_code');
});

// --- deriveBashExit: the harness-dichotomy strategy (observed 2.1.59) -------

const OBSERVED_SUCCESS = { stdout: 'ok\n', stderr: '', interrupted: false, isImage: false, noOutputExpected: false };

test('PostToolUse with observed success shape → exit 0 via harness_event', () => {
  const r = deriveBashExit({ event: 'PostToolUse', toolResponse: OBSERVED_SUCCESS });
  assert.deepEqual(r, { exit_code: 0, exit_source: 'harness_event', strategy: 'harness_event' });
});

test('PostToolUse interrupted:true NEVER yields 0 (M3 guard)', () => {
  const r = deriveBashExit({ event: 'PostToolUse', toolResponse: { ...OBSERVED_SUCCESS, interrupted: true } });
  assert.equal(r.exit_code, null);
  assert.equal(r.exit_source, 'unknown');
});

test('PostToolUse background command NEVER yields 0 (job ack ≠ completion)', () => {
  const r = deriveBashExit({ event: 'PostToolUse', toolResponse: OBSERVED_SUCCESS, background: true });
  assert.equal(r.exit_code, null);
  assert.equal(r.exit_source, 'unknown');
});

test('PostToolUse with unrecognized shape stays unknown', () => {
  const r = deriveBashExit({ event: 'PostToolUse', toolResponse: { blob: 'x' } });
  assert.equal(r.exit_code, null);
  assert.equal(r.exit_source, 'unknown');
});

test('PostToolUse ladder still wins when an explicit field exists (future-proof)', () => {
  const r = deriveBashExit({ event: 'PostToolUse', toolResponse: { ...OBSERVED_SUCCESS, exit_code: 2 } });
  assert.deepEqual(r, { exit_code: 2, exit_source: 'tool_response', strategy: 'key:exit_code' });
});

test('PostToolUseFailure parses the real code from "Exit code N" error text', () => {
  const r = deriveBashExit({ event: 'PostToolUseFailure', error: 'Exit code 3\nboom-stderr\n\nboom-stderr' });
  assert.deepEqual(r, { exit_code: 3, exit_source: 'failure_text', strategy: 'failure_text' });
});

test('PostToolUseFailure interrupt → unknown, never a code', () => {
  const r = deriveBashExit({ event: 'PostToolUseFailure', error: 'Exit code 130\n', isInterrupt: true });
  assert.equal(r.exit_code, null);
  assert.equal(r.exit_source, 'unknown');
});

test('PostToolUseFailure without the pattern stays unknown', () => {
  const r = deriveBashExit({ event: 'PostToolUseFailure', error: 'command not found: foo' });
  assert.equal(r.exit_code, null);
  assert.equal(r.exit_source, 'unknown');
});

test('"Exit code N" must be the LEADING line — mid-text mentions do not count', () => {
  const r = deriveBashExit({ event: 'PostToolUseFailure', error: 'test log said: Exit code 0 somewhere' });
  assert.equal(r.exit_code, null);
});

test('failure_text anchoring: "Exit code" on a LATER line never counts', () => {
  const r = deriveBashExit({ event: 'PostToolUseFailure', error: 'boom happened\nExit code 3' });
  assert.equal(r.exit_code, null);
  assert.equal(r.exit_source, 'unknown');
});
