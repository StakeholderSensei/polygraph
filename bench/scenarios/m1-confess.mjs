// m1-confess — FR-3.7 confession protocol + FR-3.1 loop guard, end-to-end:
// superset unlocks, under-confession stays blocked, never more than
// max_blocks blocks, tamper blocks (A3) through the real dispatcher.
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, cleanup } from '../lib/sandbox.mjs';
import { runHook, writeContract, outJson } from '../lib/driver.mjs';
import * as P from '../lib/payloads.mjs';

const SID = 's_bench_confess';
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const OPEN = ['- [ ] R1: part one (source: P1) [evidence: diff]'];

function step(name, fn, failures) {
  try { fn(); } catch (err) { failures.push(`${name}: ${err.message}`); }
}

export const name = 'm1-confess: superset unlocks, under-confession blocks, loop guard caps blocks';

export async function run() {
  const failures = [];

  step('under-confession stays blocked; exact superset unlocks with ⚠', () => {
    const dir = makeSandbox({}, {});
    runHook(P.sessionStart(SID, dir), dir);
    writeContract(dir, ['- [ ] R1: a (source: P1) [evidence: diff]', '- [ ] R2: b (source: P1) [evidence: diff]'],
      { session: SID, confession: '\n## POLYGRAPH CONFESSION\nstatus: incomplete\nunmet: R1\nnote: partial\n' });
    let out = outJson(runHook(P.stop(SID, dir), dir).stdout);
    assert(out.decision === 'block' && /under-confesses/.test(out.reason), `under-confession must block: ${JSON.stringify(out).slice(0, 120)}`);

    writeContract(dir, ['- [ ] R1: a (source: P1) [evidence: diff]', '- [ ] R2: b (source: P1) [evidence: diff]'],
      { session: SID, confession: '\n## POLYGRAPH CONFESSION\nstatus: incomplete\nunmet: R1, R2\nnote: honest\n' });
    out = outJson(runHook(P.stop(SID, dir), dir).stdout);
    assert(out.decision === undefined && /⚠ polygraph: stopped WITH CONFESSION — unmet: R1, R2/.test(out.systemMessage),
      `superset must unlock: ${JSON.stringify(out).slice(0, 140)}`);
    cleanup(dir);
  }, failures);

  step('loop guard: block, block, then NEVER a third — nudge, then warned allow', () => {
    const dir = makeSandbox({}, {});
    runHook(P.sessionStart(SID, dir), dir);
    writeContract(dir, OPEN, { session: SID });
    const decisions = [];
    for (let i = 0; i < 4; i++) {
      const out = outJson(runHook(P.stop(SID, dir, i > 0), dir).stdout);
      decisions.push(out.decision || (out.hookSpecificOutput ? 'nudge' : 'allow'));
    }
    assert(JSON.stringify(decisions) === JSON.stringify(['block', 'block', 'nudge', 'allow']),
      `expected block,block,nudge,allow — got ${decisions.join(',')}`);
    cleanup(dir);
  }, failures);

  step('tamper: model Edit on receipt.md blocks; config.json message names user paths (A3)', () => {
    const dir = makeSandbox({}, {});
    runHook(P.sessionStart(SID, dir), dir);
    runHook(P.write(SID, dir, 't1', path.join(dir, '.polygraph', 'receipt.md'), 'forged'), dir);
    writeContract(dir, ['- [x] R1: work (source: P1) [evidence: manual]'], { session: SID });
    let out = outJson(runHook(P.stop(SID, dir), dir).stdout);
    assert(out.decision === 'block' && /tamper/.test(out.reason), `receipt forgery must block: ${JSON.stringify(out).slice(0, 140)}`);

    const dir2 = makeSandbox({}, {});
    runHook(P.sessionStart(SID, dir2), dir2);
    runHook(P.write(SID, dir2, 't1', path.join(dir2, '.polygraph', 'config.json'), '{"mode":"off"}'), dir2);
    writeContract(dir2, ['- [x] R1: work (source: P1) [evidence: manual]'], { session: SID });
    out = outJson(runHook(P.stop(SID, dir2), dir2).stdout);
    assert(/ask the user to edit \.polygraph\/config\.json or run \/polygraph:mode/.test(out.reason || ''),
      `config tamper names the sanctioned paths: ${JSON.stringify(out).slice(0, 160)}`);
    cleanup(dir); cleanup(dir2);
  }, failures);

  step('C2b end-to-end: deleting a requirement blocks with the supersession lesson (A3)', () => {
    const dir = makeSandbox({}, {});
    runHook(P.sessionStart(SID, dir), dir);
    writeContract(dir, ['- [ ] R1: a (source: P1) [evidence: diff]', '- [ ] R2: b (source: P1) [evidence: diff]'], { session: SID });
    runHook(P.stop(SID, dir), dir); // blesses (and blocks on open items)
    writeContract(dir, ['- [ ] R1: a (source: P1) [evidence: diff]'], { session: SID }); // R2 deleted
    const out = outJson(runHook(P.stop(SID, dir, true), dir).stdout);
    assert(/C2b contract-monotonicity: R2 removed/.test(out.reason || '') && /supersede/.test(out.reason || ''),
      `C2b must catch the deletion: ${JSON.stringify(out).slice(0, 160)}`);
    cleanup(dir);
  }, failures);

  return failures.length
    ? { pass: false, details: failures.join('\n') }
    : { pass: true, details: '4 sub-scenarios green (confession, loop guard, tamper, C2b)' };
}
