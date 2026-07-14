#!/usr/bin/env node
// polygraph.mjs — single entry point for every polygraph hook (FR-0.1).
// Dispatch is driven by stdin's hook_event_name (argv[2] is only a hint /
// CLI subcommand selector). FR-0.4: any internal error exits 0 with a
// systemMessage — polygraph never blocks on its own failure and never
// emits exit code 2.

import { Buffer } from 'node:buffer';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  ensureStateDir,
  statePaths,
  loadConfig,
  readSessionState,
  updateSessionState,
  ensureGitignore,
  setMode,
} from './lib/state.mjs';
import { appendEntry, SESSION_ENTRY_CAP } from './lib/ledger.mjs';
import { detectRunners, matchRunner } from './lib/runners.mjs';
import { deriveBashExit } from './lib/exitcode.mjs';
import { atomicWriteJson, structureOf, statSafe } from './lib/fsx.mjs';
import { evaluateGate } from './lib/gate.mjs';
import { writeReceipt } from './lib/receipts.mjs';
import { shouldSkipPrompt, sha256, contractInstruction } from './lib/prompts.mjs';
import { parseContract } from './lib/contract.mjs';
import { headSha } from './lib/gitx.mjs';
import { nextId } from './lib/counters.mjs';
import { LEDGER_NAME } from './lib/ledger.mjs';
import { atomicWriteFile, readTextSafe } from './lib/fsx.mjs';

const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const WATCHDOG_MS = 8000; // own watchdog below hooks.json timeout (FR-0.5)

const argHint = process.argv[2] || '';

// --- CLI subcommands (no stdin; used by skills and dev tooling) -------------
if (argHint === 'version') {
  process.stdout.write('polygraph 0.1.0-m1\n');
  process.exit(0);
}
if (argHint === 'verdict') {
  // Engine-serialized verdict merge: the verifier subagent calls this once
  // per item instead of hand-rolling JSON (observed live: a weak verifier
  // OVERWROTE verdicts.json and lost a sibling verdict). Trust semantics
  // unchanged — verdicts stay model-initiated, deterministically screened.
  try {
    const [item, verdict, rationale = '', evidenceCsv = ''] = process.argv.slice(3);
    if (!/^R\d+$/.test(item || '') || !['met', 'unmet', 'unclear'].includes(verdict)) {
      process.stdout.write('usage: polygraph verdict <R<n>> <met|unmet|unclear> "<rationale>" "<evidence,csv>"\n');
      process.exit(0);
    }
    const paths = ensureStateDir(process.cwd());
    const { readJsonSafe } = await import('./lib/fsx.mjs');
    const data = readJsonSafe(paths.verdicts);
    const verdicts = (data && Array.isArray(data.verdicts) ? data.verdicts : []).filter((v) => v?.item !== item);
    verdicts.push({
      item, verdict, rationale: String(rationale).slice(0, 300),
      evidence: String(evidenceCsv).split(',').map((s) => s.trim()).filter(Boolean),
      model: 'polygraph-verifier', ts: new Date().toISOString(),
    });
    atomicWriteJson(paths.verdicts, { v: 1, verdicts });
    process.stdout.write(`polygraph: verdict recorded — ${item} ${verdict}\n`);
    process.exit(0);
  } catch (err) {
    process.stdout.write(`polygraph: internal error — verdict failed (${err?.message || 'unknown'})\n`);
    process.exit(0);
  }
}
if (argHint === 'receipts' || argHint === 'gate' || argHint === 'mode') {
  const cliCwd = process.cwd();
  try {
    if (argHint === 'mode') {
      const value = process.argv[3];
      const repo = process.argv.includes('--repo');
      const valid = ['off', 'standard', 'strict', 'confess'];
      const mode = value === 'on' || value === undefined ? 'standard' : value;
      if (!valid.includes(mode)) {
        process.stdout.write(`polygraph: unknown mode '${value}' (valid: ${valid.join(', ')})\n`);
        process.exit(0);
      }
      process.stdout.write(setMode(cliCwd, mode, { repo }) + '\n');
      process.exit(0);
    }
    const config = loadConfig(cliCwd, null);
    if (config.mode === 'off') {
      process.stdout.write('polygraph is off for this repo — /polygraph:on to re-enable.\n');
      process.exit(0);
    }
    const paths = ensureStateDir(cliCwd);
    // The CLI has no session of its own: borrow the most recent session that
    // recorded qualifying prompts, so the primal-lie state (prompts recorded,
    // no contract) renders as C1-failed instead of a misleading ADVISORY.
    const sessFile = (await import('./lib/fsx.mjs')).readJsonSafe(paths.session);
    const cliSession = Object.entries(sessFile?.sessions ?? {})
      .filter(([, s]) => (s.qualifying_prompts || 0) > 0)
      .sort(([, a], [, b]) => String(b.started_at || '').localeCompare(String(a.started_at || '')))[0]?.[0] ?? 'cli';
    const evaluation = evaluateGate({ cwd: cliCwd, paths, config, sessionId: cliSession, dryRun: true });
    if (argHint === 'gate') {
      const summary = {
        decision: evaluation.decision,
        failed: evaluation.failedIds || [],
        checks: Object.fromEntries(Object.entries(evaluation.checks || {}).map(([k, v]) => [k, v.status])),
      };
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      process.exit(0);
    }
    const sessions = Object.values((await import('./lib/fsx.mjs')).readJsonSafe(paths.session)?.sessions ?? {});
    const table = writeReceipt(paths, evaluation, {
      sessionId: 'current', ts: new Date().toISOString().slice(0, 16).replace('T', ' '),
      mode: config.mode, blockCount: sessions.reduce((n, s) => n + (s.block_count || 0), 0),
      runner: sessions.flatMap((s) => s.runners || []).filter((v, i, a) => a.indexOf(v) === i).join(',') || 'auto',
    });
    process.stdout.write(table + '\n');
    process.exit(0);
  } catch (err) {
    process.stdout.write(`polygraph: internal error — ${argHint} failed (${err?.message || 'unknown'})\n`);
    process.exit(0);
  }
}

