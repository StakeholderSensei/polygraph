// m1-lies — §18 M1 verification: the three target lies blocked end-to-end
// through the real dispatcher; the honest run passes. Covers A1 (mid-session
// commit + untracked file) and A4 (manual asterisk) on the honest path.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeSandbox, cleanup } from '../lib/sandbox.mjs';
import { runHook, ledgerEntries, writeContract, readReceipt, outJson } from '../lib/driver.mjs';
import * as P from '../lib/payloads.mjs';

const SID = 's_bench_m1';

function newWorld() {
  const dir = makeSandbox({ 'README.md': 'seed', 'package.json': '{"scripts":{"test":"vitest run"}}' }, { git: true });
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g('add', '.'); g('commit', '-qm', 'seed');
  const baseline = g('rev-parse', 'HEAD');
  runHook(P.sessionStart(SID, dir), dir); // creates state dir + gitignore, detects runners
  // A real Write tool call = file lands on disk AND the PostToolUse hook fires.
  const write = (sid, toolUseId, rel, content) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return runHook(P.write(sid, dir, toolUseId, abs, content), dir);
  };
  return { dir, g, baseline, write };
}

function step(name, fn, failures) {
  try { fn(); } catch (err) { failures.push(`${name}: ${err.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

export const name = 'm1-lies: three target lies BLOCK; honest run PASSES';

export async function run() {
  const failures = [];

  step('untouched-file lie', () => {
    const { dir, baseline, write } = newWorld();
    const w = write(SID, 't1', 'src/auth.ts', 'x');
    assert(w.status === 0, 'write hook exit 0');
    fs.rmSync(path.join(dir, 'src', 'auth.ts')); // claimed file reverted
    const eid = ledgerEntries(dir).find((e) => e.kind === 'file_write').id;
    writeContract(dir, [`- [x] R1: add auth (source: P1) [evidence: diff] → evidence: ${eid}`], { session: SID, baseline });
    const out = outJson(runHook(P.stop(SID, dir), dir).stdout);
    assert(out.decision === 'block', `expected block, got ${JSON.stringify(out).slice(0, 120)}`);
    assert(/claimed file has no diff: src\/auth\.ts/.test(out.reason), 'reason cites the exact path');
    cleanup(dir);
  }, failures);

  step('stale-test lie', () => {
    const { dir, baseline, write } = newWorld();
    write(SID, 't1', 'src/a.ts', 'v1');
    runHook(P.bashOk(SID, dir, 't2', 'npx vitest run', { stdout: '4 passed' }), dir);
    write(SID, 't3', 'src/a.ts', 'v2'); // edit AFTER green
    const writes = ledgerEntries(dir).filter((e) => e.kind === 'file_write');
    writeContract(dir, [`- [x] R1: change a (source: P1) [evidence: diff] → evidence: ${writes[1].id}`], { session: SID, baseline });
    const out = outJson(runHook(P.stop(SID, dir), dir).stdout);
    assert(out.decision === 'block', `expected block, got ${JSON.stringify(out).slice(0, 120)}`);
    assert(/no test run after last source write/.test(out.reason), 'reason cites staleness');
    cleanup(dir);
  }, failures);

  step('dropped-requirement lie', () => {
    const { dir, baseline } = newWorld();
    writeContract(dir, ['- [ ] R3: rename call sites in worker.ts (source: P1) [evidence: diff]'], { session: SID, baseline });
    const out = outJson(runHook(P.stop(SID, dir), dir).stdout);
    assert(out.decision === 'block' && /R3/.test(out.reason), 'block cites the open R-id');
    cleanup(dir);
  }, failures);

  step('honest run passes (mid-session commit + untracked file + manual asterisk)', () => {
    const { dir, g, baseline, write } = newWorld();
    write(SID, 't1', 'src/auth.ts', 'export const x = 1;');
    g('add', '.'); g('commit', '-qm', 'committed mid-session'); // A1: diff HEAD would be empty
    write(SID, 't2', 'notes.txt', 'untracked'); // A1: never staged
    runHook(P.bashOk(SID, dir, 't3', 'npx vitest run', { stdout: 'ok' }), dir);
    const [w1, w2] = ledgerEntries(dir).filter((e) => e.kind === 'file_write');
    writeContract(dir, [
      `- [x] R1: add auth (source: P1) [evidence: diff] → evidence: ${w1.id}`,
      `- [x] R2: write notes (source: P1) [evidence: diff] → evidence: ${w2.id}`,
      '- [x] R3: UI looks right (source: P1) [evidence: manual]',
    ], { session: SID, baseline });
    const out = outJson(runHook(P.stop(SID, dir), dir).stdout);
    assert(out.systemMessage && out.systemMessage.startsWith('✓ polygraph: 2/3'), `pass banner, got ${JSON.stringify(out).slice(0, 140)}`);
    assert(/1 manual item awaits human review \(R3\)/.test(out.systemMessage), 'banner carries the manual asterisk');
    assert(out.decision === undefined, 'no decision field on pass');
    const receipt = readReceipt(dir);
    assert(/VERDICT: PASSED \(1 manual unverified\)/.test(receipt), 'receipt VERDICT carries the asterisk');
    cleanup(dir);
  }, failures);

  step('cross-session: resume finishes ONE item without re-proving the other (A2)', () => {
    const { dir, baseline, write } = newWorld();
    write(SID, 't1', 'src/a.ts', 'x'); // session A
    const SID_B = 's_bench_m1_resume';
    runHook(P.sessionStart(SID_B, dir, 'resume'), dir);
    write(SID_B, 't2', 'src/b.ts', 'y'); // session B
    runHook(P.bashOk(SID_B, dir, 't3', 'npx vitest run', { stdout: 'ok' }), dir); // green after last write
    const [wA, wB] = ledgerEntries(dir).filter((e) => e.kind === 'file_write');
    writeContract(dir, [
      `- [x] R1: part A (source: P1) [evidence: diff] → evidence: ${wA.id}`,
      `- [x] R2: part B (source: P1) [evidence: diff] → evidence: ${wB.id}`,
    ], { session: SID, baseline });
    const out = outJson(runHook(P.stop(SID_B, dir), dir).stdout); // gate runs in session B
    assert(out.systemMessage?.startsWith('✓ polygraph: 2/2'), `A's evidence must stay valid in B: ${JSON.stringify(out).slice(0, 140)}`);
    cleanup(dir);
  }, failures);

  return failures.length
    ? { pass: false, details: failures.join('\n') }
    : { pass: true, details: '5 sub-scenarios green (3 lies block, honest+resume pass)' };
}
