// gitx.mjs — read-only git adapter for the gate (amendment A1).
// Every call is best-effort: a null return means "git corroboration n/a",
// never an error that could block a stop (fail-open, FR-0.4/§15.9).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Resolve Windows 8.3 short names (e.g. PROGRA~1) so git paths and Node paths agree. */
function realpathSafe(p) {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

function git(cwd, args) {
  try {
    // core.quotepath=off: non-ASCII filenames come out as raw UTF-8 instead
    // of C-style octal escapes (which would mangle changed-set keys and
    // falsely block honest work on accented filenames).
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
      cwd, encoding: 'utf8', timeout: 5000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export function headSha(cwd) {
  const out = git(cwd, ['rev-parse', 'HEAD']);
  return out === null ? null : out.trim();
}

export function repoToplevel(cwd) {
  const out = git(cwd, ['rev-parse', '--show-toplevel']);
  return out === null ? null : realpathSafe(out.trim());
}

/**
 * A1 validity predicate: baseline usable iff the object exists AND is an
 * ancestor of HEAD. Covers rebase, hard reset, amend-below-baseline, branch
 * switch. `knownRepo` skips the repo probe when the caller already resolved
 * the toplevel (the gate does — spawns are ~80ms each on Windows, NFR-P1).
 * No-HEAD repos: a valid baseline commit cannot exist without a HEAD to
 * descend from it, so a failing merge-base degrades correctly (safe n/a).
 */
export function baselineStatus(cwd, baseline, { knownRepo = false } = {}) {
  if (!knownRepo && repoToplevel(cwd) === null) return { git: false, valid: false, reason: 'not a git repo / git missing' };
  if (!baseline || baseline === 'none') return { git: true, valid: false, reason: 'no baseline recorded' };
  if (git(cwd, ['cat-file', '-e', baseline]) === null) {
    return { git: true, valid: false, reason: 'baseline lost (object missing)' };
  }
  if (git(cwd, ['merge-base', '--is-ancestor', baseline, 'HEAD']) === null) {
    return { git: true, valid: false, reason: 'baseline lost (not an ancestor of HEAD)' };
  }
  return { git: true, valid: true, reason: null };
}

/** Decode a git-quoted path ("citt\303\240 \"x\".txt") into real UTF-8. */
function decodeQuoted(raw) {
  if (!(raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const inner = raw.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') { bytes.push(...Buffer.from(inner[i], 'utf8')); continue; }
    const oct = /^[0-7]{3}/.exec(inner.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; continue; }
    const esc = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 }[inner[i + 1]];
    if (esc !== undefined) { bytes.push(esc); i += 1; continue; }
    bytes.push(92);
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Normalize one numstat/porcelain path field into the changed-set key space.
 * Renames yield BOTH sides — old and new are both legitimately part of the
 * baseline-anchored change (a false "no diff" on either falsely blocks).
 */
function cleanPaths(raw) {
  let p = decodeQuoted(raw.trim()).replaceAll('\\', '/');
  if (/\{[^}]*=>[^}]*\}/.test(p)) {
    // brace form: src/{old => new}/file — expand both sides
    const oldP = p.replace(/\{([^}]*) => [^}]*\}/g, '$1').replaceAll('//', '/');
    const newP = p.replace(/\{[^}]* => ([^}]*)\}/g, '$1').replaceAll('//', '/');
    return [oldP, newP];
  }
  const arrow = p.indexOf(' => ');
  if (arrow !== -1) return [p.slice(0, arrow), p.slice(arrow + 4)];
  return [p];
}

/**
 * A1 changed-file set: union of committed-since-baseline + worktree
 * (`diff <baseline>`), staged against the same anchor (`diff --cached
 * <baseline>`), and untracked files (`status --porcelain -uall` '??').
 * Keys are toplevel-relative, forward slashes. Values {ins, del, untracked?}.
 * Returns null when ANY git call fails — a partial set masquerading as
 * corroboration would falsely block every honest diff item; null degrades
 * the gate to ledger-evidence-only (fail-open, §15.9).
 */
export function changedSet(cwd, baseline) {
  const worktree = git(cwd, ['diff', '--numstat', baseline]);
  const staged = git(cwd, ['diff', '--numstat', '--cached', baseline]);
  const status = git(cwd, ['status', '--porcelain', '-uall']);
  if (worktree === null || staged === null || status === null) return null;

  const files = new Map();
  const addNumstat = (out) => {
    for (const line of out.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      const ins = m[1] === '-' ? 0 : Number(m[1]);
      const del = m[2] === '-' ? 0 : Number(m[2]);
      for (const p of cleanPaths(m[3])) {
        const prev = files.get(p);
        // max, not sum: the two diff sources overlap for staged/committed
        // work and summing would double-count every receipt line count
        files.set(p, {
          ins: Math.max(prev?.ins ?? 0, ins),
          del: Math.max(prev?.del ?? 0, del),
        });
      }
    }
  };
  addNumstat(worktree);
  addNumstat(staged);
  for (const line of status.split('\n')) {
    if (!line.startsWith('??')) continue;
    for (const p of cleanPaths(line.slice(3))) {
      if (p && !files.has(p)) files.set(p, { ins: null, del: null, untracked: true });
    }
  }
  return files;
}

/** Map a cwd-relative ledger path to the toplevel-relative key space. */
export function toToplevelRelative(cwd, toplevel, relPath) {
  if (!toplevel) return relPath.replaceAll('\\', '/');
  const abs = path.resolve(realpathSafe(cwd), relPath);
  return path.relative(toplevel, abs).replaceAll('\\', '/');
}

/** Case-insensitive membership check against the changed-set keys (NFR-C3). */
export function inChangedSet(files, relPath) {
  if (files.has(relPath)) return true;
  const lower = relPath.toLowerCase();
  for (const key of files.keys()) {
    if (key.toLowerCase() === lower) return true;
  }
  return false;
}

/** Numeric totals for the receipt JSON payload (§10.4): {files, ins, del}. */
export function totals(files) {
  if (!files) return null;
  let ins = 0, del = 0;
  for (const v of files.values()) { ins += v.ins || 0; del += v.del || 0; }
  return { files: files.size, ins, del };
}

/** One-line summary for receipts footers: "4 files, +212/−45". */
export function summarize(files) {
  const t = totals(files);
  return t ? `${t.files} files, +${t.ins}/−${t.del}` : 'n/a';
}
