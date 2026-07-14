// state.mjs — state-dir layout, config defaults + precedence, per-session runtime state.
// Session-scoped state lives in session.json as a map keyed by session_id so
// concurrent sessions never clobber each other's block counters (A2: only the
// anti-loop machinery is session-scoped).

import path from 'node:path';
import {
  atomicWriteJson,
  ensureDir,
  readJsonSafe,
  readTextSafe,
  appendLine,
  statSafe,
} from './fsx.mjs';

export const STATE_DIR_NAME = '.polygraph';

// §10.3 shipped defaults (+ question_words per amendment A6).
export const DEFAULT_CONFIG = {
  v: 1,
  mode: 'standard', // "off" | "confess" | "standard" | "strict"
  require_tests: 'auto', // "auto" | "always" | "never"
  test_command: null,
  runner: 'auto',
  source_globs: ['src/**', 'lib/**', 'app/**', '*.py', '*.ts', '*.js', '*.rs', '*.go', '*.java', '*.cs'],
  ignore_paths: ['.polygraph/**', '**/node_modules/**', 'dist/**', 'build/**'],
  max_blocks: 2,
  min_prompt_chars: 20,
  imperative_keywords: ['add', 'fix', 'implement', 'refactor', 'create', 'update', 'remove', 'delete', 'rename', 'migrate', 'write', 'build', 'change', 'make', 'test'],
  question_words: ['what', 'why', 'how', 'when', 'where', 'who', 'which', 'can you explain', 'explain'],
  verifier: 'on_block', // "off" | "on_block" | "always"
  verifier_max_items: 5,
  receipt_on_pass: true,
};

export function stateDir(cwd) {
  return path.join(cwd, STATE_DIR_NAME);
}

export function statePaths(cwd) {
  const dir = stateDir(cwd);
  return {
    dir,
    contract: path.join(dir, 'POLYGRAPH.md'),
    ledger: path.join(dir, 'ledger.jsonl'),
    config: path.join(dir, 'config.json'),
    session: path.join(dir, 'session.json'),
    counters: path.join(dir, 'counters.json'),
    countersLock: path.join(dir, 'counters.lock'),
    verdicts: path.join(dir, 'verdicts.json'),
    receipt: path.join(dir, 'receipt.md'),
    shadow: path.join(dir, 'contract.shadow.json'),
    promptsDir: path.join(dir, 'prompts'),
    debugDir: path.join(dir, 'debug'),
  };
}

export function ensureStateDir(cwd) {
  const p = statePaths(cwd);
  ensureDir(p.dir);
  ensureDir(p.promptsDir);
  ensureDir(p.debugDir);
  return p;
}

/**
 * Effective config: session override (mode only, via /polygraph:off|on|mode)
 * → .polygraph/config.json → shipped defaults (§13.4). Unknown keys ignored
 * by simply not reading them.
 */
export function loadConfig(cwd, sessionId = null) {
  const p = statePaths(cwd);
  const fileCfg = readJsonSafe(p.config) || {};
  const cfg = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (fileCfg[key] !== undefined) cfg[key] = fileCfg[key];
  }
  const sess = readSessionState(cwd, sessionId);
  if (sess && sess.mode) cfg.mode = sess.mode;
  const global = readJsonSafe(p.session);
  if (global && global.global_mode) cfg.mode = global.global_mode; // /polygraph:off without session scope
  return cfg;
}

function loadSessionFile(cwd) {
  const p = statePaths(cwd);
  const data = readJsonSafe(p.session);
  if (data && typeof data.sessions === 'object' && data.sessions !== null) return data;
  return { v: 1, sessions: {} };
}

export function readSessionState(cwd, sessionId) {
  if (!sessionId) return null;
  return loadSessionFile(cwd).sessions[sessionId] || null;
}

/** Merge a patch into this session's runtime state (last-writer-wins per field). */
export function updateSessionState(cwd, sessionId, patch) {
  const p = statePaths(cwd);
  const data = loadSessionFile(cwd);
  data.sessions[sessionId] = { ...(data.sessions[sessionId] || {}), ...patch };
  atomicWriteJson(p.session, data);
  return data.sessions[sessionId];
}

/**
 * FR-0.2: on first activation append .polygraph/ to the project .gitignore,
 * excluding config.json (shareable policy). Uses `.polygraph/*` + negation —
 * a bare `.polygraph/` would ignore the directory itself and make the
 * negation ineffective (git cannot re-include inside an ignored dir).
 */
const GITIGNORE_BLOCK = [
  '# polygraph state (config.json stays shared)',
  '.polygraph/*',
  '!.polygraph/config.json',
];

export function ensureGitignore(cwd) {
  const gitDir = path.join(cwd, '.git');
  if (!statSafe(gitDir)) return false; // not a git repo — nothing to do
  const giPath = path.join(cwd, '.gitignore');
  const existing = readTextSafe(giPath);
  if (existing !== null && existing.includes('.polygraph/*')) return false;
  const prefix = existing === null || existing === '' || existing.endsWith('\n') ? '' : '\n';
  // appendLine creates the file when missing, and is retry-wrapped (A5) —
  // one code path for both the new-file and append cases.
  appendLine(giPath, prefix + GITIGNORE_BLOCK.join('\n'));
  return true;
}

export function nowIso() {
  return new Date().toISOString();
}

/**
 * /polygraph:off|on|mode — session-local override lives in session.json
 * (gitignored, per-machine); `--repo` persists policy to config.json
 * (committable, §13.4). Mode 'standard' clears the local override.
 */
export function setMode(cwd, mode, { repo = false } = {}) {
  const p = ensureStateDir(cwd);
  if (repo) {
    const cfg = readJsonSafe(p.config) || { v: 1 };
    cfg.mode = mode;
    atomicWriteJson(p.config, cfg);
    return `polygraph: mode=${mode} persisted to .polygraph/config.json (repo policy)`;
  }
  const data = readJsonSafe(p.session);
  const file = data && typeof data.sessions === 'object' ? data : { v: 1, sessions: {} };
  file.global_mode = mode;
  atomicWriteJson(p.session, file);
  return `polygraph: mode=${mode} for this repo (local; use --repo to commit as policy)`;
}
