import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadVerdicts, verdictFresh } from '../scripts/lib/verdicts.mjs';

function file(content) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-test-')), 'verdicts.json');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

test('loads schema-valid verdicts; newest per item wins', () => {
  const p = file(JSON.stringify({ v: 1, verdicts: [
    { item: 'R1', verdict: 'unmet', rationale: 'old', ts: '2026-07-13T10:00:00Z' },
    { item: 'R1', verdict: 'met', rationale: 'new', ts: '2026-07-13T12:00:00Z' },
    { item: 'R2', verdict: 'unclear', ts: '2026-07-13T11:00:00Z' },
  ] }));
  const m = loadVerdicts(p);
  assert.equal(m.get('R1').verdict, 'met');
  assert.equal(m.get('R2').verdict, 'unclear');
});

test('corrupt / misshapen / invalid-value verdicts are never trusted — and NEVER throw', () => {
  // A throw in loadVerdicts would escalate to the dispatcher fail-open catch
  // and skip the whole gate (false-PASS). Totality is load-bearing.
  for (const bad of ['{corrupt', '{"v":1,"verdicts":"nope"}', '{"v":1,"verdicts":{"not":"array"}}',
    '{"verdicts":[null,42,"s"]}', 'not json at all', '{}', 'null', '[]']) {
    let m;
    assert.doesNotThrow(() => { m = loadVerdicts(file(bad)); }, `loadVerdicts must not throw on ${bad}`);
    assert.equal(m.size, 0, `no trusted verdicts from ${bad}`);
  }
  const m = loadVerdicts(file(JSON.stringify({ v: 1, verdicts: [
    { item: 'R1', verdict: 'satisfied', ts: 't' }, // unknown value
    { item: 'R2', verdict: 'met' },                 // missing ts
    'garbage', null,
  ] })));
  assert.equal(m.size, 0);
});

test('freshness: a later file_write on a cited path invalidates the verdict (A2 cross-session)', () => {
  const v = { item: 'R1', verdict: 'met', ts: '2026-07-13T12:00:00Z' };
  const resolved = [{ ptr: 'E1', entry: { kind: 'file_write', file_path: 'src/A.ts' } }];
  const before = [{ kind: 'file_write', file_path: 'src/a.ts', ts: '2026-07-13T11:00:00Z', session_id: 'other' }];
  const after = [{ kind: 'file_write', file_path: 'src/a.ts', ts: '2026-07-13T13:00:00Z', session_id: 'other' }];
  assert.equal(verdictFresh(v, null, resolved, before), true);
  assert.equal(verdictFresh(v, null, resolved, after), false, 'case-insensitive path match, any session');
  assert.equal(verdictFresh(v, null, [{ ptr: 'E2', entry: { kind: 'command', command: 'x' } }], after), true,
    'cmd items have no evidence paths to go stale against');
});
