import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContract, immutableZone, zoneHash, repairLine } from '../scripts/lib/contract.mjs';

const FULL = `# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:s_9f2 created:2026-07-13T10:00:00Z baseline:a1b2c3d -->

## Sources
- P1 (2026-07-13T10:00:00Z): Add rate limiting…   → .polygraph/prompts/P1.txt
- P2 (2026-07-13T11:00:00Z): also docs…           → .polygraph/prompts/P2.txt

## Requirements
- [ ] R1: Add rate limiting middleware (source: P1) [evidence: diff]
- [x] R2: All tests pass (source: P1) [evidence: test] → evidence: E19
- [~] R3: Update API docs (source: P1) [evidence: diff] — deferred (user: P2)
- [?] R4: Improve performance (source: P2) [evidence: manual] — needs clarification
- [x] R5: Run migration (source: P2) [evidence: cmd] → evidence: E27,E28-x1a2b3c4

## POLYGRAPH CONFESSION
status: incomplete
unmet: R1, C4
note: rate limiter not started
`;

test('parses the full §10.1 grammar', () => {
  const c = parseContract(FULL);
  assert.equal(c.ok, true, c.errors.join('; '));
  assert.deepEqual(c.header, { session: 's_9f2', created: '2026-07-13T10:00:00Z', baseline: 'a1b2c3d' });
  assert.deepEqual(c.sources, ['P1', 'P2']);
  assert.equal(c.items.length, 5);
  assert.deepEqual(c.items.map((i) => i.state), ['open', 'done', 'deferred', 'ambiguous', 'done']);
  assert.deepEqual(c.items[1].pointers, ['E19']);
  assert.deepEqual(c.items[4].pointers, ['E27', 'E28-x1a2b3c4']); // suffixed ids resolve too
  assert.equal(c.items[2].deferredUser, 'P2');
  assert.deepEqual(c.confession, { status: 'incomplete', unmet: ['R1', 'C4'], note: 'rate limiter not started' });
});

test('CRLF contracts parse identically (NFR-C3)', () => {
  const c = parseContract(FULL.replaceAll('\n', '\r\n'));
  assert.equal(c.ok, true);
  assert.equal(c.items.length, 5);
});

test('missing header is a parse error', () => {
  const c = parseContract('## Requirements\n- [ ] R1: x (source: P1) [evidence: diff]\n');
  assert.equal(c.ok, false);
  assert.match(c.errors[0], /header/);
});

test('item-shaped line that does not match the grammar is an error', () => {
  const bad = FULL.replace('- [x] R2: All tests pass (source: P1) [evidence: test] → evidence: E19',
    '- [x] R2: All tests pass [evidence: test]'); // missing (source: Pn)
  const c = parseContract(bad);
  assert.equal(c.ok, false);
  assert.match(c.errors.join(' '), /unparseable requirement/);
});

test('duplicate R-ids are a parse error (ambiguous evidence anchoring)', () => {
  const dup = FULL.replace('R5: Run migration', 'R2: Run migration');
  const c = parseContract(dup);
  assert.equal(c.ok, false);
  assert.match(c.errors.join(' '), /duplicate item id R2/);
});

test('confession without status incomplete is an error', () => {
  const c = parseContract(FULL.replace('status: incomplete', 'status: done'));
  assert.equal(c.ok, false);
});

test('no confession block → confession null', () => {
  const c = parseContract(FULL.split('## POLYGRAPH CONFESSION')[0]);
  assert.equal(c.confession, null);
  assert.equal(c.ok, true);
});

test('missing file → exists:false', () => {
  assert.equal(parseContract(null).exists, false);
});

test('pointers parse ONLY from the → evidence: group — no phantom E-ids from prose', () => {
  const c = parseContract(FULL.replace(
    '- [x] R2: All tests pass (source: P1) [evidence: test] → evidence: E19',
    '- [x] R2: fixed E2E suite per E501 style (source: P1) [evidence: test] → evidence: E19'
  ));
  assert.equal(c.ok, true, c.errors.join('; '));
  assert.deepEqual(c.items[1].pointers, ['E19'], 'E2E/E501 in prose must not become pointers');
});

