// shadow.mjs — the C2b contract-monotonicity check (amendment A3).
// Bless-after-validate: the shadow is only advanced when the current contract
// is a monotonic extension of it. Deletions/rewords fail and do NOT bless —
// the violation persists until the line is restored (or superseded).

import { atomicWriteJson, readTextSafe } from './fsx.mjs';

function loadShadow(shadowPath) {
  const text = readTextSafe(shadowPath);
  if (text === null) return { state: 'missing', data: null };
  try {
    const data = JSON.parse(text);
    // Every field the gate iterates must be screened here so evaluateGate can
    // NEVER throw on corrupt state — a throw escalates to the dispatcher's
    // fail-open catch and skips the WHOLE gate (C2/C3/C4/tamper), turning a
    // Bash-planted corrupt shadow from §15.11's bounded C2b-reset into an
    // unbounded false-PASS. items AND sources both guarded → degrade to na.
    if (!data || typeof data !== 'object'
      || data.items === null || typeof data.items !== 'object' || Array.isArray(data.items)
      || (data.sources !== undefined && !Array.isArray(data.sources))) {
      return { state: 'corrupt', data: null };
    }
    return { state: 'ok', data };
  } catch {
    return { state: 'corrupt', data: null };
  }
}

// v2: each blessed item stores the FULL last-blessed line alongside the
// immutable-zone hash — C2b-repair (B) restores the blessed line VERBATIM
// (never reconstructs semantics). v1 shadows (bare hash strings) still check.
function bless(shadowPath, parsed, rawText) {
  const rawLines = String(rawText ?? '').replaceAll('\r', '').split('\n');
  const items = {};
  for (const item of parsed.items) {
    items[item.id] = { hash: item.hash, line: rawLines[item.line - 1]?.trim() ?? null };
  }
  atomicWriteJson(shadowPath, {
    v: 2, items, sources: [...parsed.sources], blessed_at: new Date().toISOString(),
  });
}

function entryHash(entry) {
  return typeof entry === 'string' ? entry : entry?.hash;
}

/** Blessed line text for an id (v2 shadows only) — the C2b restoration source. */
export function blessedLine(shadowPath, id) {
  const { state, data } = loadShadow(shadowPath);
  if (state !== 'ok') return null;
  const entry = data.items[id];
  return entry && typeof entry === 'object' ? entry.line ?? null : null;
}

/**
 * Run C2b against a successfully-parsed contract.
 * Returns { status: 'pass'|'bootstrap'|'fail'|'na', violations: [{id, kind}] }.
 * dryRun never blesses (receipts rendering must not mutate trust state).
 */
export function checkMonotonicity(shadowPath, parsed, { dryRun = false, rawText = null } = {}) {
  const { state, data } = loadShadow(shadowPath);
  if (state === 'corrupt') {
    // fail-open (FR-0.4): unreadable trust state can degrade C2b but never
    // block; deleting/corrupting the shadow via Bash is the documented
    // Q10-class reset vector (§15.11).
    return { status: 'na', violations: [] };
  }
  if (state === 'missing') {
    if (!dryRun) bless(shadowPath, parsed, rawText);
    return { status: 'bootstrap', violations: [] };
  }
  const violations = [];
  const current = new Map(parsed.items.map((i) => [i.id, i.hash]));
  for (const [id, entry] of Object.entries(data.items)) {
    if (!current.has(id)) violations.push({ id, kind: 'removed' });
    else if (current.get(id) !== entryHash(entry)) violations.push({ id, kind: 'reworded' });
  }
  const currentSources = new Set(parsed.sources);
  for (const p of data.sources || []) {
    if (!currentSources.has(p)) violations.push({ id: p, kind: 'source-removed' });
  }
  if (violations.length) return { status: 'fail', violations }; // do NOT bless
  if (!dryRun) bless(shadowPath, parsed, rawText); // monotonic ⇒ bless (append new ids)
  return { status: 'pass', violations: [] };
}

/** Test helper / recovery: force-bless current state (used by bench setup only). */
export function forceBless(shadowPath, parsed, rawText = null) {
  bless(shadowPath, parsed, rawText);
}
