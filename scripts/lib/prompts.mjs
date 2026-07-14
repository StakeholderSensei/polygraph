// prompts.mjs — FR-1.2 skip heuristics + the FR-1.4 contract instruction.
// Deterministic only: requirement extraction stays with the main agent;
// contract QUALITY is enforced downstream by the gate (the 80/20 split).

import crypto from 'node:crypto';

// Unicode-aware boundary check: config keywords come from users (any
// language, any characters) — \b is ASCII-only and raw interpolation into
// RegExp would let 'c++' throw and kill the whole capture handler.
const NON_WORD = /[^\p{L}\p{N}_]/u;
function containsWord(haystack, word) {
  const w = word.toLowerCase();
  let from = 0;
  while (true) {
    const i = haystack.indexOf(w, from);
    if (i === -1) return false;
    const before = i === 0 || NON_WORD.test(haystack[i - 1]);
    const after = i + w.length >= haystack.length || NON_WORD.test(haystack[i + w.length]);
    if (before && after) return true;
    from = i + 1;
  }
}

/** FR-1.2 skip conditions, evaluated in order. Mode 'off' is the caller's job. */
export function shouldSkipPrompt(prompt, config) {
  const raw = String(prompt ?? '');
  // (b) on the RAW prompt: a whitespace-led paste can never be a slash command
  if (raw.startsWith('/')) return { skip: true, reason: 'slash-command' };
  const trimmed = raw.trim();
  if (trimmed.length < (config.min_prompt_chars ?? 20)) return { skip: true, reason: 'too-short' };

  const lower = trimmed.toLowerCase();
  const startsWithQuestion = (config.question_words ?? []).some((q) => {
    const ql = String(q).toLowerCase();
    // NON_WORD boundary covers spaces, punctuation AND apostrophes ("what's …?")
    return lower.startsWith(ql) && (lower.length === ql.length || NON_WORD.test(lower[ql.length]));
  });
  if (startsWithQuestion) {
    const hasCodeFence = trimmed.includes('```');
    const hasImperative = (config.imperative_keywords ?? []).some((k) => containsWord(lower, String(k)));
    if (!hasCodeFence && !hasImperative) return { skip: true, reason: 'pure-question' };
  }
  return { skip: false, reason: null };
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The FR-1.4 instruction block (≤ 180 tokens). When this prompt CREATES the
 * contract, the hook supplies the exact header line (session id, created ts,
 * baseline sha — A1) so the header is mechanically correct; follow-up
 * prompts only accumulate.
 */
export function contractInstruction(promptId, headerLine) {
  const create = headerLine
    ? `create .polygraph/POLYGRAPH.md STARTING with this exact line:\n${headerLine}\nthen`
    : `update .polygraph/POLYGRAPH.md: append under`;
  return `[polygraph] Contract ${promptId} recorded. BEFORE any other work, ${create} `
    + `'## Sources' ('- ${promptId} (<ISO ts>): <excerpt> → .polygraph/prompts/${promptId}.txt') and '## Requirements' — `
    + `one line per verifiable requirement: '- [ ] R<n>: <text> (source: ${promptId}) [evidence: diff|test|cmd|manual]'. `
    + `Never delete/reword items; to change one: defer it ('[~] … — deferred (user: P<n>)') and append a new R<m>. Unclear ask: mark '[?]'. `
    + `Check off only as '[x] … → evidence: E<n>'. Bash-done work = [evidence: cmd]; diff needs Edit/Write.`;
}