// --- hook dispatch ---------------------------------------------------------
const watchdog = setTimeout(() => {
  emit({ systemMessage: 'polygraph: internal error — hook timed out reading input' });
}, WATCHDOG_MS);

function emit(output) {
  clearTimeout(watchdog);
  if (output && Object.keys(output).length > 0) {
    // Synchronous write to fd 1: on Windows a piped stdout is async, and an
    // immediate process.exit after stdout.write can truncate the JSON the
    // harness is about to parse. writeSync flushes before we exit — and emit
    // must never return (callers rely on it terminating the flow).
    try { fsSync.writeSync(1, JSON.stringify(output)); } catch { /* stdout gone */ }
  }
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** Absolute → repo-relative with forward slashes (NFR-C3). */
function normalizePath(filePath, cwd) {
  if (!filePath) return null;
  let p = filePath;
  if (path.isAbsolute(p)) {
    const rel = path.relative(cwd, p);
    p = rel.startsWith('..') ? p : rel;
  }
  return p.replaceAll('\\', '/');
}

function byteLen(str) {
  return typeof str === 'string' ? Buffer.byteLength(str, 'utf8') : 0;
}

function writtenBytes(toolName, toolInput = {}) {
  switch (toolName) {
    case 'Write': return byteLen(toolInput.content);
    case 'Edit': return byteLen(toolInput.new_string);
    case 'MultiEdit':
      return Array.isArray(toolInput.edits)
        ? toolInput.edits.reduce((sum, e) => sum + byteLen(e?.new_string), 0)
        : 0;
    case 'NotebookEdit': return byteLen(toolInput.new_source);
    default: return 0;
  }
}

/** FR-2.11 per-session entry accounting. Returns true when this kind may be recorded. */
function admitEntry(cwd, sessionId, kind) {
  const sess = readSessionState(cwd, sessionId) || {};
  const count = sess.entry_count || 0;
  const admitted = count < SESSION_ENTRY_CAP || kind === 'command' || kind === 'file_write';
  updateSessionState(cwd, sessionId, {
    entry_count: count + 1,
    ...(admitted ? {} : { dropped: (sess.dropped || 0) + 1 }),
  });
  return admitted;
}

// --- handlers ---------------------------------------------------------------

function onSessionStart(input, ctx) {
  const { cwd, paths, config, sessionId } = ctx;
  ensureStateDir(cwd);
  ensureGitignore(cwd);
  const detection = detectRunners(cwd, config);
  appendEntry(paths, null, {
    kind: 'session_start',
    session_id: sessionId,
    source: input.source ?? null,
    cwd: cwd.replaceAll('\\', '/'),
  });
  updateSessionState(cwd, sessionId, {
    started_at: new Date().toISOString(),
    source: input.source ?? null,
    runners: detection.runners,
    runner_source: detection.source,
    entry_count: 0,
    dropped: 0,
    node_ok: true,
  });
  // FR-2.10 resume reminder: open contract items survive the session boundary
  if (input.source === 'resume') {
    const parsed = parseContract(readTextSafe(paths.contract));
    if (parsed.exists && parsed.ok) {
      const open = parsed.items.filter((i) => i.state === 'open' || i.state === 'ambiguous');
      if (open.length) {
        const list = open.slice(0, 5).map((i) => `${i.id} (${i.state === 'open' ? 'open' : '[?]'})`).join(', ');
        return {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: `[polygraph] Resumed session has an open contract: ${list}${open.length > 5 ? ` +${open.length - 5} more` : ''}. See .polygraph/POLYGRAPH.md.`,
          },
        };
      }
    }
  }
  return {};
}

