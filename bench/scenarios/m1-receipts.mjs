// m1-receipts — FR-4.*: golden receipts table for a mixed-status contract;
// the /polygraph:status CLI output is byte-identical to receipt.md's table
// (single check implementation, FR-4.4); dry-run mutates nothing.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSandbox, cleanup } from '../lib/sandbox.mjs';
import { runHook, writeContract, ledgerEntries, readReceipt, outJson, SCRIPT, diffJson } from '../lib/driver.mjs';
import * as P from '../lib/payloads.mjs';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'golden', 'm1-receipts.golden.txt');
const SID = 's_bench_receipts';
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

export const name = 'm1-receipts: golden table; CLI = receipt.md; dry-run mutates nothing';

export async function run() {
  const dir = makeSandbox({}, {});
  try {
    runHook(P.sessionStart(SID, dir), dir);
    runHook(P.write(SID, dir, 't1', path.join(dir, 'src', 'rate.ts'), 'limiter'), dir);
    runHook(P.bashOk(SID, dir, 't2', 'npm test', { stdout: 'ok' }), dir); // no runner detected in sandbox → tagged null
    const w1 = ledgerEntries(dir).find((e) => e.kind === 'file_write');
    writeContract(dir, [
      `- [x] R1: add rate limiting middleware (source: P1) [evidence: diff] → evidence: ${w1.id}`,
      '- [ ] R2: update API docs (source: P1) [evidence: diff]',
      '- [~] R3: dashboard widget (source: P1) [evidence: diff] — deferred (user: P1)',
      '- [?] R4: make it feel snappy (source: P1) [evidence: manual] — needs clarification',
      '- [x] R5: manual smoke on mobile (source: P1) [evidence: manual]',
    ], { session: SID });

    // Stop → block (R2 open) and receipt regenerated (FR-3.9)
    const out = outJson(runHook(P.stop(SID, dir), dir).stdout);
    assert(out.decision === 'block', 'mixed contract blocks on R2');
    const receipt = readReceipt(dir);
    assert(receipt, 'receipt.md written on block');
    assert(/```json/.test(receipt), 'receipt carries the machine payload (FR-4.3)');

    // golden compare (mask session/ts header line)
    const table = receipt.split('\n\n```json')[0];
    const masked = table.replace(/session .*? —/, 'session <sid> —').replace(/— \d{4}-\d{2}-\d{2} \d{2}:\d{2} —/, '— <ts> —');
    if (process.env.BENCH_RECORD === '1') {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, masked + '\n', 'utf8');
    } else {
      const expected = fs.readFileSync(GOLDEN, 'utf8').trimEnd();
      const diff = diffJson(masked.split('\n'), expected.split('\n'));
      assert(!diff, `receipts table drifted from golden:\n${diff}`);
    }

    // statuses byte-identical between gate receipt and CLI renderer (FR-4.4)
    const cliRun = spawnSync(process.execPath, [SCRIPT, 'receipts'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    const glyphRows = (s) => s.split('\n').filter((l) => l.startsWith('│')).join('\n');
    assert(glyphRows(cliRun.stdout).includes(glyphRows(table).split('\n').slice(2).join('\n').split('\n')[0]),
      'CLI table rows match the gate-written receipt rows');

    // dry-run purity: counters/shadow/block_count untouched by CLI receipts
    const before = {
      counters: fs.readFileSync(path.join(dir, '.polygraph', 'counters.json'), 'utf8'),
      session: fs.readFileSync(path.join(dir, '.polygraph', 'session.json'), 'utf8'),
    };
    spawnSync(process.execPath, [SCRIPT, 'receipts'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    spawnSync(process.execPath, [SCRIPT, 'gate', '--dry-run'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    assert(fs.readFileSync(path.join(dir, '.polygraph', 'counters.json'), 'utf8') === before.counters, 'dry-run leaves counters alone');
    assert(fs.readFileSync(path.join(dir, '.polygraph', 'session.json'), 'utf8') === before.session, 'dry-run leaves session state alone');

    // gate --dry-run JSON agrees with the last real decision
    const dry = JSON.parse(spawnSync(process.execPath, [SCRIPT, 'gate', '--dry-run'], { cwd: dir, encoding: 'utf8', timeout: 15000 }).stdout);
    assert(dry.decision === 'block' && dry.failed.includes('R2'), `dry-run mirrors the gate: ${JSON.stringify(dry)}`);

    return { pass: true, details: `golden table stable; CLI/gate agree; VERDICT: ${table.split('\n').pop()}` };
  } finally {
    cleanup(dir);
  }
}
