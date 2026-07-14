import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseContract } from '../scripts/lib/contract.mjs';
import { checkMonotonicity } from '../scripts/lib/shadow.mjs';

const contract = (items) => parseContract(`# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:s created:t baseline:none -->

## Sources
- P1 (t): x → .polygraph/prompts/P1.txt

## Requirements
${items.join('\n')}
`);

const R1 = '- [ ] R1: build the thing (source: P1) [evidence: diff]';
const R1X = '- [x] R1: build the thing (source: P1) [evidence: diff] → evidence: E1';
const R2 = '- [ ] R2: test the thing (source: P1) [evidence: test]';

function shadowPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-test-')), 'contract.shadow.json');
}

test('bootstrap: missing shadow blesses current state without blocking', () => {
  const sp = shadowPath();
  const r = checkMonotonicity(sp, contract([R1]));
  assert.equal(r.status, 'bootstrap');
  assert.ok(fs.existsSync(sp));
});

test('monotonic extension passes and blesses the new item', () => {
  const sp = shadowPath();
  checkMonotonicity(sp, contract([R1]));
  const r = checkMonotonicity(sp, contract([R1, R2]));
  assert.equal(r.status, 'pass');
  const data = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.deepEqual(Object.keys(data.items).sort(), ['R1', 'R2']);
});

test('honest check-off (state flip + evidence append) does not trip the wire', () => {
  const sp = shadowPath();
  checkMonotonicity(sp, contract([R1]));
  assert.equal(checkMonotonicity(sp, contract([R1X])).status, 'pass');
});

test('deleting an item fails, does NOT bless, and restoring it heals', () => {
  const sp = shadowPath();
  checkMonotonicity(sp, contract([R1, R2]));
  const fail = checkMonotonicity(sp, contract([R2]));
  assert.equal(fail.status, 'fail');
  assert.deepEqual(fail.violations, [{ id: 'R1', kind: 'removed' }]);
  // violation persists until restored — and restoring makes the next gate pass
  assert.equal(checkMonotonicity(sp, contract([R2])).status, 'fail');
  assert.equal(checkMonotonicity(sp, contract([R1, R2])).status, 'pass');
});

test('rewording an item fails as reworded', () => {
  const sp = shadowPath();
  checkMonotonicity(sp, contract([R1]));
  const r = checkMonotonicity(sp, contract(['- [ ] R1: build a DIFFERENT thing (source: P1) [evidence: diff]']));
  assert.deepEqual(r.violations, [{ id: 'R1', kind: 'reworded' }]);
});

test('supersession is the legal reword path', () => {
  const sp = shadowPath();
  checkMonotonicity(sp, contract([R1]));
  const superseded = contract([
    '- [~] R1: build the thing (source: P1) [evidence: diff] — deferred (user: P1)',
    '- [ ] R3: build the thing, but better (source: P1) [evidence: diff]',
  ]);
  assert.equal(checkMonotonicity(sp, superseded).status, 'pass');
});

test('removing a source P-id fails (same attack, one field cheaper)', () => {
  const sp = shadowPath();
  checkMonotonicity(sp, contract([R1]));
  const noSources = parseContract(`# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:s created:t baseline:none -->

## Sources

## Requirements
${R1}
`);
  const r = checkMonotonicity(sp, noSources);
  assert.deepEqual(r.violations, [{ id: 'P1', kind: 'source-removed' }]);
});

test('corrupt shadow → n/a (fail-open), never a block, never blessed over', () => {
  const sp = shadowPath();
  fs.writeFileSync(sp, '{corrupt', 'utf8');
  const r = checkMonotonicity(sp, contract([R1]));
  assert.equal(r.status, 'na');
  assert.equal(fs.readFileSync(sp, 'utf8'), '{corrupt');
});

test('items:null / items:[] shadows are corrupt, not a TypeError crash', () => {
  for (const bad of ['{"v":1,"items":null}', '{"v":1,"items":[1]}', '"just a string"']) {
    const sp = shadowPath();
    fs.writeFileSync(sp, bad, 'utf8');
    const r = checkMonotonicity(sp, contract([R1]));
    assert.equal(r.status, 'na', `expected n/a for shadow ${bad}`);
  }
});

test('non-array `sources` is corrupt → na, never a throw and never a fabricated violation (M3 critical)', () => {
  // A throw here would escalate to the dispatcher fail-open catch and skip
  // the whole gate (false-PASS); a char-iterated string would fabricate
  // source-removed violations (false BLOCK). Both must degrade to na.
  for (const bad of ['{"v":2,"items":{},"sources":42}', '{"v":2,"items":{},"sources":"P1"}',
    '{"v":2,"items":{},"sources":true}', '{"v":2,"items":{},"sources":{"P1":1}}']) {
    const sp = shadowPath();
    fs.writeFileSync(sp, bad, 'utf8');
    let r;
    assert.doesNotThrow(() => { r = checkMonotonicity(sp, contract([R1])); }, `shadow ${bad} must not throw`);
    assert.equal(r.status, 'na', `expected na for ${bad}`);
    assert.deepEqual(r.violations, [], 'no fabricated violations');
  }
  // sources absent entirely (bootstrap/legacy) is still fine
  const sp = shadowPath();
  fs.writeFileSync(sp, '{"v":2,"items":{}}', 'utf8');
  assert.equal(checkMonotonicity(sp, contract([R1])).status, 'pass');
});

test('dryRun never blesses (receipts rendering must not mutate trust state)', () => {
  const sp = shadowPath();
  const r = checkMonotonicity(sp, contract([R1]), { dryRun: true });
  assert.equal(r.status, 'bootstrap');
  assert.ok(!fs.existsSync(sp));
});
