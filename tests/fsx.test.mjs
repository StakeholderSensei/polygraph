import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile, atomicWriteJson, appendLine, readJsonSafe, structureOf } from '../scripts/lib/fsx.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-test-'));
}

test('atomicWriteFile writes content and leaves no temp files', () => {
  const dir = tmp();
  const file = path.join(dir, 'x.json');
  atomicWriteFile(file, 'hello');
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
  atomicWriteFile(file, 'world');
  assert.equal(fs.readFileSync(file, 'utf8'), 'world');
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
});

test('atomicWriteJson + readJsonSafe round-trip; corrupt json reads as null', () => {
  const dir = tmp();
  const file = path.join(dir, 'c.json');
  atomicWriteJson(file, { a: 1 });
  assert.deepEqual(readJsonSafe(file), { a: 1 });
  fs.writeFileSync(file, '{not json', 'utf8');
  assert.equal(readJsonSafe(file), null);
  assert.equal(readJsonSafe(path.join(dir, 'missing.json')), null);
});

test('appendLine appends newline-terminated lines', () => {
  const dir = tmp();
  const file = path.join(dir, 'l.jsonl');
  appendLine(file, '{"a":1}');
  appendLine(file, '{"b":2}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n{"b":2}\n');
});

test('structureOf redacts values, keeps keys', () => {
  const shape = structureOf({ exit_code: 0, stdout: 'abcdef', nested: { ok: true }, arr: [1, 2] });
  assert.deepEqual(shape, {
    exit_code: 'number',
    stdout: 'string(6)',
    nested: { ok: 'boolean' },
    arr: ['number'],
  });
});
