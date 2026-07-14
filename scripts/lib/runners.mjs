// runners.mjs — test-runner detection (§12). Deterministic regex only.
// Detection RECOGNIZES test executions in the ledger; polygraph never runs
// tests itself (NG1). Unknown runners ⇒ unverified, never wrong (§12.3).

import fs from 'node:fs';
import path from 'node:path';
import { readTextSafe } from './fsx.mjs';
import { compileGlobs, matchesDir } from './globs.mjs';

// §12.1 — the six launch runners. `patterns` are word-boundary anchored.
const RUNNER_TABLE = [
  {
    id: 'npm',
    patterns: [
      /\bnpm (run )?test\b/,
      /\byarn test\b/,
      /\bpnpm test\b/,
      /\bnpx? ?(vitest|jest)\b/,
    ],
    markerFiles: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
      'vitest.config.js', 'vitest.config.ts', 'vitest.config.mjs', 'vitest.config.mts',
      'jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.json'],
    markerFn: (dir) => {
      const pkg = readTextSafe(path.join(dir, 'package.json'));
      if (!pkg) return false;
      try { return Boolean(JSON.parse(pkg).scripts?.test); } catch { return false; }
    },
  },
  {
    id: 'pytest',
    patterns: [/\bpytest\b/, /\bpython3? -m pytest\b/, /\btox\b/, /\buv run pytest\b/],
    markerFiles: ['pytest.ini'],
    markerFn: (dir) => {
      const pyproject = readTextSafe(path.join(dir, 'pyproject.toml'));
      if (pyproject && pyproject.includes('[tool.pytest.ini_options]')) return true;
      const setupCfg = readTextSafe(path.join(dir, 'setup.cfg'));
      if (setupCfg && setupCfg.includes('[tool:pytest]')) return true;
      try {
        return fs.readdirSync(path.join(dir, 'tests')).some((f) => /^test_.*\.py$/.test(f));
      } catch { return false; }
    },
  },
  {
    id: 'cargo',
    patterns: [/\bcargo (nextest )?test\b/, /\bcargo nextest run\b/],
    markerFiles: ['Cargo.toml'],
  },
  {
    id: 'gotest',
    patterns: [/\bgo test\b/],
    markerFiles: ['go.mod'],
  },
  {
    id: 'gradle',
    // Launcher token must be followed by whitespace (§12.1): '.' is NOT a
    // valid prefix boundary, or 'build.gradle'/'gradle.properties'/'gradle/'
    // path mentions followed by the word 'test' would false-positive —
    // and a mis-tagged green command could satisfy C4 (M3 direction).
    patterns: [
      /(^|[\s/\\])(\.\/)?gradlew?(\.bat)?\s+.*\btest\b/,
      /\bmvn( -[^\s]+)* test\b/,
      /\bmvnw(\.cmd)?\b.*\btest\b/,
    ],
    markerFiles: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pom.xml'],
  },
  {
    id: 'dotnet',
    patterns: [/\bdotnet test\b/],
    markerGlobs: [/\.sln$/, /\.csproj$/, /\.fsproj$/],
  },
];

// Watch-mode invocations can never satisfy C4 (§12.2): no terminal exit.
// Only vitest defaults to watch without `run`; jest runs once (§12.2).
const WATCH_HINTS = [/\s--watch(\b|=)/, /\s--looponfail\b/];
const VITEST_BARE = /\bvitest\b/;

function dirHasMarker(dir, runner) {
  for (const f of runner.markerFiles || []) {
    try { fs.statSync(path.join(dir, f)); return true; } catch { /* keep looking */ }
  }
  if (runner.markerGlobs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* unreadable */ }
    if (names.some((n) => runner.markerGlobs.some((g) => g.test(n)))) return true;
  }
  if (runner.markerFn && runner.markerFn(dir)) return true;
  return false;
}

/**
 * §12.1 detection algorithm: test_command override → forced runner → marker
 * scan of project root, depth ≤ 2, honoring config.ignore_paths (plus .git,
 * always). Multiple hits ⇒ all matched rows are valid recognizers (monorepo
 * reality).
 */
export function detectRunners(cwd, config) {
  if (config.test_command) return { runners: ['custom'], source: 'test_command' };
  if (config.runner && config.runner !== 'auto') return { runners: [config.runner], source: 'config' };

  const ignored = compileGlobs(config.ignore_paths);
  const isIgnored = (relPath) =>
    relPath === '.git' || relPath.endsWith('/.git') || matchesDir(ignored, relPath);
  const dirs = [cwd];
  try {
    for (const name of fs.readdirSync(cwd)) {
      if (isIgnored(name)) continue;
      const sub = path.join(cwd, name);
      let st;
      try { st = fs.statSync(sub); } catch { continue; }
      if (st.isDirectory()) {
        dirs.push(sub);
        try {
          for (const inner of fs.readdirSync(sub)) {
            if (isIgnored(`${name}/${inner}`)) continue;
            const sub2 = path.join(sub, inner);
            try { if (fs.statSync(sub2).isDirectory()) dirs.push(sub2); } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* cwd unreadable — fall through with root only */ }

  const found = [];
  for (const runner of RUNNER_TABLE) {
    if (dirs.some((d) => dirHasMarker(d, runner))) found.push(runner.id);
  }
  return { runners: found, source: 'scan' };
}

/**
 * Tag a command against the detection table (FR-2.8). config.test_command
 * exact-prefix match beats runner regexes. Returns
 * { matched_runner: string|null, watch: boolean }.
 */
export function matchRunner(command, config, detectedRunners = null) {
  if (!command) return { matched_runner: null, watch: false };
  const cmd = command.trim();
  if (config.test_command && cmd.startsWith(config.test_command)) {
    return { matched_runner: 'custom', watch: false };
  }
  const allowed = detectedRunners && detectedRunners.length ? new Set(detectedRunners) : null;
  for (const runner of RUNNER_TABLE) {
    if (allowed && !allowed.has(runner.id)) continue;
    if (runner.patterns.some((p) => p.test(cmd))) {
      let watch = WATCH_HINTS.some((p) => p.test(cmd));
      // vitest without an explicit `run` defaults to watch mode
      if (!watch && VITEST_BARE.test(cmd) && !/\brun\b/.test(cmd)) {
        watch = true;
      }
      return { matched_runner: runner.id, watch };
    }
  }
  return { matched_runner: null, watch: false };
}

export const RUNNER_IDS = RUNNER_TABLE.map((r) => r.id);
