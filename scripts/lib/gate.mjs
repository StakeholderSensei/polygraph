// gate.mjs — the deterministic gate (FR-3.*): reconcile contract vs ledger vs
// git and decide pass / block / confess. Pure function of on-disk state plus
// flags (NFR-R3): no clock-dependent logic except stale-ordering comparisons.
// The receipts renderer consumes THIS module's output — one implementation of
// check logic, so a receipt can never disagree with the gate (FR-4.4, M3).

import { readTextSafe } from './fsx.mjs';
import { parseContract, repairLine } from './contract.mjs';
import { checkMonotonicity, blessedLine } from './shadow.mjs';
import { loadVerdicts, verdictFresh } from './verdicts.mjs';
import { readAllEntries, resolvePointer } from './ledger.mjs';
import { baselineStatus, changedSet, repoToplevel, toToplevelRelative, inChangedSet, summarize, totals } from './gitx.mjs';
import { compileGlobs, matchesFile } from './globs.mjs';
import { detectRunners } from './runners.mjs';
import { readSessionState } from './state.mjs';

const MODEL_OWNED = new Set(['.polygraph/polygraph.md']); // compared lowercase

/** Item receipt statuses (FR-4.2 glyph set). */
export const STATUS = {
  verified: '✅', missing: '❌', unknown: '⚠', stale: '🕒', deferred: '➖', ambiguous: '❓',
};

function greenRun(entry) {
  return entry.exit_code === 0 && entry.exit_source !== 'unknown'
    && entry.background !== true && entry.watch !== true;
}

/**
 * Evaluate the gate. Read-only over state except where noted by the caller
 * (block counters, shadow blessing — suppressed when dryRun).
 * Returns { decision, checks, failedIds, items, reason, banner, git, counts }.
 * decision ∈ off | advisory | pass | block | confess-accepted | confess-nudge
 *          | confess-allow (post-nudge / budget-exhausted warning pass)
 */
