// exitcode.mjs — the exit-code extraction ladder (FR-2.5).
// The Bash tool_response schema is [DA VERIFICARE] (Q1): we try an ordered
// list of strategies and cache the first that works. FR-2.6 hard rule:
// if nothing yields an integer, exit_code is null with exit_source "unknown"
// — and unknown can NEVER satisfy a requirement (M3 = 0%).
//
// Deliberately NOT a strategy: inferring exit_code 0 from is_error:false.
// That would fabricate a pass from a heuristic — the one direction we must
// never be wrong in. Absence of error evidence is not evidence of success.

const INT_KEYS = ['exit_code', 'exitCode', 'code', 'status', 'returnCode', 'returncode'];
const TEXT_KEYS = ['stdout', 'stderr', 'output', 'content', 'text', 'result', 'message'];
// FR-2.5: ONLY a *trailing* "Exit code: N" line counts, fully anchored — an
// unanchored scan would fabricate codes from incidental program output
// ("child exited with code 0\n3 tests FAILED" must never become exit 0).
const TRAILING_LINE_RX = /^\s*(?:exit code|exit status|exited with(?: code)?)[: ]+(-?\d+)\s*$/i;

function asInt(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function intFromKey(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  const direct = asInt(obj[key]);
  if (direct !== null) return direct;
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = asInt(value[key]);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function textStreams(obj) {
  if (typeof obj === 'string') return [obj];
  if (!obj || typeof obj !== 'object') return [];
  const streams = [];
  for (const key of TEXT_KEYS) {
    if (typeof obj[key] === 'string') streams.push(obj[key]);
  }
  if (Array.isArray(obj.content)) {
    for (const part of obj.content) {
      if (typeof part === 'string') streams.push(part);
      else if (part && typeof part.text === 'string') streams.push(part.text);
    }
  }
  return streams;
}

/** Per-stream, last non-empty line only, fully anchored (see TRAILING_LINE_RX). */
function intFromText(obj) {
  for (const stream of textStreams(obj)) {
    const lines = stream.split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) continue;
    const m = TRAILING_LINE_RX.exec(last);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Extract { exit_code, exit_source, strategy } from a Bash tool_response
 * via the field ladder. `cachedStrategy` (from session.json) is tried first;
 * the winning strategy name is returned for caching.
 */
export function extractExitCode(toolResponse, cachedStrategy = null) {
  const strategies = [];
  for (const key of INT_KEYS) {
    strategies.push({ name: `key:${key}`, run: (r) => intFromKey(r, key) });
  }
  strategies.push({ name: 'text', run: (r) => intFromText(r) });

  if (cachedStrategy) {
    const cached = strategies.find((s) => s.name === cachedStrategy);
    if (cached) {
      const code = cached.run(toolResponse);
      if (code !== null) {
        return { exit_code: code, exit_source: 'tool_response', strategy: cached.name };
      }
    }
  }
  for (const strategy of strategies) {
    const code = strategy.run(toolResponse);
    if (code !== null) {
      return { exit_code: code, exit_source: 'tool_response', strategy: strategy.name };
    }
  }
  return { exit_code: null, exit_source: 'unknown', strategy: null };
}

// Observed on Claude Code 2.1.59 (live probe, 2026-07-13): Bash tool_response
// carries NO exit-code field — {stdout, stderr, interrupted, isImage,
// noOutputExpected}. But the harness itself routes outcomes: a nonzero exit
// raises a tool error → PostToolUseFailure with error text starting
// "Exit code N"; a zero exit completes normally → PostToolUse. The event
// channel is therefore ground truth from the harness, not model narration.
const FAILURE_EXIT_RX = /^Exit code (-?\d+)/;

function isKnownBashSuccessShape(r) {
  return r && typeof r === 'object' &&
    typeof r.stdout === 'string' && typeof r.stderr === 'string';
}

/**
 * Derive the Bash outcome from the full hook context.
 * PostToolUseFailure → parse the real exit code from the error text.
 * PostToolUse → field ladder first (future-proof), then the harness-event
 * inference: known success shape, not background, not interrupted ⇒ exit 0
 * (exit_source "harness_event" — provenance stays visible in receipts).
 * Anything else stays unknown (FR-2.6: unknown never passes).
 */
export function deriveBashExit({ event, toolResponse, error, background = false, isInterrupt = false, cachedStrategy = null }) {
  if (event === 'PostToolUseFailure') {
    const match = FAILURE_EXIT_RX.exec(String(error ?? ''));
    if (match && !isInterrupt) {
      return { exit_code: Number(match[1]), exit_source: 'failure_text', strategy: 'failure_text' };
    }
    return { exit_code: null, exit_source: 'unknown', strategy: null };
  }
  const ladder = extractExitCode(toolResponse, cachedStrategy);
  if (ladder.exit_code !== null) return ladder;
  if (!background && isKnownBashSuccessShape(toolResponse) && toolResponse.interrupted !== true) {
    return { exit_code: 0, exit_source: 'harness_event', strategy: 'harness_event' };
  }
  return { exit_code: null, exit_source: 'unknown', strategy: null };
}
