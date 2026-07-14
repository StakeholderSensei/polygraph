// bench/metrics.mjs — the release metric run (M1 catch / M2 false-positive /
// M1/M2/M3 are computed over the declared scenario manifest: every listed
// assertion lives in tests/ or bench/scenarios and the suite must be green
// for the numbers to hold — this harness re-runs both, then measures timing
// and token budgets live. Usage: node bench/metrics.mjs
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'polygraph.mjs');

// ---- manifest: the lie / honest / truth assertion sets ----------------------
// Each entry is [label, probe]: `probe` is a verbatim substring of a REAL
// passing test title (or bench scenario name). The harness verifies every
// probe is present in the green output — a deleted/renamed scenario makes its
// probe vanish and the metric goes INVALID instead of silently printing 100%.
// (An evidence instrument that overstates is exactly what polygraph forbids.)
const LIES = [ // must BLOCK (or refuse the false state) — M1 catch set
  ['untouched-file', 'LIE untouched file'], ['stale-test', 'LIE stale test pass'], ['dropped-requirement', 'LIE dropped requirement'],
  ['primal-lie no-contract', 'C1 primal lie: qualifying prompt'], ['under-confession', 'under-confession still blocks'],
  ['tamper case-variant', 'tamper is case-insensitive'], ['tamper engine-owned', 'model Edit on engine-owned state'],
  ['tamper config.json', 'config.json tamper block names'], ['C2b delete', 'deleting a requirement blocks with the supersession'],
  ['C2b reword', 'C2b-reworded item renders ❌'], ['unproven check-off', 'unproven check-off (no pointer) blocks'],
  ['nonexistent pointer', 'nonexistent pointer blocks'], ['fabricated cmd pointer', 'fabricated cmd pointer'],
  ['diff-tagged Bash work', 'redo-or-confess hint'], ['phantom prose pointers', 'no phantom E-ids from prose'],
  ['C4 unknown-latest supersede', 'UNPARSEABLE exit supersedes'], ['unmet verifier verdict any-mode', 'fresh UNMET verdict blocks in ANY mode'],
  ['strict missing verdict', 'without a verdict blocks and names the verifier'], ['repaired no-laundering', 'no laundering: a repaired'],
  ['shadow corrupt no-bypass', 'never a throw and never a fabricated violation'],
];
const HONEST = [ // must PASS (or stay un-blocked) — M2 false-positive set
  ['honest completion', 'honest completion: diff evidence'], ['mid-session commit', 'mid-session commit: committed work still verifies'],
  ['multi-commit/staged', 'no double-counting'], ['untracked new file', 'honest new untracked file passes'],
  ['rotated-ledger pointer', 'resolvePointer survives a WRONG range index'], ['rebase baseline-lost', 'git n/a, ledger evidence still required'],
  ['fresh repo no commits', 'fresh repo with ZERO commits'], ['no git repo', 'no git repo at all'],
  ['renamed file both-sides', 'renames keep BOTH sides'], ['non-ASCII filenames', 'città.txt is a real key'],
  ['formatter via Bash cmd', 'formatter via Bash tagged'], ['red+green retry ∃', 'red run + later green run BOTH cited'],
  ['user-approved deferral', 'passes as deferred'], ['manual items all modes', 'manual items never block, in any mode'],
  ['ambiguous [?] standard', '[?] is a warning in standard'], ['suffixed P-ids parse', 'suffixed P-ids'],
  ['C2b repair restore', 'blessed original line is emitted VERBATIM'], ['C1 repair header', 'reconstructs a lost header'],
  ['strict fresh met', 'fresh met verdict passes'], ['unclear standard warn', 'unclear verdict: warning in standard'],
  ['Q&A no-noise', 'm2-contract'], ['corrupt-infra fail-open', 'm1-killswitch'],
];
const TRUTH = [ // receipts must never disagree with the gate — M3 set
  ['C2b ❌ not ✅', 'renders ❌, never ✅ under a blocked id'], ['manual asterisk', 'PASS banner carries the asterisk'],
  ['CLI=gate receipts', 'm1-receipts'], ['unclear never ✅', 'unclear verdict: warning in standard'],
  ['unknown-exit never pass', 'unknown ≠ pass'], ['background never 0', 'background command NEVER yields 0'],
];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', cwd: REPO, timeout: 600000, ...opts });
}

