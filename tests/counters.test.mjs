import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextId, recordRotation, readCounters } from '../scripts/lib/counters.mjs';

function fakePaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-test-'));
  return {
    dir,
    counters: path.join(dir, 'counters.json'),
    countersLock: path.join(dir, 'counters.lock'),
  };
}

test('ids are globally monotonic per kind and independent across kinds', () => {
  const p = fakePaths();
  assert.equal(nextId(p, 'e', 'ledger.jsonl').id, 'E1');
  assert.equal(nextId(p, 'e', 'ledger.jsonl').id, 'E2');
  assert.equal(nextId(p, 'p', 'ledger.jsonl').id, 'P1');
  assert.equal(nextId(p, 'e', 'ledger.jsonl').id, 'E3');
  const counters = readCounters(p.counters);
  assert.deepEqual(counters.files['ledger.jsonl'].e, [1, 3]);
  assert.deepEqual(counters.files['ledger.jsonl'].p, [1, 1]);
});

test('held fresh lock forces collision-proof suffixed id, never a duplicate', () => {
  const p = fakePaths();
  nextId(p, 'e', 'ledger.jsonl'); // E1
  fs.writeFileSync(p.countersLock, '9999'); // fresh foreign lock
  const result = nextId(p, 'e', 'ledger.jsonl');
  assert.ok(result.suffixed, 'expected suffixed fallback id');
  assert.match(result.id, /^E2-x[0-9a-f]{8}$/); // 32 bits of real entropy
  // foreign lock untouched (ownership check) and counter not advanced:
  assert.equal(fs.readFileSync(p.countersLock, 'utf8'), '9999');
  fs.unlinkSync(p.countersLock);
  assert.equal(nextId(p, 'e', 'ledger.jsonl').id, 'E2');
});

test('corrupt counters.json degrades to suffixed ids and is NEVER reset', () => {
  const p = fakePaths();
  nextId(p, 'e', 'ledger.jsonl'); // E1 — real state exists
  fs.writeFileSync(p.counters, '{corrupt json', 'utf8');
  const result = nextId(p, 'e', 'ledger.jsonl');
  assert.ok(result.suffixed, 'corrupt counters must degrade, not reset');
  // the corrupt file was not overwritten with zeroed counters
  assert.equal(fs.readFileSync(p.counters, 'utf8'), '{corrupt json');
});

test('recordRotation without the lock is a no-op (no unlocked read-modify-write)', () => {
  const p = fakePaths();
  nextId(p, 'e', 'ledger.jsonl'); // e=1, range recorded
  const before = fs.readFileSync(p.counters, 'utf8');
  fs.writeFileSync(p.countersLock, 'foreign'); // fresh foreign lock
  const ok = recordRotation(p, 'ledger.jsonl', 'ledger-x.jsonl');
  assert.equal(ok, false);
  assert.equal(fs.readFileSync(p.counters, 'utf8'), before, 'counters.json must be untouched');
  fs.unlinkSync(p.countersLock);
});

test('own lock is removed after allocation (release works for the owner)', () => {
  const p = fakePaths();
  nextId(p, 'e', 'ledger.jsonl');
  assert.ok(!fs.existsSync(p.countersLock), 'lock must be released');
});

test('stale lock (>2s) is taken over', () => {
  const p = fakePaths();
  fs.writeFileSync(p.countersLock, '9999');
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(p.countersLock, old, old);
  const result = nextId(p, 'e', 'ledger.jsonl');
  assert.equal(result.id, 'E1');
  assert.equal(result.suffixed, false);
});

test('recordRotation moves id ranges to the rotated file name', () => {
  const p = fakePaths();
  nextId(p, 'e', 'ledger.jsonl');
  nextId(p, 'e', 'ledger.jsonl');
  recordRotation(p, 'ledger.jsonl', 'ledger-2026.jsonl');
  const counters = readCounters(p.counters);
  assert.equal(counters.files['ledger.jsonl'], undefined);
  assert.deepEqual(counters.files['ledger-2026.jsonl'].e, [1, 2]);
});
