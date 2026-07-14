// ledger.mjs — the append-only evidence ledger (FR-2.*).
// Entries come exclusively from hook payloads; the model's narration is
// never written here. Rotation at 5 MB (FR-2.11); per-session entry cap.

import fs from 'node:fs';
import path from 'node:path';
import { appendLine, statSafe, readTextSafe } from './fsx.mjs';
import { nextId, recordRotation, readCounters } from './counters.mjs';
import { nowIso } from './state.mjs';

export const LEDGER_NAME = 'ledger.jsonl';
const ROTATE_BYTES = 5 * 1024 * 1024;
export const SESSION_ENTRY_CAP = 5000;

/** Rotate ledger.jsonl if over size cap. Returns the active file name. */
function rotateIfNeeded(paths) {
  const st = statSafe(paths.ledger);
  if (!st || st.size < ROTATE_BYTES) return LEDGER_NAME;
  const stamp = nowIso().replace(/[:.]/g, '-');
  const rotatedName = `ledger-${stamp}.jsonl`;
  try {
    fs.renameSync(paths.ledger, path.join(paths.dir, rotatedName));
  } catch {
    // rename blocked (sync-tool lock): keep appending to the oversized file —
    // an oversized ledger beats a lost entry.
    return LEDGER_NAME;
  }
  // Rename succeeded; range-index recording is best-effort and lock-guarded —
  // on failure resolvePointer's full-scan fallback still finds everything.
  try { recordRotation(paths, LEDGER_NAME, rotatedName); } catch { /* best effort */ }
  return LEDGER_NAME;
}

/**
 * Append an entry. Kinds carrying an id get a global monotonic one from
 * counters (kindLetter: 'p' | 'e' | 'g' | 'n'); pass null for id-less kinds
 * (session_start, baseline).
 */
export function appendEntry(paths, kindLetter, entry) {
  const fileName = rotateIfNeeded(paths);
  const full = { v: 1, ts: nowIso(), ...entry };
  if (kindLetter) {
    const { id, suffixed } = nextId(paths, kindLetter, fileName);
    full.id = id;
    if (suffixed) {
      // FR-0.3: the contention fallback is audit-trailed (id-less note —
      // minting a note id would need the very counters that are wedged).
      appendLine(paths.ledger, JSON.stringify({
        v: 1, ts: full.ts, kind: 'note', session_id: entry.session_id ?? null,
        text: `lock contention: allocated suffixed id ${id}`,
      }));
    }
  }
  appendLine(paths.ledger, JSON.stringify(full));
  return full;
}

function parseLines(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // torn/corrupt line: skip — never let one bad line kill evidence reading
    }
  }
  return out;
}

/** All retained ledger files, oldest first, current last (A2: resolution spans all). */
export function retainedLedgerFiles(paths) {
  let names = [];
  try {
    names = fs.readdirSync(paths.dir).filter((n) => /^ledger-.*\.jsonl$/.test(n)).sort();
  } catch {
    /* state dir missing */
  }
  return [...names.map((n) => path.join(paths.dir, n)), paths.ledger];
}

/** Read every entry from all retained ledger files (cross-session, cross-rotation). */
export function readAllEntries(paths) {
  const entries = [];
  for (const file of retainedLedgerFiles(paths)) {
    entries.push(...parseLines(readTextSafe(file)));
  }
  return entries;
}

/**
 * Resolve one evidence pointer (e.g. "E19") to its entry, using the per-file
 * id ranges in counters.json to pick candidate files first (O(1) per file),
 * then falling back to a full scan of all retained files.
 */
export function resolvePointer(paths, pointerId) {
  const match = /^([EP])(\d+)/i.exec(pointerId);
  if (!match) return null;
  const kind = match[1].toLowerCase();
  const num = Number(match[2]);
  const counters = readCounters(paths.counters);
  const candidates = [];
  for (const [name, ranges] of Object.entries(counters?.files || {})) {
    const bounds = ranges[kind];
    if (bounds && num >= bounds[0] && num <= bounds[1]) {
      candidates.push(name === LEDGER_NAME ? paths.ledger : path.join(paths.dir, name));
    }
  }
  const scan = (files) => {
    for (const file of files) {
      for (const entry of parseLines(readTextSafe(file))) {
        if (entry.id === pointerId) return entry;
      }
    }
    return null;
  };
  // The index is an optimization only: a candidate miss (e.g. a rotation
  // whose range recording was skipped under contention) still falls back to
  // scanning every retained file — a pointer fails only after ALL are scanned.
  if (candidates.length) {
    const hit = scan(candidates);
    if (hit) return hit;
  }
  return scan(retainedLedgerFiles(paths));
}