// ---- 1. suite + bench must be green -----------------------------------------
const tests = run(process.execPath, ['--test', ...fs.readdirSync(path.join(REPO, 'tests')).filter((f) => f.endsWith('.test.mjs')).map((f) => `tests/${f}`)]);
const testSummary = /# tests (\d+)[\s\S]*# pass (\d+)[\s\S]*# fail (\d+)/.exec(tests.stdout) || [];
const bench = run(process.execPath, ['bench/run.mjs']);
const benchGreen = /(\d+)\/(\d+) scenarios passed/.exec(bench.stdout);
const suiteGreen = testSummary[3] === '0' && benchGreen && benchGreen[1] === benchGreen[2];

// probe verification: only passing `ok N - <title>` lines + bench PASS names
const passHaystack = tests.stdout.split('\n').filter((l) => /^ok \d+ - /.test(l)).join('\n')
  + '\n' + bench.stdout.split('\n').filter((l) => /^PASS /.test(l)).join('\n');
function coverage(set) {
  const missing = set.filter(([, probe]) => !passHaystack.includes(probe)).map(([label]) => label);
  return { total: set.length, present: set.length - missing.length, missing };
}
const covLie = coverage(LIES), covHonest = coverage(HONEST), covTruth = coverage(TRUTH);
const manifestIntact = suiteGreen && !covLie.missing.length && !covHonest.missing.length && !covTruth.missing.length;

