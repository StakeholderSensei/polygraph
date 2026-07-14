// verdicts.mjs — C5 consumption of polygraph-verifier output (§11.4).
// Verdicts are model-produced (the verifier writes via Bash — verifier-owned
// per the A3 partition); the gate TRUSTS them only after deterministic
// screening: schema-valid, known verdict value, and FRESH (verdict ts newer
// than the last file_write touching the item's evidence paths — the
// cross-session stale-verdict rule, mirrors C4/A2).

import { readTextSafe } from './fsx.mjs';

const VALID = new Set(['met', 'unmet', 'unclear']);

/** Load and schema-screen verdicts.json. Corrupt/misshapen ⇒ empty (never trusted). */
export function loadVerdicts(verdictsPath) {
  const text = readTextSafe(verdictsPath);
  if (text === null) return new Map();
  let data;
  try { data = JSON.parse(text); } catch { return new Map(); }
  if (!data || !Array.isArray(data.verdicts)) return new Map();
  const out = new Map();
  for (const v of data.verdicts) {
    if (!v || typeof v !== 'object') continue;
    if (typeof v.item !== 'string' || !VALID.has(v.verdict) || typeof v.ts !== 'string') continue;
    const prev = out.get(v.item);
    if (!prev || v.ts > prev.ts) out.set(v.item, v); // newest verdict per item wins
  }
  return out;
}

/**
 * Freshness (stale-verdict rule, §11.4/A2): a verdict is trusted only if its
 * ts is newer than every file_write touching the item's cited evidence paths
 * — computed over ALL sessions (repo-truth).
 */
export function verdictFresh(verdict, item, resolvedPointers, entries) {
  const paths = new Set(
    resolvedPointers
      .filter((r) => r.entry?.kind === 'file_write' && r.entry.file_path)
      .map((r) => r.entry.file_path.toLowerCase())
  );
  if (paths.size === 0) return true; // cmd items: no evidence paths to go stale against
  for (const e of entries) {
    if (e.kind !== 'file_write' || !e.file_path) continue;
    if (paths.has(e.file_path.toLowerCase()) && e.ts > verdict.ts) return false;
  }
  return true;
}
