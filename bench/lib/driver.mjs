// driver.mjs — feeds synthesized payloads to the real dispatcher process,
// exactly as Claude Code does (spawn + stdin JSON), and reads back state.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'polygraph.mjs'
);

export function runHook(payload, cwd) {
  const started = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [SCRIPT, payload.hook_event_name || ''], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', wallMs };
}

export function ledgerEntries(dir) {
  const file = path.join(dir, '.polygraph', 'ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Mask run-variable fields so ledgers golden-diff cleanly. */
export function masked(entries) {
  return entries.map((e) => {
    const m = { ...e, ts: '<ts>' };
    if (m.cwd) m.cwd = '<cwd>';
    if (m.duration_ms !== undefined) m.duration_ms = '<ms>';
    return m;
  });
}

/** Write a POLYGRAPH.md contract into the sandbox (§10.1 grammar). */
export function writeContract(dir, items, { session = 's_bench', baseline = 'none', confession = '' } = {}) {
  const p = path.join(dir, '.polygraph');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'POLYGRAPH.md'), `# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:${session} created:2026-07-13T10:00:00Z baseline:${baseline} -->

## Sources
- P1 (2026-07-13T10:00:00Z): request → .polygraph/prompts/P1.txt

## Requirements
${items.join('\n')}
${confession}`, 'utf8');
}

export function readReceipt(dir) {
  const file = path.join(dir, '.polygraph', 'receipt.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** Parse a hook's stdout as JSON ({} when silent). */
export function outJson(stdout) {
  if (!stdout || !stdout.trim()) return {};
  return JSON.parse(stdout);
}

export function diffJson(actual, expected) {
  const a = JSON.stringify(actual, null, 2);
  const b = JSON.stringify(expected, null, 2);
  if (a === b) return null;
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
    if (aLines[i] !== bLines[i]) {
      out.push(`  line ${i + 1}:`);
      out.push(`    actual:   ${aLines[i] ?? '<missing>'}`);
      out.push(`    expected: ${bLines[i] ?? '<missing>'}`);
      if (out.length > 30) { out.push('  …'); break; }
    }
  }
  return out.join('\n');
}
