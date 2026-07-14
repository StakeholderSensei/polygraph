// fsx.mjs — filesystem primitives: atomic writes, lock-retry, safe reads.
// A5 (NFR-R4): atomic temp+rename is same-directory (same volume) and every
// mutating call retries on sync-tool file locks (OneDrive/Dropbox/AV):
// 3 retries, 50/100/200 ms backoff on EBUSY/EPERM/EACCES.

import fs from 'node:fs';
import path from 'node:path';

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const BACKOFF_MS = [50, 100, 200];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run fn, retrying on file-lock errors with fixed backoff. */
export function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!LOCK_CODES.has(err.code) || attempt === BACKOFF_MS.length) throw err;
      sleepSync(BACKOFF_MS[attempt]);
    }
  }
  throw lastErr;
}

export function ensureDir(dir) {
  withRetry(() => fs.mkdirSync(dir, { recursive: true }));
}

/** Atomic write: temp file in the SAME directory, then rename (same volume). */
export function atomicWriteFile(file, data) {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${Date.now().toString(36)}`
  );
  withRetry(() => fs.writeFileSync(tmp, data, 'utf8'));
  try {
    withRetry(() => fs.renameSync(tmp, file));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

export function atomicWriteJson(file, obj) {
  atomicWriteFile(file, JSON.stringify(obj, null, 2) + '\n');
}

/** Append one line to a JSONL file (O_APPEND; single write ≤4k is atomic enough). */
export function appendLine(file, line) {
  withRetry(() => fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n', 'utf8'));
}

export function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function readJsonSafe(file) {
  const text = readTextSafe(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/**
 * Keys-only structure of a value, for the tool_response shape probe (FR-2.5).
 * Values are replaced by their type name; strings show length only. Depth-capped.
 */
export function structureOf(value, depth = 0) {
  if (depth > 4) return '…';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [structureOf(value[0], depth + 1)];
  }
  const t = typeof value;
  if (t === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = structureOf(value[key], depth + 1);
    return out;
  }
  if (t === 'string') return `string(${value.length})`;
  return t;
}
