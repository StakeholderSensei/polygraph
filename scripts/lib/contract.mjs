// contract.mjs — parser for POLYGRAPH.md (§10.1 grammar, normative).
// Line-oriented and strict: anything item-shaped that does not parse is a
// C1 error — malformed contracts must never silently pass.

import crypto from 'node:crypto';

const HEADER_RX = /<!--\s*polygraph:v1\s+session:(\S+)\s+created:(\S+?)(?:\s+baseline:(\S+))?\s*-->/;
// P-ids accept the same '-x…' suffix as E-ids: the plugin's own degradation
// path (locked/corrupt counters) mints suffixed ids, embeds them in the
// FR-1.4 instruction, and a grammar that rejects them would C1-block every
// honest contract written under contention.
const ITEM_RX = /^- \[( |x|~|\?)\] R(\d+): (.+?) \(source: (P\d+(?:-x[0-9a-f]+)?)\) \[evidence: (diff|test|cmd|manual)\](.*)$/;
const SOURCE_RX = /^- (P\d+(?:-x[0-9a-f]+)?) \(/;
// Pointers parse ONLY from the normative '→ evidence: E<n>(,E<n>)*' group —
// an unanchored E\d+ grep would fabricate phantom pointers from prose like
// 'E2E' or 'E501' and let an unproven check-off cite accidental evidence.
const EVIDENCE_GROUP_RX = /(?:→|->)\s*evidence:\s*(E\d+(?:-x[0-9a-f]+)?(?:\s*,\s*E\d+(?:-x[0-9a-f]+)?)*)/;
const DEFERRED_RX = /deferred \(user: (P\d+(?:-x[0-9a-f]+)?)\)/;
const KNOWN_SECTIONS = new Set(['SOURCES', 'REQUIREMENTS', 'POLYGRAPH CONFESSION']);

const STATE = { ' ': 'open', x: 'done', '~': 'deferred', '?': 'ambiguous' };

/** Normalized immutable zone for C2b hashing (A3): text + source + evidence type. */
export function immutableZone(item) {
  return `R${item.num}: ${item.text} (source: ${item.source}) [evidence: ${item.evidenceType}]`
    .replace(/\s+/g, ' ').trim();
}

export function zoneHash(zone) {
  return crypto.createHash('sha256').update(zone, 'utf8').digest('hex');
}

/**
 * Parse the contract text. Returns:
 * { exists, ok, errors[], header:{session,created,baseline}|null,
 *   sources:[P-ids], items:[{id,num,state,text,source,evidenceType,
 *   pointers,deferredUser,hash,line}], confession:{unmet:[ids],note}|null }
 */
export function parseContract(text) {
  if (text === null || text === undefined) return { exists: false, ok: false, errors: ['no contract file'], items: [], sources: [], header: null, confession: null };
  const errors = [];
  const lines = text.replaceAll('\r', '').split('\n');

  const headerMatch = HEADER_RX.exec(text);
  const header = headerMatch
    ? { session: headerMatch[1], created: headerMatch[2], baseline: headerMatch[3] || 'none' }
    : null;
  if (!header) errors.push('missing polygraph:v1 header comment');

  let section = null;
  const items = [];
  const sources = [];
  const unparseable = []; // raw requirement-section rejects, for C1-repair (B)
  let confession = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      const title = line.replace(/^##\s+/, '').trim().toUpperCase();
      if (title === 'SOURCES') section = 'sources';
      else if (title === 'REQUIREMENTS') section = 'requirements';
      else if (title === 'POLYGRAPH CONFESSION') { section = 'confession'; confession = { status: null, unmet: [], note: null }; }
      else {
        // an unknown heading would silently swallow every line beneath it —
        // items would vanish from C2/C3 with no error (§10.1: malformed
        // contracts must not silently pass)
        section = null;
        errors.push(`unknown section heading line ${i + 1}: ${line.trim().slice(0, 60)}`);
      }
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (section === 'sources' && trimmed.startsWith('- ')) {
      const m = SOURCE_RX.exec(trimmed);
      if (m) sources.push(m[1]);
      else errors.push(`unparseable source line ${i + 1}: ${trimmed.slice(0, 80)}`);
    } else if (section === 'requirements') {
      const m = ITEM_RX.exec(trimmed);
      if (!m) {
        // ANY non-empty line here that isn't a valid item is an error — a
        // skipped item-shaped line ('* [ ] R2…', '-[x] R3…') would make the
        // requirement invisible to every check
        errors.push(`unparseable requirement line ${i + 1}: ${trimmed.slice(0, 80)}`);
        unparseable.push({ line: i + 1, raw: trimmed });
        continue;
      }
      const tail = m[6] || '';
      const evidenceGroup = EVIDENCE_GROUP_RX.exec(tail);
      const item = {
        id: `R${m[2]}`, num: Number(m[2]), state: STATE[m[1]],
        text: m[3], source: m[4], evidenceType: m[5],
        pointers: evidenceGroup ? evidenceGroup[1].split(',').map((s) => s.trim()) : [],
        deferredUser: (DEFERRED_RX.exec(tail) || [])[1] || null,
        line: i + 1,
      };
      item.hash = zoneHash(immutableZone(item));
      items.push(item);
    } else if (section === 'confession') {
      const status = /^status:\s*(\S+)/.exec(trimmed);
      const unmet = /^unmet:\s*(.+)$/.exec(trimmed);
      const note = /^note:\s*(.+)$/.exec(trimmed);
      if (status) confession.status = status[1];
      else if (unmet) confession.unmet = unmet[1].split(',').map((s) => s.trim()).filter(Boolean);
      else if (note) confession.note = note[1];
    }
  }

  // duplicate R-ids are a parse error (ambiguous evidence anchoring)
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) errors.push(`duplicate item id ${item.id}`);
    seen.add(item.id);
  }
  if (confession && confession.status !== 'incomplete') {
    errors.push('confession block present but status is not "incomplete"');
  }

  return { exists: true, ok: errors.length === 0, errors, header, sources, items, confession, unparseable };
}

