// receipts.mjs — the evidence table (§10.4/§14.3). Renders the SAME
// evaluation object the gate decided on (FR-4.4: one check implementation,
// receipts can never disagree with the gate).

import { atomicWriteFile } from './fsx.mjs';

const W = { req: 4, text: 45, status: 6, evidence: 38 };

// Code-point measurement: 🕒 is an astral pair (2 UTF-16 units) while the
// other five glyphs are BMP — .length-based padding would misalign the
// Status column border by one on every stale row. Code points keep the six
// glyphs equal and never split surrogates on truncation.
function cut(s, width) {
  const cps = [...String(s ?? '')];
  return cps.length > width ? cps.slice(0, width - 1).join('') + '…' : cps.join('');
}
function pad(s, width) {
  s = cut(s, width);
  return s + ' '.repeat(Math.max(0, width - [...s].length));
}
function row(cells) {
  return `│ ${pad(cells[0], W.req)} │ ${pad(cells[1], W.text)} │ ${pad(cells[2], W.status)} │ ${pad(cells[3], W.evidence)} │`;
}
const line = (l, m, r) =>
  `${l}${'─'.repeat(W.req + 2)}${m}${'─'.repeat(W.text + 2)}${m}${'─'.repeat(W.status + 2)}${m}${'─'.repeat(W.evidence + 2)}${r}`;

/** Compute the ALL-CAPS VERDICT line from a gate evaluation. */
export function verdictLine(evaluation) {
  const { decision, failedIds = [], counts = {}, unmet = [] } = evaluation;
  const manualNote = counts.manual > 0 ? ` (${counts.manual} manual unverified)` : '';
  switch (decision) {
    case 'pass': return `VERDICT: PASSED${manualNote}`;
    case 'confess-accepted': return `VERDICT: CONFESSED (${unmet.join(', ')})`;
    case 'advisory': return 'VERDICT: ADVISORY (no contract — observing only)';
    case 'off': return 'VERDICT: OFF (gate disabled — /polygraph:on to re-enable)';
    case 'confess-nudge':
    case 'confess-allow': return `VERDICT: UNPROVEN (${failedIds.join(', ')}) — stop allowed without block`;
    default: return `VERDICT: BLOCKED (${failedIds.join(', ')}) — resolve, defer with user approval, or confess.`;
  }
}

export function renderTable(evaluation, meta) {
  const { items = [], git, counts = {} } = evaluation;
  const out = [];
  out.push(`POLYGRAPH RECEIPTS — session ${meta.sessionId} — ${meta.ts} — mode: ${meta.mode} — blocks: ${meta.blockCount}`);
  out.push(line('┌', '┬', '┐'));
  out.push(row(['Req', 'Requirement', 'Status', 'Evidence']));
  out.push(line('├', '┼', '┤'));
  if (items.length === 0) {
    out.push(row(['—', '(no contract items)', '', '']));
  }
  // §15.5: truncate to worst 20 items + summary row
  const shown = items.length > 20 ? items.filter((i) => i.fail).concat(items.filter((i) => !i.fail)).slice(0, 20) : items;
  for (const item of shown) {
    out.push(row([item.id, item.text, ` ${item.status}`, item.evidence]));
  }
  if (items.length > shown.length) {
    out.push(row(['…', `${items.length - shown.length} more items (see receipt.md JSON)`, '', '']));
  }
  out.push(line('└', '┴', '┘'));
  out.push(`git: ${git?.summary ?? 'n/a'} · runner: ${meta.runner || 'none'} · exit-code source: ${meta.exitSource || 'n/a'}`);
  out.push(verdictLine(evaluation));
  return out.join('\n');
}

/** Rewrite receipt.md (FR-3.9/FR-4.3): human table + fenced JSON payload. */
export function writeReceipt(paths, evaluation, meta) {
  const table = renderTable(evaluation, meta);
  const payload = {
    session_id: meta.sessionId, ts: meta.ts, mode: meta.mode, decision: evaluation.decision,
    checks: Object.fromEntries(Object.entries(evaluation.checks || {}).map(([k, v]) => [k, v.status])),
    failed: evaluation.failedIds || [],
    // §10.4 schema: evidence is an array; git carries {files, ins, del}
    items: (evaluation.items || []).map((i) => ({ id: i.id, status: i.status, evidence: i.evidence === '—' ? [] : [i.evidence] })),
    git: evaluation.git
      ? {
          corroboration: evaluation.git.corroboration, summary: evaluation.git.summary,
          files: evaluation.git.files ?? null, ins: evaluation.git.ins ?? null, del: evaluation.git.del ?? null,
        }
      : null,
    counts: evaluation.counts || {},
  };
  atomicWriteFile(paths.receipt, `${table}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`);
  return table;
}