function onUserPromptSubmit(input, ctx) {
  const { cwd, paths, config, sessionId } = ctx;
  const { skip } = shouldSkipPrompt(input.prompt, config);
  if (skip) return {}; // Q&A/slash/short prompts never create contracts (§15.2)

  const prompt = String(input.prompt);
  const { id } = nextId(paths, 'p', LEDGER_NAME);
  atomicWriteFile(path.join(paths.promptsDir, `${id}.txt`), prompt);
  appendEntry(paths, null, {
    kind: 'prompt', id, session_id: sessionId,
    sha256: sha256(prompt), chars: prompt.length, excerpt: prompt.slice(0, 400),
  });
  const sess = readSessionState(cwd, sessionId) || {};
  updateSessionState(cwd, sessionId, {
    qualifying_prompts: (sess.qualifying_prompts || 0) + 1,
    advisory: false,
  });

  // A1: the baseline is anchored at contract creation. The hook computes the
  // sha and hands the model the EXACT header line — a model-invented header
  // would either fail C1 or anchor the diff range wrong.
  let headerLine = null;
  if (!statSafe(paths.contract)) {
    const sha = headSha(cwd) ?? 'none';
    appendEntry(paths, null, { kind: 'baseline', session_id: sessionId, sha });
    updateSessionState(cwd, sessionId, { baseline: sha });
    headerLine = `<!-- polygraph:v1 session:${sessionId} created:${new Date().toISOString()} baseline:${sha} -->`;
  }
  return {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: contractInstruction(id, headerLine),
    },
  };
}

function onPostToolUse(input, ctx) {
  const { cwd, paths, config, sessionId } = ctx;
  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};

  if (FILE_WRITE_TOOLS.has(toolName)) {
    if (!admitEntry(cwd, sessionId, 'file_write')) return {};
    appendEntry(paths, 'e', {
      kind: 'file_write',
      session_id: sessionId,
      tool_use_id: input.tool_use_id ?? null,
      tool_name: toolName,
      file_path: normalizePath(toolInput.file_path || toolInput.notebook_path, cwd),
      bytes: writtenBytes(toolName, toolInput),
    });
    return {};
  }

  if (toolName === 'Bash') {
    const sess = readSessionState(cwd, sessionId) || {};

    // FR-2.5 shape probe: first Bash event of the session records the
    // keys-only structure of tool_response for empirical Q1 resolution.
    if (!sess.probe_done) {
      try {
        atomicWriteJson(path.join(paths.debugDir, 'tool_response_shape.json'), {
          captured_at: new Date().toISOString(),
          session_id: sessionId,
          hook_event: 'PostToolUse',
          tool_name: toolName,
          input_keys: Object.keys(input).sort(),
          tool_response_shape: structureOf(input.tool_response),
        });
      } catch { /* probe is best-effort */ }
      updateSessionState(cwd, sessionId, { probe_done: true });
    }

    const extraction = deriveBashExit({
      event: 'PostToolUse',
      toolResponse: input.tool_response,
      background: toolInput.run_in_background === true,
      cachedStrategy: sess.exit_code_strategy || null,
    });
    // Cache only ladder strategies (key:*/text) — event-derived outcomes are
    // not tool_response parse strategies.
    if (extraction.strategy && extraction.strategy !== 'harness_event'
        && extraction.strategy !== sess.exit_code_strategy) {
      updateSessionState(cwd, sessionId, { exit_code_strategy: extraction.strategy });
    }

    let runners = sess.runners;
    if (!Array.isArray(runners)) {
      const detection = detectRunners(cwd, config);
      runners = detection.runners;
      updateSessionState(cwd, sessionId, { runners, runner_source: detection.source });
    }
    const { matched_runner, watch } = matchRunner(toolInput.command, config, runners);

    if (!admitEntry(cwd, sessionId, 'command')) return {};
    const entry = {
      kind: 'command',
      session_id: sessionId,
      tool_use_id: input.tool_use_id ?? null,
      command: String(toolInput.command || '').slice(0, 500),
      background: toolInput.run_in_background === true,
      exit_code: extraction.exit_code,
      exit_source: extraction.exit_source,
      matched_runner,
    };
    if (watch) entry.watch = true;
    if (Number.isInteger(input.duration_ms)) entry.duration_ms = input.duration_ms;
    appendEntry(paths, 'e', entry);
    return {};
  }

  return {}; // unmatched tool (matcher should prevent this) — observe nothing
}

