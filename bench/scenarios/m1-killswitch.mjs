// m1-killswitch — §13.2 escape hatches + FR-0.4 fail-open, end-to-end:
// mode off is a total no-op; corrupt INFRASTRUCTURE never blocks
// (corrupt CONTRACT blocking is by design — §10.1 — and covered in tests).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeSandbox, cleanup } from '../lib/sandbox.mjs';
import { runHook, writeContract, ledgerEntries, outJson, SCRIPT } from '../lib/driver.mjs';
import * as P from '../lib/payloads.mjs';

const SID = 's_bench_kill';
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
function step(name, fn, failures) {
  try { fn(); } catch (err) { failures.push(`${name}: ${err.message}`); }
}
const cli = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', timeout: 15000 });

export const name = 'm1-killswitch: /polygraph:off is total; corrupt state never blocks';

export async function run() {
  const failures = [];

  step('mode off: zero ledger writes, silent Stop, then on restores', () => {
    const dir = makeSandbox({}, {});
    runHook(P.sessionStart(SID, dir), dir);
    let res = cli(dir, 'mode', 'off');
    assert(/mode=off/.test(res.stdout), `mode off confirms: ${res.stdout}`);
    const before = ledgerEntries(dir).length;
    runHook(P.bashOk(SID, dir, 't1', 'echo hi'), dir);
    const stop = runHook(P.stop(SID, dir), dir);
    assert(ledgerEntries(dir).length === before, 'no ledger writes while off');
    assert(stop.stdout === '', 'Stop is silent while off');
    res = cli(dir, 'mode', 'standard');
    assert(/mode=standard/.test(res.stdout), 'mode restored');
    runHook(P.bashOk(SID, dir, 't2', 'echo hi'), dir);
    assert(ledgerEntries(dir).length === before + 1, 'ledger records again after on');
    cleanup(dir);
  }, failures);

  step('mode off --repo persists to config.json', () => {
    const dir = makeSandbox({}, {});
    cli(dir, 'mode', 'off', '--repo');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.polygraph', 'config.json'), 'utf8'));
    assert(cfg.mode === 'off', 'config.json carries the policy');
    cleanup(dir);
  }, failures);

  step('corrupt infrastructure (counters/shadow/session + torn ledger) NEVER blocks honest work', () => {
    const dir = makeSandbox({}, {});
    runHook(P.sessionStart(SID, dir), dir);
    runHook(P.write(SID, dir, 't1', path.join(dir, 'src', 'a.ts'), 'x'), dir);
    const eid = ledgerEntries(dir).find((e) => e.kind === 'file_write').id;
    writeContract(dir, [`- [x] R1: work (source: P1) [evidence: diff] → evidence: ${eid}`], { session: SID });
    const st = path.join(dir, '.polygraph');
    fs.writeFileSync(path.join(st, 'counters.json'), '{corrupt', 'utf8');
    fs.writeFileSync(path.join(st, 'contract.shadow.json'), '{corrupt', 'utf8');
    fs.writeFileSync(path.join(st, 'session.json'), '{corrupt', 'utf8');
    fs.appendFileSync(path.join(st, 'ledger.jsonl'), '{"torn line…\n');
    const out = outJson(runHook(P.stop(SID, dir), dir).stdout);
    assert(out.decision !== 'block', `fail-open: corrupt infra must not block: ${JSON.stringify(out).slice(0, 160)}`);
    cleanup(dir);
  }, failures);

  step('internal error path stays fail-open (state dir replaced by a file)', () => {
    const dir = makeSandbox({}, {});
    fs.writeFileSync(path.join(dir, '.polygraph'), 'not a directory', 'utf8');
    const res = runHook(P.stop(SID, dir), dir);
    assert(res.status === 0, 'exit 0');
    const out = outJson(res.stdout);
    assert(out.decision === undefined, 'never a block from internal errors');
    assert(/internal error/.test(out.systemMessage || ''), 'reports its own degradation');
    cleanup(dir);
  }, failures);

  return failures.length
    ? { pass: false, details: failures.join('\n') }
    : { pass: true, details: '4 sub-scenarios green (off/on, --repo, corrupt-state, internal-error)' };
}
