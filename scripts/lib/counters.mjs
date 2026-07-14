// counters.mjs — global monotonic P/E/G/N ids (amendment A2).
// Ids are per-repo, never reset across sessions: evidence pointers like E19
// must stay unambiguous forever. Allocation is guarded by an exclusive-create
// lockfile; on unrecoverable contention we allocate a collision-proof
// suffixed id (E123-x1a2b3c4d) rather than ever risking a duplicate (M3 = 0%).
//
// Lock protocol invariants (verified by tests/counters.test.mjs):
// - stale takeover goes through an atomic rename, so exactly ONE process wins
//   a steal (a stat/unlink takeover would let two stealers into the critical
//   section and mint duplicate plain ids);
// - releaseLock only removes a lock whose token we wrote (an owner stalled
//   past the stale threshold must not delete the usurper's lock);
// - counters.json is NEVER written without holding the lock, and a read
//   failure that isn't ENOENT NEVER resets the counters — unreadable counters
//   degrade to suffixed ids (safe unknown), not to a fresh id space.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { atomicWriteJson, withRetry } from './fsx.mjs';

const LOCK_RETRIES = 3;
const LOCK_BACKOFF_MS = [50, 100, 200];
const STALE_LOCK_MS = 2000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function emptyCounters() {
  return { v: 1, p: 0, e: 0, g: 0, n: 0, files: {} };
}

/**
 * Read counters. ENOENT → fresh empty counters. Any OTHER failure (sync-tool
 * lock, corrupt JSON) → null: the caller must degrade, never reset — a reset
 * would restart the global id space and alias every historical pointer.
 */
export function readCounters(countersPath) {
  let text;
  try {
    text = withRetry(() => fs.readFileSync(countersPath, 'utf8'));
  } catch (err) {
    return err.code === 'ENOENT' ? emptyCounters() : null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function makeToken() {
  return `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
}

/** Try to take the lock. Stale locks are stolen via atomic rename (one winner). */
function acquireLock(lockPath, token) {
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, token);
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const age = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (age > STALE_LOCK_MS) {
            // Atomic rename: if two processes race the steal, exactly one
            // rename succeeds; the loser throws and simply retries the create.
            const graveyard = `${lockPath}.stale-${process.pid}-${Date.now().toString(36)}`;
            fs.renameSync(lockPath, graveyard);
            try { fs.unlinkSync(graveyard); } catch { /* best effort */ }
            continue;
          }
        } catch {
          continue; // lock vanished / lost the steal race — retry the create
        }
      }
      // EBUSY/EPERM/EACCES on the create are contention too (A5): back off
      // and retry like EEXIST rather than giving up on the first hit.
      if (attempt < LOCK_RETRIES) sleepSync(LOCK_BACKOFF_MS[attempt]);
    }
  }
  return false;
}

/** Release only if we still own the lock (token match). */
function releaseLock(lockPath, token) {
  try {
    if (fs.readFileSync(lockPath, 'utf8') === token) fs.unlinkSync(lockPath);
  } catch { /* not ours anymore, or already gone — leave it alone */ }
}

/** Collision-proof fallback id when the lock or the counter file is unusable. */
function suffixedId(kind, lastKnown) {
  const suffix = crypto.randomBytes(4).toString('hex');
  return { id: `${kind.toUpperCase()}${lastKnown + 1}-x${suffix}`, suffixed: true };
}

/**
 * Allocate the next id of a kind ('p'|'e'|'g'|'n') and record which ledger
 * file it lands in (per-file id ranges make cross-rotation pointer lookup
 * O(1) and let housekeeping know which rotated files are still referenced).
 */
export function nextId(statePathsObj, kind, ledgerFileName) {
  const { counters: countersPath, countersLock: lockPath } = statePathsObj;
  const k = kind.toLowerCase();
  const token = makeToken();
  if (!acquireLock(lockPath, token)) {
    const counters = readCounters(countersPath);
    return suffixedId(k, counters ? counters[k] || 0 : 0);
  }
  try {
    const counters = readCounters(countersPath);
    if (counters === null) return suffixedId(k, 0); // unreadable/corrupt: degrade, never reset
    counters[k] = (counters[k] || 0) + 1;
    if (ledgerFileName && (k === 'p' || k === 'e')) {
      counters.files ||= {};
      const range = (counters.files[ledgerFileName] ||= {});
      const bounds = (range[k] ||= [counters[k], counters[k]]);
      bounds[0] = Math.min(bounds[0], counters[k]);
      bounds[1] = Math.max(bounds[1], counters[k]);
    }
    atomicWriteJson(countersPath, counters);
    return { id: `${k.toUpperCase()}${counters[k]}`, suffixed: false };
  } finally {
    releaseLock(lockPath, token);
  }
}

/**
 * Record that a ledger file was rotated: its ranges are frozen under the new
 * name. Without the lock (or with unreadable counters) this is a no-op —
 * pointer resolution has a full-scan fallback, while an unlocked stale
 * read-modify-write could roll the id counter back (duplicate plain ids).
 */
export function recordRotation(statePathsObj, oldName, newName) {
  const { counters: countersPath, countersLock: lockPath } = statePathsObj;
  const token = makeToken();
  if (!acquireLock(lockPath, token)) return false;
  try {
    const counters = readCounters(countersPath);
    if (counters === null) return false;
    if (counters.files?.[oldName]) {
      counters.files[newName] = counters.files[oldName];
      delete counters.files[oldName];
      atomicWriteJson(countersPath, counters);
    }
    return true;
  } finally {
    releaseLock(lockPath, token);
  }
}