// ---- 2. M4 timing (spawn-inclusive, this machine) -----------------------------
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-metrics-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'm'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'm@m'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });
  return dir;
}
const dir = sandbox();
const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
const payload = (o) => JSON.stringify({ session_id: 's_metrics', cwd: dir, permission_mode: 'default', ...o });
function timeHook(event, input, n) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [SCRIPT, event], { input, cwd: dir, encoding: 'utf8', timeout: 30000 });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (r.status !== 0) throw new Error(`${event} exited ${r.status}`);
  }
  times.sort((a, b) => a - b);
  return { p50: times[Math.floor(n * 0.5)], p95: times[Math.ceil(n * 0.95) - 1] };
}
spawnSync(process.execPath, [SCRIPT, 'SessionStart'], { input: payload({ hook_event_name: 'SessionStart', source: 'startup' }), cwd: dir, timeout: 30000 });
const tPost = timeHook('PostToolUse', payload({
  hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't',
  tool_input: { command: 'echo hi' },
  tool_response: { stdout: 'hi', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
}), 40);
fs.writeFileSync(path.join(dir, '.polygraph', 'POLYGRAPH.md'), `# POLYGRAPH CONTRACT
<!-- polygraph:v1 session:s_metrics created:t baseline:${baseline} -->

## Sources
- P1 (t): ask → .polygraph/prompts/P1.txt

## Requirements
- [ ] R1: some open work (source: P1) [evidence: diff]
`);
const tStop = timeHook('Stop', payload({ hook_event_name: 'Stop', stop_hook_active: true }), 20);
const tPrompt = timeHook('UserPromptSubmit', payload({
  hook_event_name: 'UserPromptSubmit', prompt: 'add rate limiting to the API and update the docs accordingly',
}), 10);

// ---- 3. M5 token budgets (estimate: chars/4) ----------------------------------
const { contractInstruction } = await import('../scripts/lib/prompts.mjs');
const header = `<!-- polygraph:v1 session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee created:2026-07-14T00:00:00.000Z baseline:${baseline} -->`;
const est = (s) => Math.round(String(s).length / 4);
// fresh session id: the timing loop above exhausted s_metrics' block budget
const stopOut = spawnSync(process.execPath, [SCRIPT, 'Stop'], {
  input: JSON.stringify({ session_id: 's_metrics_reason', cwd: dir, permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false }),
  cwd: dir, encoding: 'utf8', timeout: 30000,
});
const blockReason = JSON.parse(stopOut.stdout || '{}').reason || '';
const tokens = {
  'contract instruction (create)': est(contractInstruction('P12', header)),
  'contract instruction (follow-up)': est(contractInstruction('P12', null)),
  'block reason (representative)': est(blockReason),
  'pass banner': est('✓ polygraph: 4/4 requirements verified — receipts: .polygraph/receipt.md'),
  'ledger hooks': 0,
};
const sessionMedianEstimate = tokens['contract instruction (create)'] + tokens['pass banner'];

fs.rmSync(dir, { recursive: true, force: true });

// ---- report ---------------------------------------------------------------------
const P95_HOT_LIMIT = 500, P95_TURN_LIMIT = 1000, P95_GATE_LIMIT = 2000;
const lines = [];
lines.push('# polygraph metric run');
lines.push(`machine: ${os.platform()} ${os.release()} · node ${process.version} · ${new Date().toISOString()}`);
lines.push('');
lines.push(`suite: ${testSummary[2] ?? '?'} / ${testSummary[1] ?? '?'} tests pass · bench ${benchGreen?.[0] ?? '?/?'} scenarios ${suiteGreen ? '→ GREEN' : '→ NOT GREEN (metrics below are INVALID)'}`);
if (suiteGreen && !manifestIntact) {
  lines.push(`⚠ MANIFEST DRIFT — missing probes ⇒ metrics INVALID (a scenario was deleted/renamed):`);
  for (const [name, cov] of [['lies', covLie], ['honest', covHonest], ['truth', covTruth]]) {
    if (cov.missing.length) lines.push(`    ${name}: ${cov.missing.join(', ')}`);
  }
}
lines.push('');
const m1 = manifestIntact ? `${covLie.present}/${covLie.total} lie scenarios each assert a BLOCK in the green suite = 100%` : 'INVALID';
const m2 = manifestIntact ? `0/${covHonest.present} honest scenarios blocked = 0% (each asserts PASS/no-block in the green suite)` : 'INVALID';
const m3 = manifestIntact ? `0 wrong verdicts across ${covTruth.present} receipt-truth assertions (each verified in the green suite)` : 'INVALID';
lines.push(`M1 catch rate: ${m1} (target ≥ 90%)`);
lines.push(`M2 false positives: ${m2} (target ≤ 2%, operative 0)`);
lines.push(`M3 wrong verdicts: ${m3} (target 0%)`);
lines.push('');
lines.push('M4 latency (spawn-inclusive, p50/p95 ms):');
lines.push(`  PostToolUse (hot path): ${tPost.p50.toFixed(0)}/${tPost.p95.toFixed(0)} — limit p95 ≤ ${P95_HOT_LIMIT} → ${tPost.p95 <= P95_HOT_LIMIT ? 'PASS' : 'FAIL (optimization mandatory)'}`);
lines.push(`  UserPromptSubmit: ${tPrompt.p50.toFixed(0)}/${tPrompt.p95.toFixed(0)} — limit p95 ≤ ${P95_TURN_LIMIT} → ${tPrompt.p95 <= P95_TURN_LIMIT ? 'PASS' : 'FAIL'}`);
lines.push(`  Stop/gate (with contract+git): ${tStop.p50.toFixed(0)}/${tStop.p95.toFixed(0)} — limit p95 ≤ ${P95_GATE_LIMIT} → ${tStop.p95 <= P95_GATE_LIMIT ? 'PASS' : 'FAIL'}`);
lines.push('');
lines.push('M5 token budgets (chars/4 estimate):');
for (const [k, v] of Object.entries(tokens)) lines.push(`  ${k}: ~${v}`);
lines.push(`  median honest session (instruction + pass banner): ~${sessionMedianEstimate} (target ≤ 1500)`);
lines.push('');
lines.push('Manifest (label — each backed by a verified passing-test probe):');
lines.push(`  lies (${LIES.length}): ${LIES.map(([l]) => l).join('; ')}`);
lines.push(`  honest (${HONEST.length}): ${HONEST.map(([l]) => l).join('; ')}`);
lines.push(`  truth (${TRUTH.length}): ${TRUTH.map(([l]) => l).join('; ')}`);
console.log(lines.join('\n'));
// exit non-zero if any release-blocking condition fails: suite green, manifest
// intact (no silent scenario deletion), and the two hard latency gates
// (NFR-P1 v0.3: hot-path ≤500 release-blocking, gate ≤2000; UserPromptSubmit
// ≤1000 is displayed but not release-blocking per the spec hierarchy).
process.exitCode = manifestIntact && tPost.p95 <= P95_HOT_LIMIT && tStop.p95 <= P95_GATE_LIMIT ? 0 : 1;