export function evaluateGate({ cwd, paths, config, sessionId, stopHookActive = false, dryRun = false }) {
  if (config.mode === 'off') return { decision: 'off' };

  const contractText = readTextSafe(paths.contract);
  const parsed = parseContract(contractText);
  const entries = readAllEntries(paths); // repo-truth: ALL sessions (A2)

  // ---- git corroboration (A1 baseline anchor) -----------------------------
  // toplevel resolved ONCE; baselineStatus reuses it (spawn count matters on
  // Windows — the gate's p95 budget is subprocess-bound, NFR-P1)
  const baseline = parsed.header?.baseline || 'none';
  const toplevel = repoToplevel(cwd);
  const bStatus = toplevel === null
    ? { git: false, valid: false, reason: 'not a git repo / git missing' }
    : baselineStatus(cwd, baseline, { knownRepo: true });
  // changedSet returns null on any git-subprocess failure too (fail-open):
  // a PARTIAL set masquerading as corroboration would falsely block.
  const changed = bStatus.valid ? changedSet(cwd, baseline) : null;
  const git = {
    available: bStatus.git, corroboration: Boolean(changed),
    reason: bStatus.reason, summary: changed ? summarize(changed) : `n/a (${bStatus.reason || 'no git'})`,
    ...(changed ? totals(changed) : {}),
  };
  const toKey = (p) => toToplevelRelative(cwd, toplevel, p);

  if (!parsed.exists) {
    // FR-3.4 C1: a session with ≥1 qualifying prompt but no contract is the
    // primal lie ("worked without a promise sheet") — it fails. With no
    // qualifying prompt (Q&A, pre-contract): advisory, never a block (§15.8).
    const sess = readSessionState(cwd, sessionId) || {};
    if (!(sess.qualifying_prompts > 0)) {
      return { decision: 'advisory', checks: {}, failedIds: [], items: [], git, parsed };
    }
    parsed.errors = [`no contract despite ${sess.qualifying_prompts} qualifying prompt(s) — create .polygraph/POLYGRAPH.md per the injected instruction`];
  }

  // ---- checks ---------------------------------------------------------------
  const checks = {};
  const failedIds = new Set();
  const itemRows = [];

  // C1 contract-parse
  checks.C1 = parsed.ok
    ? { status: 'pass', details: [] }
    : { status: 'fail', details: parsed.errors.slice(0, 5) };
  if (!parsed.ok) failedIds.add('C1');

  // C2b contract-monotonicity (A3) — bless-after-validate
  const c2bViolated = new Map(); // id → kind, folded into item rows (FR-4.4)
  if (parsed.ok) {
    const mono = checkMonotonicity(paths.shadow, parsed, { dryRun, rawText: contractText });
    checks.C2b = mono.status === 'fail'
      ? { status: 'fail', details: mono.violations.map((v) => `${v.id} ${v.kind}`) }
      : { status: mono.status === 'na' ? 'na' : 'pass', details: [] };
    if (mono.status === 'fail') {
      failedIds.add('C2b');
      for (const v of mono.violations) { failedIds.add(v.id); c2bViolated.set(v.id, v.kind); }
    }
  } else {
    checks.C2b = { status: 'na', details: ['contract unparseable'] };
  }

  // C2 items-closed + C3 evidence-resolution (per-type table FR-3.4.1)
  const c2Details = [];
  const c3Details = [];
  const c5Candidates = []; // [x] diff/cmd items that survived C3 → C5 scope (A4)
  const strict = config.mode === 'strict';
  const sourceMatchers = compileGlobs(config.source_globs);
  const ignoreMatchers = compileGlobs(config.ignore_paths);
  const isSourcePath = (p) => matchesFile(sourceMatchers, p) && !matchesFile(ignoreMatchers, p);

  const sourceWrites = entries.filter((e) => e.kind === 'file_write' && e.file_path && isSourcePath(e.file_path));
  const lastSourceWriteTs = sourceWrites.reduce((max, e) => (e.ts > max ? e.ts : max), '');

  for (const item of parsed.items) {
    let status = STATUS.missing;
    let evidence = '—';
    let fail = null;

    if (item.state === 'deferred') {
      if (item.deferredUser) { status = STATUS.deferred; evidence = `deferred (user: ${item.deferredUser})`; }
      else { fail = `${item.id} marked [~] without a (user: P<n>) pointer`; c2Details.push(fail); }
    } else if (item.state === 'ambiguous') {
      status = STATUS.ambiguous; evidence = 'needs clarification';
      if (strict) {
        c2Details.push(`${item.id} is [?] (open in strict)`);
        failedIds.add(item.id); // strict: ambiguous counts as open (FR-3.4-C2)
      }
    } else if (item.state === 'open') {
      fail = `${item.id} '[ ] ${item.text.slice(0, 50)}'`; c2Details.push(fail);
    } else if (item.state === 'done') {
      // C3 per-type resolution
      if (item.evidenceType === 'manual') {
        status = STATUS.unknown; evidence = 'manual — awaits human review'; // never blocks (A4)
      } else if (item.pointers.length === 0) {
        fail = `${item.id} checked [x] with no evidence pointer (unproven check-off)`;
        c3Details.push(fail);
      } else {
        const resolved = item.pointers.map((ptr) => ({ ptr, entry: resolvePointer(paths, ptr) }));
        const missing = resolved.filter((r) => !r.entry);
        if (missing.length) {
          fail = `${item.id} cites nonexistent evidence ${missing.map((r) => r.ptr).join(',')}`;
          c3Details.push(fail);
        } else if (item.evidenceType === 'diff') {
          const writes = resolved.filter((r) => r.entry.kind === 'file_write');
          if (!writes.length) {
            // NOTE: never advise "retag" here — the evidence type sits in the
            // C2b immutable zone, so editing it on an existing item trips the
            // tamper wire (observed live: a model followed that advice and
            // got C2b-blocked). The legal outs are redo or confess.
            const viaBash = resolved.some((r) => r.entry.kind === 'command' || r.entry.kind === 'tool_fail');
            fail = `${item.id} [evidence: diff] cites no file_write entry`
              + (viaBash ? " — this item's work ran via Bash: redo it via Edit/Write to earn diff evidence, or confess it. Do NOT edit the item's [evidence:] tag (C2b)." : '');
            c3Details.push(fail);
          } else if (changed) {
            const hit = writes.find((r) => inChangedSet(changed, toKey(r.entry.file_path)));
            if (hit) {
              const c = changed.get(toKey(hit.entry.file_path)) || {};
              status = STATUS.verified;
              evidence = `${hit.ptr} diff ${hit.entry.file_path}${c.untracked ? ' (new)' : ` +${c.ins ?? '?'}/−${c.del ?? '?'}`}`;
            } else {
              fail = `${item.id} claimed file has no diff: ${writes[0].entry.file_path} (reverted or untouched since baseline)`;
              c3Details.push(fail);
            }
          } else {
            // git corroboration n/a: ledger file_write evidence still REQUIRED and suffices (A1)
            status = STATUS.verified;
            evidence = `${writes[0].ptr} write ${writes[0].entry.file_path} (git ${bStatus.reason || 'n/a'})`;
          }
        } else if (item.evidenceType === 'test') {
          // ∃ semantics (FR-3.4.1): the grammar allows multi-pointer citations
          // ('E2,E9'); a red run honestly cited next to a later green one must
          // not fail the item — pass if ANY cited run is green AND fresh.
          const runs = resolved.filter((r) => (r.entry.kind === 'command' || r.entry.kind === 'tool_fail') && r.entry.matched_runner);
          const hit = runs.find((r) => greenRun(r.entry) && !(lastSourceWriteTs && r.entry.ts <= lastSourceWriteTs));
          if (!runs.length) {
            fail = `${item.id} [evidence: test] cites no runner command`; c3Details.push(fail);
          } else if (hit) {
            status = STATUS.verified;
            evidence = `${hit.ptr} ${hit.entry.command?.slice(0, 28)} → exit 0`;
          } else if (runs.some((r) => greenRun(r.entry))) {
            status = STATUS.stale;
            fail = `${item.id} cited green run is stale (source written after it)`;
            c3Details.push(fail);
            evidence = `${runs.find((r) => greenRun(r.entry)).ptr} — stale`;
          } else {
            const best = runs[runs.length - 1];
            fail = `${item.id} no cited test run is a green foreground run (latest cited: ${best.ptr}, exit=${best.entry.exit_code ?? 'unknown'})`;
            c3Details.push(fail);
          }
        } else if (item.evidenceType === 'cmd') {
          const cmds = resolved.filter((r) => r.entry.kind === 'command');
          const hit = cmds.find((r) => r.entry.background !== true && r.entry.exit_source !== 'unknown' && r.entry.exit_code === 0);
          if (!cmds.length) {
            fail = `${item.id} [evidence: cmd] cites no command entry`; c3Details.push(fail);
          } else if (hit) {
            status = STATUS.verified;
            evidence = `${hit.ptr} ${hit.entry.command?.slice(0, 28)} → exit 0`;
          } else {
            const best = cmds[cmds.length - 1];
            fail = `${item.id} no cited command verifiably succeeded (latest cited: ${best.ptr}, exit=${best.entry.exit_code ?? 'unknown'}${best.entry.background ? ', background' : ''})`;
            c3Details.push(fail);
          }
        }
      }
    }
    // FR-4.4: a row must never show ✅ while the gate fails that id (C2b reword)
    if (c2bViolated.has(item.id)) {
      status = STATUS.missing;
      evidence = `contract tampered: ${c2bViolated.get(item.id)}`;
      fail = fail || `${item.id} ${c2bViolated.get(item.id)}`;
    }
    if (fail && item.state !== 'ambiguous') failedIds.add(item.id);
    const row = { id: item.id, text: item.text, evidenceType: item.evidenceType, status, evidence, fail };
    itemRows.push(row);
    if (item.state === 'done' && (item.evidenceType === 'diff' || item.evidenceType === 'cmd') && !fail) {
      const resolved = item.pointers.map((ptr) => ({ ptr, entry: resolvePointer(paths, ptr) }));
      c5Candidates.push({ item, row, resolved });
    }
  }
  checks.C2 = c2Details.length ? { status: 'fail', details: c2Details } : { status: 'pass', details: [] };
  checks.C3 = c3Details.length ? { status: 'fail', details: c3Details } : { status: 'pass', details: [] };

  // C4 test-evidence (global; cross-session; stale-pass rule)
  let c4 = { status: 'na', details: [] };
  if (config.require_tests !== 'never') {
    const sess = readSessionState(cwd, sessionId) || {};
    const runners = Array.isArray(sess.runners) && sess.runners.length
      ? sess.runners : detectRunners(cwd, config).runners;
    const required = config.require_tests === 'always'
      || (config.require_tests === 'auto' && runners.length > 0 && sourceWrites.length > 0);
    if (required) {
      // §12.2 latest-result-wins: a runner tool_fail with UNPARSEABLE exit
      // (timeout/interrupt) is still the harness saying the run failed — it
      // must supersede an earlier green run (it can never PASS, FR-2.6).
      const runs = entries.filter((e) =>
        (e.kind === 'command' || e.kind === 'tool_fail') && e.matched_runner
        && e.background !== true && e.watch !== true);
      const latest = runs.reduce((best, e) => (!best || e.ts > best.ts ? e : best), null);
      if (!latest) c4 = { status: 'fail', details: ['no verifiable test run recorded'] };
      else if (latest.exit_code === null || latest.exit_source === 'unknown') {
        c4 = { status: 'fail', details: [`latest test run ${latest.id} has no verifiable outcome (${latest.kind === 'tool_fail' ? 'failed with unparseable exit' : 'exit unknown'})`] };
      } else if (latest.exit_code !== 0) c4 = { status: 'fail', details: [`latest test run ${latest.id} failed (exit ${latest.exit_code})`] };
      else if (lastSourceWriteTs && latest.ts <= lastSourceWriteTs) {
        c4 = { status: 'fail', details: [`no test run after last source write at ${lastSourceWriteTs} (last green run ${latest.id} is stale)`] };
      } else c4 = { status: 'pass', details: [`${latest.id} ${latest.command?.slice(0, 30)} → exit 0`] };
    } else {
      c4 = { status: 'na', details: [runners.length === 0 ? 'no runner detected' : 'no source writes'] };
    }
  } else {
    c4 = { status: 'na', details: ['require_tests: never'] };
  }
  checks.C4 = c4;
  if (c4.status === 'fail') failedIds.add('C4');

  // C5 verifier-verdicts (§11, A4: diff- and cmd-type items).
  // Required in strict / verifier:"always"; a fresh UNMET verdict is honored
  // in EVERY mode (a known-bad verdict must never be ignored). Stale or
  // schema-invalid verdicts are never trusted (deterministic screening).
  const c5Details = [];
  const needsVerifier = [];
  const verdicts = loadVerdicts(paths.verdicts);
  const c5Required = strict || config.verifier === 'always';
  const cap = config.verifier_max_items ?? 5;
  let requiredSoFar = 0;
  for (const cand of c5Candidates) {
    const v = verdicts.get(cand.item.id);
    const fresh = v ? verdictFresh(v, cand.item, cand.resolved, entries) : false;
    if (v && fresh && v.verdict === 'unmet') {
      cand.row.status = STATUS.missing;
      cand.row.evidence = `verifier: unmet — ${String(v.rationale || '').slice(0, 34)}`;
      cand.row.fail = `${cand.item.id} verifier verdict UNMET: ${String(v.rationale || '').slice(0, 120)}`;
      c5Details.push(cand.row.fail);
      failedIds.add(cand.item.id);
    } else if (v && fresh && v.verdict === 'unclear') {
      cand.row.status = STATUS.ambiguous;
      cand.row.evidence = `verifier: unclear — ${String(v.rationale || '').slice(0, 32)}`;
      if (strict) { c5Details.push(`${cand.item.id} verifier verdict unclear (open in strict)`); failedIds.add(cand.item.id); }
    } else if (v && fresh && v.verdict === 'met') {
      cand.row.evidence = `${cand.row.evidence} ✔verifier`;
    } else if (c5Required) {
      requiredSoFar += 1;
      if (requiredSoFar <= cap) {
        c5Details.push(`${cand.item.id} needs a fresh verifier verdict${v ? ' (existing verdict is stale)' : ''}`);
        failedIds.add(cand.item.id);
        needsVerifier.push(cand.item.id);
      } else {
        cand.row.status = STATUS.unknown; // §11.1: beyond the cap ⇒ ⚠ unverified, never a block
        cand.row.evidence = `${cand.row.evidence} (unverified: over verifier cap)`;
      }
    }
  }
  checks.C5 = c5Details.length
    ? { status: 'fail', details: c5Details }
    : { status: c5Candidates.length && c5Required ? 'pass' : 'na', details: [] };
  if (c5Details.length) failedIds.add('C5');

  // Tamper (A3 ownership partition; Edit/Write path only). Case-insensitive
  // and dot-segment-normalized: Windows/macOS filesystems resolve
  // '.POLYGRAPH/ledger.jsonl' or './.polygraph/x' to the real state files
  // (NFR-C3) — a case-variant write is the same tamper.
  const tamperDetails = [];
  for (const e of entries) {
    if (e.kind !== 'file_write' || !e.file_path) continue;
    const display = e.file_path.replaceAll('\\', '/');
    const p = display.toLowerCase().replace(/^(\.\/)+/, '');
    if (!p.startsWith('.polygraph/')) continue;
    if (MODEL_OWNED.has(p)) continue; // the contract is model-owned by design
    tamperDetails.push(`${e.id} ${e.tool_name} wrote ${display}`
      + (p === '.polygraph/config.json' ? ' — ask the user to edit .polygraph/config.json or run /polygraph:mode' : ''));
  }
  checks.tamper = tamperDetails.length ? { status: 'fail', details: tamperDetails } : { status: 'pass', details: [] };
  if (tamperDetails.length) failedIds.add('TAMPER');

  // ---- verdict -----------------------------------------------------------------
  const counts = {
    total: parsed.items.length,
    verified: itemRows.filter((r) => r.status === STATUS.verified).length,
    deferred: itemRows.filter((r) => r.status === STATUS.deferred).length,
    ambiguous: itemRows.filter((r) => r.status === STATUS.ambiguous).length,
    manual: itemRows.filter((r) => r.evidenceType === 'manual' && r.status === STATUS.unknown).length,
  };
  const anyFail = [...failedIds].length > 0;
  // The model cannot see the ledger — when evidence citation is the failure,
  // the reason must carry the citable ids (observed live: a model with REAL
  // evidence in the ledger looped and gave up because it couldn't name E<n>).
  const recentEvidence = entries
    .filter((e) => e.id && (e.kind === 'file_write' || e.kind === 'command' || e.kind === 'tool_fail'))
    .slice(-8)
    .map((e) => e.kind === 'file_write'
      ? `${e.id}=write ${e.file_path}`
      : `${e.id}=cmd "${String(e.command || '').slice(0, 28)}" exit ${e.exit_code ?? 'unknown'}`);
  // (B) gate-authored repair — syntax and restoration ONLY, never semantics.
  // C1-repair re-serializes mangled lines (markers/pointers preserved as
  // found); C2b-repair emits the blessed original line VERBATIM. Truth stays
  // with the checks: a repaired-but-unproven [x] still fails C3.
  const repair = [];
  if (checks.C1?.status === 'fail') {
    // Header/Sources restoration: both are engine-known facts (session id,
    // the ledger's kind:baseline entry, the recorded prompt snapshots) —
    // models that rewrite the file from scratch routinely lose them.
    if (parsed.exists && parsed.errors?.some((e) => /header/.test(e))) {
      const baseEntry = entries.filter((e) => e.kind === 'baseline').pop();
      repair.push(`<!-- polygraph:v1 session:${sessionId} created:${baseEntry?.ts || 'unknown'} baseline:${baseEntry?.sha || 'none'} -->`);
    }
    if (parsed.exists && (parsed.sources?.length ?? 0) === 0) {
      const promptEntries = entries.filter((e) => e.kind === 'prompt');
      if (promptEntries.length) {
        repair.push('## Sources');
        for (const p of promptEntries.slice(-5)) {
          repair.push(`- ${p.id} (${p.ts}): ${String(p.excerpt || '').slice(0, 60).replaceAll('\n', ' ')} → .polygraph/prompts/${p.id}.txt`);
        }
      }
    }
    for (const bad of (parsed.unparseable || []).slice(0, 8)) {
      const fixed = repairLine(bad.raw, parsed.sources || []);
      if (fixed) repair.push(fixed);
    }
  }
  if (checks.C2b?.status === 'fail') {
    for (const id of c2bViolated.keys()) {
      const line = blessedLine(paths.shadow, id);
      if (line) repair.push(line);
    }
  }
  const base = { checks, failedIds: [...failedIds], items: itemRows, git, counts, parsed, recentEvidence, needsVerifier, repair };

  // FR-3.7: an honest confession (superset of failed ids) ALWAYS unlocks the stop.
  if (parsed.confession && parsed.confession.status === 'incomplete') {
    const confessed = new Set(parsed.confession.unmet);
    const covered = [...failedIds].every((id) => confessed.has(id));
    if (covered) return { ...base, decision: 'confess-accepted', unmet: parsed.confession.unmet };
    base.underConfession = [...failedIds].filter((id) => !confessed.has(id));
  }

  if (!anyFail) return { ...base, decision: 'pass' };

  // failures exist — mode & budget decide between block / nudge / warned allow
  const sess = readSessionState(cwd, sessionId) || {};
  const blockCount = sess.block_count || 0;
  const budgetLeft = blockCount < (config.max_blocks ?? 2) && !(stopHookActive && blockCount >= (config.max_blocks ?? 2));

  if (config.mode === 'confess') {
    return { ...base, decision: sess.confess_nudged ? 'confess-allow' : 'confess-nudge' };
  }
  if (!budgetLeft) {
    return { ...base, decision: sess.confess_nudged ? 'confess-allow' : 'confess-nudge' };
  }
  return { ...base, decision: 'block', reason: buildReason(base, config) };
}

