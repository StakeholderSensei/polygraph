// m0-observe — §18 M0 verification: a scripted session must produce the
// exact expected ledger (golden-file diff) with silent, exit-0 hooks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox, cleanup } from '../lib/sandbox.mjs';
import { runHook, ledgerEntries, masked, diffJson } from '../lib/driver.mjs';
import * as P from '../lib/payloads.mjs';

const GOLDEN = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'golden', 'm0-observe.golden.json'
);
const SID = 's_bench_m0';

export const name = 'm0-observe: scripted session → golden ledger';

export async function run() {
  const dir = makeSandbox(
    { 'package.json': '{"scripts":{"test":"vitest run"}}', 'pytest.ini': '' },
    { git: true }
  );
  try {
    const file = path.join(dir, 'src', 'auth.ts');
    const steps = [
      P.sessionStart(SID, dir),
      P.write(SID, dir, 'toolu_1', file, 'export const x = 1;\n'),
      P.edit(SID, dir, 'toolu_2', file, 'x', 'xy'),
      P.bashOk(SID, dir, 'toolu_3', 'npx vitest run', { stdout: '4 passed' }),
      P.bashOpaque(SID, dir, 'toolu_4', 'some-opaque-tool', { background: true }),
      P.bashFailure(SID, dir, 'toolu_5', 'pytest -q', 1, '2 failed, 14 passed'),
    ];
    const timings = [];
    for (const step of steps) {
      const { status, stdout, wallMs } = runHook(step, dir);
      timings.push(wallMs);
      if (status !== 0) return { pass: false, details: `${step.hook_event_name} exited ${status}` };
      if (stdout !== '') return { pass: false, details: `${step.hook_event_name} was not silent: ${stdout}` };
    }

    const actual = masked(ledgerEntries(dir));
    if (process.env.BENCH_RECORD === '1') {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n', 'utf8');
      return { pass: true, details: `golden RECORDED (${actual.length} entries) — review before committing` };
    }
    const expected = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    const diff = diffJson(actual, expected);
    if (diff) return { pass: false, details: `golden mismatch:\n${diff}` };

    const p95 = timings.sort((a, b) => a - b)[Math.ceil(timings.length * 0.95) - 1];
    return { pass: true, details: `6 entries match golden; hook wall p95 ${p95.toFixed(0)} ms (spawn-inclusive)` };
  } finally {
    cleanup(dir);
  }
}
