// m2-contract — bench: Q&A creates no contract, imperative
// does, multi-prompt accumulation works, and the FULL loop closes: the hook
// hands the model the exact header (baseline sha included), the model builds
// the contract, does the work, and the gate passes on real evidence.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeSandbox, cleanup } from '../lib/sandbox.mjs';
import { runHook, ledgerEntries, outJson, readReceipt } from '../lib/driver.mjs';
import * as P from '../lib/payloads.mjs';

const SID = 's_bench_m2';
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
function step(name, fn, failures) {
  try { fn(); } catch (err) { failures.push(`${name}: ${err.message}`); }
}

export const name = 'm2-contract: Q&A skips, imperative captures, full loop passes';

export async function run() {
  const failures = [];

  step('full honest loop: question → skip; imperative → header; contract → work → PASS', () => {
    const dir = makeSandbox({ 'README.md': 'seed' }, { git: true });
    const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    g('add', '.'); g('commit', '-qm', 'seed');
    const expectedBaseline = g('rev-parse', 'HEAD');
    runHook(P.sessionStart(SID, dir), dir);

    // 1. Q&A prompt: silent, no P entry (§15.2)
    const qa = runHook(P.userPrompt(SID, dir, 'why does the event loop starve microtasks sometimes?'), dir);
    assert(qa.stdout === '', 'question must be silent');

    // 2. Imperative prompt: P1 + instruction with the REAL baseline sha
    const cap = outJson(runHook(P.userPrompt(SID, dir, 'add a rate limiter module and prove it with a test run'), dir).stdout);
    const ctx = cap.hookSpecificOutput.additionalContext;
    assert(new RegExp(`baseline:${expectedBaseline}`).test(ctx), `instruction carries the real HEAD sha: ${ctx.slice(0, 160)}`);
    const header = /<!--[^>]*-->/.exec(ctx)[0];

    // 3. Stop WITHOUT a contract: the primal lie blocks
    let out = outJson(runHook(P.stop(SID, dir), dir).stdout);
    assert(out.decision === 'block' && /no contract despite/.test(out.reason), 'no-contract stop must block');

    // 4. The model obeys: contract created with the exact header, work done, tests green
    const file = path.join(dir, 'src', 'rate.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export const limiter = 1;', 'utf8');
    runHook(P.write(SID, dir, 't1', file, 'export const limiter = 1;'), dir);
    runHook(P.bashOk(SID, dir, 't2', 'npx vitest run', { stdout: 'ok' }), dir);
    const eid = ledgerEntries(dir).find((e) => e.kind === 'file_write').id;
    fs.writeFileSync(path.join(dir, '.polygraph', 'POLYGRAPH.md'), `# POLYGRAPH CONTRACT
${header}

## Sources
- P1 (2026-07-13T00:00:00Z): add a rate limiter → .polygraph/prompts/P1.txt

## Requirements
- [x] R1: add a rate limiter module (source: P1) [evidence: diff] → evidence: ${eid}
`, 'utf8');
    out = outJson(runHook(P.stop(SID, dir, true), dir).stdout);
    assert(out.systemMessage?.startsWith('✓ polygraph: 1/1'), `honest loop must PASS: ${JSON.stringify(out).slice(0, 160)}`);
    assert(/VERDICT: PASSED/.test(readReceipt(dir)), 'receipt says PASSED');

    // 5. Accumulation: P2 without header; new open item blocks until done
    const acc = outJson(runHook(P.userPrompt(SID, dir, 'also remove the deprecated v1 endpoints from the router'), dir).stdout);
    const ctx2 = acc.hookSpecificOutput.additionalContext;
    assert(/Contract P2 recorded/.test(ctx2) && !ctx2.includes('polygraph:v1'), 'P2 accumulates, no header re-issued');
    fs.appendFileSync(path.join(dir, '.polygraph', 'POLYGRAPH.md'),
      '- [ ] R2: remove deprecated v1 endpoints (source: P2) [evidence: diff]\n');
    out = outJson(runHook(P.stop(SID, dir, true), dir).stdout);
    assert(out.decision === 'block' && /R2/.test(out.reason), 'open accumulated item blocks');
    cleanup(dir);
  }, failures);

  step('config precedence: session global_mode overrides config.json overrides defaults (§13.4)', () => {
    const dir = makeSandbox({ '.polygraph/config.json': '{"v":1,"mode":"strict"}' }, {});
    runHook(P.sessionStart(SID, dir), dir);
    // config.json strict: an ambiguous item blocks
    fs.writeFileSync(path.join(dir, '.polygraph', 'POLYGRAPH.md'), `# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:${SID} created:t baseline:none -->

## Sources
- P1 (t): x → .polygraph/prompts/P1.txt

## Requirements
- [?] R1: make it nicer (source: P1) [evidence: manual] — needs clarification
`, 'utf8');
    let out = outJson(runHook(P.stop(SID, dir), dir).stdout);
    assert(out.decision === 'block', `strict from config.json blocks [?]: ${JSON.stringify(out).slice(0, 120)}`);
    // session-local off overrides the committed strict policy
    execFileSync(process.execPath, [path.join(process.cwd(), 'scripts', 'polygraph.mjs'), 'mode', 'off'], { cwd: dir });
    out = outJson(runHook(P.stop(SID, dir, true), dir).stdout);
    assert(out.decision === undefined && !out.systemMessage, 'session off is a total override');
    cleanup(dir);
  }, failures);

  return failures.length
    ? { pass: false, details: failures.join('\n') }
    : { pass: true, details: '2 sub-scenarios green (full capture→contract→gate loop; config precedence)' };
}