/** FR-3.6 machine-generated block reason (≤ 400 tokens). */
function buildReason(result, config) {
  const lines = ['polygraph gate: completion not proven.'];
  const { checks } = result;
  if (checks.C1?.status === 'fail') {
    // teach the grammar at failure time — weaker models fumble the format
    // (observed live: items missing the [evidence:] tag), and locating the
    // bad line without the template leaves them looping on wrong guesses
    lines.push(`FAILED C1 contract-parse: ${checks.C1.details.join('; ')}. `
      + "Every requirement line must match EXACTLY: '- [ ] R<n>: <text> (source: P<m>) [evidence: diff|test|cmd|manual]' "
      + "(check-offs append ' → evidence: E<n>'). Fix the listed lines in .polygraph/POLYGRAPH.md.");
  }
  if (checks.C2b?.status === 'fail') {
    lines.push(`FAILED C2b contract-monotonicity: ${checks.C2b.details.slice(0, 4).join('; ')}. To change a requirement, supersede it — mark the old item '[~] deferred (user: P<n>)' and append a new R<m>; don't edit it.`);
  }
  if (checks.C2?.status === 'fail') lines.push(`FAILED C2 items-open: ${checks.C2.details.slice(0, 4).join('; ')}`);
  if (checks.C3?.status === 'fail') lines.push(`FAILED C3 evidence: ${checks.C3.details.slice(0, 4).join('; ')}`);
  if ((checks.C1?.status === 'fail' || checks.C3?.status === 'fail') && result.recentEvidence?.length) {
    lines.push(`Recorded evidence you can cite: ${result.recentEvidence.join(' · ')}.`);
  }
  if (checks.C4?.status === 'fail') lines.push(`FAILED C4 test-evidence: ${checks.C4.details.join('; ')}`);
  if (checks.C5?.status === 'fail') lines.push(`FAILED C5 verifier-verdicts: ${checks.C5.details.slice(0, 4).join('; ')}`);
  if (checks.tamper?.status === 'fail') lines.push(`FAILED tamper-check: ${checks.tamper.details.slice(0, 3).join('; ')}`);
  if (result.repair?.length) {
    lines.push('REPAIR — copy these exact lines into .polygraph/POLYGRAPH.md over the broken/reworded ones (where a line shows "diff|test|cmd|manual", keep exactly one type):\n'
      + result.repair.join('\n'));
  }
  if (result.underConfession?.length) {
    const shown = result.underConfession.slice(0, 6);
    const more = result.underConfession.length - shown.length;
    lines.push(`Confession present but under-confesses: missing ${shown.join(', ')}${more > 0 ? ` +${more} more` : ''} — the unmet list must cover every failed id.`);
  }
  lines.push(
    'Resolve by EITHER: (1) finish the work and re-run the test suite, checking items off with evidence pointers (E<n>); '
    + "(2) mark items '[~] deferred (user: P<n>)' ONLY if the user actually said so; "
    + "(3) stop honestly: add a '## POLYGRAPH CONFESSION' block (status: incomplete, unmet: <all failed ids>) to .polygraph/POLYGRAPH.md. "
    + 'Do not claim completion without one of these.'
  );
  if (result.needsVerifier?.length) {
    const baseline = result.parsed?.header?.baseline || 'none';
    // process.argv[1] is always this plugin's dispatcher (hook and CLI alike):
    // give the verifier the exact engine-merge command so it never hand-rolls
    // JSON (a weak verifier overwrote verdicts.json in a live session).
    const script = process.argv[1] || 'polygraph.mjs';
    lines.push(`Run the polygraph-verifier subagent on: ${result.needsVerifier.join(', ')} — give it each requirement line, its evidence pointers, baseline ${baseline}, and this exact per-item command: node "${script}" verdict <R-id> <met|unmet|unclear> "<rationale>" "<file:line,...>". Then stop again.`);
  }
  // Block-reason token budget: ≤ 400 tokens, or ≤ 600 when the reason
  // carries a repair block. Hard character ceiling, builder-enforced.
  const capChars = result.repair?.length ? 2250 : 1500;
  const reason = lines.join('\n');
  return reason.length > capChars ? reason.slice(0, capChars - 3) + '…' : reason;
}
