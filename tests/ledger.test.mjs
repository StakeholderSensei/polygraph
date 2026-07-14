import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEntry, resolvePointer, readAllEntries, LEDGER_NAME } from '../scripts/lib/ledger.mjs';
import { readCounters } from '../scripts/lib/counters.mjs';

function fakePaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-test-'));
  return {
    dir,
    ledger: path.join(dir, 'ledger.jsonl'),
    counters: path.join(dir, 'counters.json'),
    countersLock: path.join(dir, 'counters.lock'),
  };
}

function lines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('suffixed-id allocation leaves an audit note in the ledger (FR-0.3)', () => {
  const p = fakePaths();
  fs.writeFileSync(p.countersLock, 'foreign'); // wedge the lock
  const entry = appendEntry(p, 'e', { kind: 'command', session_id: 's1', command: 'x' });
  assert.match(entry.id, /^E1-x[0-9a-f]{8}$/);
  const all = lines(p.ledger);
  assert.equal(all.length, 2);
  assert.equal(all[0].kind, 'note');
  assert.match(all[0].text, /suffixed id E1-x/);
  fs.unlinkSync(p.countersLock);
});

test('id-less kinds (session_start, baseline) get no id and touch no counter', () => {
  const p = fakePaths();
  appendEntry(p, null, { kind: 'session_start', session_id: 's1' });
  appendEntry(p, null, { kind: 'baseline', session_id: 's1', sha: 'abc' });
  const all = lines(p.ledger);
  assert.equal(all[0].id, undefined);
  assert.equal(all[1].id, undefined);
  assert.equal(fs.existsSync(p.counters), false);
});

test('rotation at 5MB: rename + range recording + fresh active file', () => {
  const p = fakePaths();
  appendEntry(p, 'e', { kind: 'command', session_id: 's1', command: 'a' }); // E1
  // inflate past the cap
  fs.appendFileSync(p.ledger, ('{"v":1,"kind":"note","text":"' + 'x'.repeat(1024) + '"}\n').repeat(5200));
  appendEntry(p, 'e', { kind: 'command', session_id: 's1', command: 'b' }); // E2 → triggers rotation first
  const rotated = fs.readdirSync(p.dir).filter((n) => /^ledger-.*\.jsonl$/.test(n));
  assert.equal(rotated.length, 1, 'exactly one rotated file');
  const active = lines(p.ledger);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, 'E2');
  const counters = readCounters(p.counters);
  assert.deepEqual(counters.files[rotated[0]].e, [1, 1], 'E1 range moved to rotated name');
  assert.deepEqual(counters.files[LEDGER_NAME].e, [2, 2]);
  // cross-rotation reading and pointer resolution
  assert.equal(readAllEntries(p).filter((e) => e.kind === 'command').length, 2);
  assert.equal(resolvePointer(p, 'E1').command, 'a');
  assert.equal(resolvePointer(p, 'E2').command, 'b');
});

test('resolvePointer survives a WRONG range index via full-scan fallback', () => {
  const p = fakePaths();
  appendEntry(p, 'e', { kind: 'command', session_id: 's1', command: 'a' }); // E1 in ledger.jsonl
  // sabotage the index: claim E1 lives in a nonexistent rotated file
  const counters = readCounters(p.counters);
  counters.files = { 'ledger-gone.jsonl': { e: [1, 1] } };
  fs.writeFileSync(p.counters, JSON.stringify(counters));
  assert.equal(resolvePointer(p, 'E1').command, 'a', 'index miss must fall back to full scan');
});

test('resolvePointer returns null only after all retained files are scanned', () => {
  const p = fakePaths();
  appendEntry(p, 'e', { kind: 'command', session_id: 's1', command: 'a' });
  assert.equal(resolvePointer(p, 'E99'), null);
  assert.equal(resolvePointer(p, 'not-a-pointer'), null);
});

test('torn/corrupt ledger lines are skipped, valid ones survive', () => {
  const p = fakePaths();
  appendEntry(p, 'e', { kind: 'command', session_id: 's1', command: 'a' });
  fs.appendFileSync(p.ledger, '{"v":1,"kind":"command","truncated...\n');
  appendEntry(p, 'e', { kind: 'command', session_id: 's1', command: 'b' });
  const all = readAllEntries(p);
  assert.deepEqual(all.map((e) => e.command), ['a', 'b']);
});