function onPostToolUseFailure(input, ctx) {
  const { cwd, paths, config, sessionId } = ctx;
  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  if (!admitEntry(cwd, sessionId, 'tool_fail')) return {};

  const entry = {
    kind: 'tool_fail',
    session_id: sessionId,
    tool_use_id: input.tool_use_id ?? null,
    tool_name: toolName,
    error_excerpt: excerptOf(input, 300),
  };
  if (toolName === 'Bash') {
    entry.command = String(toolInput.command || '').slice(0, 500);
    const sess = readSessionState(cwd, sessionId) || {};
    entry.matched_runner = matchRunner(toolInput.command, config, sess.runners || null).matched_runner;
    // Failure channel carries the REAL exit code ("Exit code N" leading line
    // — observed 2.1.59). A failing runner entry with its code is evidence
    // of honest red (§12.2: latest result wins).
    const outcome = deriveBashExit({
      event: 'PostToolUseFailure',
      error: input.error,
      isInterrupt: input.is_interrupt === true,
    });
    entry.exit_code = outcome.exit_code;
    entry.exit_source = outcome.exit_source;
    if (input.is_interrupt === true) entry.is_interrupt = true;
  } else if (FILE_WRITE_TOOLS.has(toolName)) {
    entry.file_path = normalizePath(toolInput.file_path || toolInput.notebook_path, cwd);
  }
  appendEntry(paths, 'e', entry);
  return {};
}

function onStop(input, ctx) {
  const { cwd, paths, config, sessionId } = ctx;
  const evaluation = evaluateGate({
    cwd, paths, config, sessionId,
    stopHookActive: input.stop_hook_active === true,
  });
  if (evaluation.decision === 'off') return {};

  const sess = readSessionState(cwd, sessionId) || {};
  const meta = {
    sessionId,
    ts: new Date().toISOString().slice(0, 16).replace('T', ' '),
    mode: config.mode,
    blockCount: sess.block_count || 0,
    runner: (sess.runners || []).join(',') || 'none',
    exitSource: sess.exit_code_strategy || 'harness_event/failure_text',
  };
  const gateEntry = (result) => appendEntry(paths, 'g', {
    kind: 'gate', session_id: sessionId, result,
    failed: evaluation.failedIds || [], block_count: meta.blockCount,
  });
  const receiptsRef = 'Receipts: .polygraph/receipt.md';

  switch (evaluation.decision) {
    case 'advisory': {
      writeReceipt(paths, evaluation, meta);
      return {}; // observing only — no noise on Q&A / pre-contract sessions (M5)
    }
    case 'pass': {
      writeReceipt(paths, evaluation, meta);
      gateEntry('pass');
      if (!config.receipt_on_pass) return {};
      const { counts } = evaluation;
      // FR-3.5 k/k banner: user-approved deferrals and standard-mode [?]
      // items are excluded from the denominator, each with an explicit
      // clause — an unexplained 2/3 would read as waving work through (A4).
      const denom = counts.total - counts.deferred - (counts.ambiguous || 0);
      const manualIds = evaluation.items
        .filter((i) => i.evidenceType === 'manual' && i.status === '⚠').map((i) => i.id);
      const clauses = [];
      if (counts.manual > 0) clauses.push(`${counts.manual} manual item${counts.manual > 1 ? 's' : ''} awaits human review (${manualIds.join(', ')})`);
      if (counts.deferred > 0) clauses.push(`${counts.deferred} deferred by user`);
      if (counts.ambiguous > 0) clauses.push(`${counts.ambiguous} awaiting clarification`);
      const msg = clauses.length
        ? `✓ polygraph: ${counts.verified}/${denom} verified — ${clauses.join(', ')}. ${receiptsRef}`
        : `✓ polygraph: ${counts.verified}/${denom} requirements verified — ${receiptsRef.toLowerCase()}`;
      return { systemMessage: msg };
    }
    case 'confess-accepted': {
      writeReceipt(paths, evaluation, meta);
      gateEntry('confess');
      return { systemMessage: `⚠ polygraph: stopped WITH CONFESSION — unmet: ${evaluation.unmet.join(', ')}. ${receiptsRef}` };
    }
    case 'confess-nudge': {
      writeReceipt(paths, evaluation, meta);
      updateSessionState(cwd, sessionId, { confess_nudged: true });
      gateEntry('confess-nudge');
      return {
        hookSpecificOutput: {
          hookEventName: 'Stop',
          additionalContext: `[polygraph] Completion is not proven (${evaluation.failedIds.join(', ')}). Either finish the work, or stop honestly: add a '## POLYGRAPH CONFESSION' block to .polygraph/POLYGRAPH.md with 'status: incomplete' and 'unmet: ${evaluation.failedIds.join(', ')}'. The next stop will be allowed either way, labeled truthfully.`,
        },
      };
    }
    case 'confess-allow': {
      writeReceipt(paths, evaluation, meta);
      gateEntry('unproven-allow');
      return { systemMessage: `⚠ polygraph: stopped UNPROVEN — unresolved: ${evaluation.failedIds.join(', ')} (no confession). ${receiptsRef}` };
    }
    case 'block': {
      const newCount = meta.blockCount + 1;
      updateSessionState(cwd, sessionId, { block_count: newCount });
      writeReceipt(paths, evaluation, { ...meta, blockCount: newCount });
      appendEntry(paths, 'g', {
        kind: 'gate', session_id: sessionId, result: 'block',
        failed: evaluation.failedIds, block_count: newCount,
      });
      return { decision: 'block', reason: evaluation.reason };
    }
    default:
      return {};
  }
}