test('a check-off whose tail mentions E-ids WITHOUT the arrow group has no pointers', () => {
  const c = parseContract(FULL.replace(
    '- [x] R2: All tests pass (source: P1) [evidence: test] → evidence: E19',
    '- [x] R2: All tests pass (source: P1) [evidence: test] see E19'
  ));
  assert.deepEqual(c.items[1].pointers, [], 'no arrow group ⇒ unproven check-off fires');
});

test('item-shaped lines with wrong bullets are parse errors, not silently skipped', () => {
  for (const bad of ['* [ ] R9: alt bullet (source: P1) [evidence: diff]',
    '-[ ] R9: no space (source: P1) [evidence: diff]',
    'plain prose line inside requirements']) {
    const c = parseContract(FULL.replace(
      '- [ ] R1: Add rate limiting middleware (source: P1) [evidence: diff]',
      bad
    ));
    assert.equal(c.ok, false, `expected error for: ${bad}`);
    assert.match(c.errors.join(' '), /unparseable requirement/);
  }
});

test('repairLine is total — garbage returns null, never a throw (throw-bypass class)', () => {
  for (const bad of ['', '   ', '- [x] no r-id here', '- [z] R1: bad marker (source: P1)',
    'random prose', '```', '- [ ]', 'R1 alone']) {
    assert.doesNotThrow(() => { const r = repairLine(bad, ['P1']); assert.equal(r, null); },
      `repairLine must return null (not throw) on ${JSON.stringify(bad)}`);
  }
  // recoverable: marker + rid present, single source filled deterministically
  assert.match(repairLine('[ ] R1 no colon', ['P1']),
    /^- \[ \] R1: no colon \(source: P1\) \[evidence: diff\|test\|cmd\|manual\]$/);
  // multi-source with no explicit (source:) is unrecoverable — never guess
  assert.equal(repairLine('- [x] R1: work', ['P1', 'P2']), null);
});

test('suffixed P-ids (degradation-path mints) parse everywhere (M2 critical)', () => {
  const c = parseContract(`# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:s created:t baseline:none -->

## Sources
- P1-x7c078fc6 (t): degraded id → .polygraph/prompts/P1-x7c078fc6.txt

## Requirements
- [ ] R1: work (source: P1-x7c078fc6) [evidence: diff]
- [~] R2: skipped (source: P1-x7c078fc6) [evidence: diff] — deferred (user: P1-x7c078fc6)
`);
  assert.equal(c.ok, true, c.errors.join('; '));
  assert.deepEqual(c.sources, ['P1-x7c078fc6']);
  assert.equal(c.items[1].deferredUser, 'P1-x7c078fc6');
});

test('unknown section headings are parse errors (items must not vanish silently)', () => {
  for (const heading of ['## Requirements:', '## Requirementz']) {
    const c = parseContract(FULL.replace('## Requirements', heading));
    assert.equal(c.ok, false, `expected error for heading: ${heading}`);
    assert.match(c.errors.join(' '), /unknown section|unparseable/);
  }
});

// --- C2b hash zones (A3) ---------------------------------------------------

test('immutable zone ignores state marker and evidence tail', () => {
  const open = parseContract(FULL).items[0]; // R1 open
  const checked = parseContract(FULL.replace(
    '- [ ] R1: Add rate limiting middleware (source: P1) [evidence: diff]',
    '- [x] R1: Add rate limiting middleware (source: P1) [evidence: diff] → evidence: E12'
  )).items[0];
  assert.equal(open.hash, checked.hash, 'honest check-off must not change the hash');
});

test('rewording the text changes the hash; whitespace does not', () => {
  const a = zoneHash(immutableZone({ num: 1, text: 'Add  rate   limiting', source: 'P1', evidenceType: 'diff' }));
  const b = zoneHash(immutableZone({ num: 1, text: 'Add rate limiting', source: 'P1', evidenceType: 'diff' }));
  const c = zoneHash(immutableZone({ num: 1, text: 'Add throttling', source: 'P1', evidenceType: 'diff' }));
  assert.equal(a, b);
  assert.notEqual(a, c);
});