// ---- (B) C1-repair: syntax-and-restoration only, never semantics -----------
// Re-serialize a mangled requirement line into canonical grammar, preserving
// the state marker, text, source and pointers AS FOUND. Never invent an item,
// never add/strip a pointer, never flip a marker. Missing evidence type stays
// a visible choice slot the model must fill; missing source is only filled
// when the contract has exactly one source (deterministic, unambiguous).
export function repairLine(raw, sources) {
  const marker = /\[( |x|~|\?)\]/.exec(raw);
  const rid = /\bR(\d+)\b/.exec(raw);
  if (!marker || !rid) return null; // not recoverable as an item
  const source = /\(source:\s*(P\d+(?:-x[0-9a-f]+)?)\)/.exec(raw)?.[1]
    ?? (sources.length === 1 ? sources[0] : null);
  if (!source) return null; // multi-source ambiguity — never guess semantics
  const type = /\[evidence:\s*(diff|test|cmd|manual)\]/.exec(raw)?.[1] ?? 'diff|test|cmd|manual';
  const pointers = /(?:→|->)?\s*evidence:\s*((?:E\d+(?:-x[0-9a-f]+)?)(?:\s*,\s*E\d+(?:-x[0-9a-f]+)?)*)/.exec(raw)?.[1];
  const deferred = /deferred \(user:\s*(P\d+(?:-x[0-9a-f]+)?)\)/.exec(raw)?.[1];

  // text = what remains after stripping every recognized fragment
  let text = raw
    .replace(/^[-*+]?\s*\[( |x|~|\?)\]\s*/, '')
    .replace(/\bR\d+\s*[:.]?\s*/, '')
    .replace(/\(source:[^)]*\)/, '')
    .replace(/\[evidence:[^\]]*\]/, '')
    .replace(/(?:→|->)?\s*evidence:\s*(?:E\d+(?:-x[0-9a-f]+)?)(?:\s*,\s*E\d+(?:-x[0-9a-f]+)?)*/, '')
    .replace(/[—-]?\s*deferred \(user:[^)]*\)/, '')
    .replace(/\s+/g, ' ').trim();
  if (!text) return null;

  let line = `- [${marker[1]}] R${rid[1]}: ${text} (source: ${source}) [evidence: ${type}]`;
  if (pointers) line += ` → evidence: ${pointers.replace(/\s+/g, '')}`;
  if (marker[1] === '~' && deferred) line += ` — deferred (user: ${deferred})`;
  return line;
}