function excerptOf(input, max) {
  const candidates = [input.error, input.error_message, input.tool_response];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.slice(0, max);
    if (c && typeof c === 'object') {
      const text = c.error || c.message || c.stderr || c.stdout;
      if (typeof text === 'string' && text.trim()) return text.slice(0, max);
      return JSON.stringify(c).slice(0, max);
    }
  }
  return '';
}

// --- main --------------------------------------------------------------------

const raw = await readStdin();
let input;
try {
  input = JSON.parse(raw);
} catch {
  emit({ systemMessage: 'polygraph: internal error — hook skipped (unparseable stdin)' });
}
// JSON literals like `null`/`42` parse fine but are not payload objects.
if (!input || typeof input !== 'object' || Array.isArray(input)) {
  emit({ systemMessage: 'polygraph: internal error — hook skipped (non-object stdin payload)' });
}

const event = input.hook_event_name || argHint;
const cwd = input.cwd || process.cwd();
const sessionId = input.session_id || 'unknown';

// POLYGRAPH_PROBE=1: dump every raw hook payload to debug/ — dev-only tool
// for empirically resolving [DA VERIFICARE] payload schemas in sandbox runs.
if (process.env.POLYGRAPH_PROBE === '1') {
  try {
    const dir = path.join(cwd, '.polygraph', 'debug');
    const { ensureDir } = await import('./lib/fsx.mjs');
    ensureDir(dir);
    const stamp = `${Date.now().toString(36)}-${process.pid}`;
    atomicWriteJson(path.join(dir, `probe-${event}-${stamp}.json`), input);
  } catch { /* best effort */ }
}

try {
  const config = loadConfig(cwd, sessionId);
  if (config.mode === 'off') emit({}); // all hooks no-op, ledger included (§13.1)

  // Lazy state-dir creation: mid-session installs must observe too (§15.8).
  if (!statSafe(statePaths(cwd).dir)) ensureStateDir(cwd);
  const ctx = { cwd, paths: statePaths(cwd), config, sessionId };

  switch (event) {
    case 'SessionStart': emit(onSessionStart(input, ctx)); break;
    case 'PostToolUse': emit(onPostToolUse(input, ctx)); break;
    case 'PostToolUseFailure': emit(onPostToolUseFailure(input, ctx)); break;
    case 'UserPromptSubmit': emit(onUserPromptSubmit(input, ctx)); break;
    case 'Stop': emit(onStop(input, ctx)); break;
    default: emit({});
  }
} catch (err) {
  // FR-0.4 fail-open: ANY uncaught throw (incl. one inside the gate, after a
  // would-be pass) degrades LOUDLY here — the error systemMessage, never the
  // ✓ banner and never a silent clean allow. On Stop this is the gate being
  // skipped (FR-0.4 wording); for other events, the hook.
  const what = event === 'Stop' ? 'gate' : 'hook';
  emit({
    systemMessage: `polygraph: internal error — ${what} skipped (${err?.code || err?.message || 'unknown'})`,
  });
}
