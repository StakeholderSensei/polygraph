import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectRunners, matchRunner } from '../scripts/lib/runners.mjs';
import { DEFAULT_CONFIG } from '../scripts/lib/state.mjs';

const cfg = { ...DEFAULT_CONFIG };

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

// --- marker detection: 12 sample repos (§18 M0 verification) ---------------

const fixtures = [
  ['npm via package.json scripts.test', { 'package.json': '{"scripts":{"test":"vitest run"}}' }, ['npm']],
  ['npm via lockfile', { 'package-lock.json': '{}', 'package.json': '{}' }, ['npm']],
  ['npm via vitest config', { 'vitest.config.ts': '' }, ['npm']],
  ['pytest via pytest.ini', { 'pytest.ini': '' }, ['pytest']],
  ['pytest via pyproject section', { 'pyproject.toml': '[tool.pytest.ini_options]\n' }, ['pytest']],
  ['pytest via tests/test_*.py', { 'tests/test_app.py': '' }, ['pytest']],
  ['cargo', { 'Cargo.toml': '[package]' }, ['cargo']],
  ['gotest', { 'go.mod': 'module x' }, ['gotest']],
  ['gradle kts', { 'build.gradle.kts': '' }, ['gradle']],
  ['maven', { 'pom.xml': '<project/>' }, ['gradle']],
  ['dotnet via csproj', { 'App.csproj': '<Project/>' }, ['dotnet']],
  ['monorepo: npm + pytest in subdirs', { 'web/package-lock.json': '{}', 'api/pytest.ini': '' }, ['npm', 'pytest']],
];

for (const [name, files, expected] of fixtures) {
  test(`detect: ${name}`, () => {
    const { runners } = detectRunners(repo(files), cfg);
    assert.deepEqual(runners.sort(), expected.sort());
  });
}

test('detect: zero markers ⇒ runner none (empty list)', () => {
  const { runners } = detectRunners(repo({ 'readme.md': 'hi' }), cfg);
  assert.deepEqual(runners, []);
});

test('detect: config.runner forces a single row', () => {
  const r = detectRunners(repo({}), { ...cfg, runner: 'cargo' });
  assert.deepEqual(r, { runners: ['cargo'], source: 'config' });
});

test('detect: test_command override wins over everything', () => {
  const r = detectRunners(repo({ 'Cargo.toml': '' }), { ...cfg, test_command: 'make test' });
  assert.deepEqual(r, { runners: ['custom'], source: 'test_command' });
});

test('detect: node_modules is never scanned', () => {
  const { runners } = detectRunners(repo({ 'node_modules/dep/Cargo.toml': '' }), cfg);
  assert.deepEqual(runners, []);
});

test('detect: config.ignore_paths is honored (§12.1 step 3)', () => {
  const dir = repo({ 'vendor/Cargo.toml': '', 'go.mod': 'module x' });
  const custom = { ...cfg, ignore_paths: [...cfg.ignore_paths, 'vendor/**'] };
  assert.deepEqual(detectRunners(dir, custom).runners, ['gotest']);
  // without the extra pattern, vendor/ is scanned
  assert.deepEqual(detectRunners(dir, cfg).runners.sort(), ['cargo', 'gotest']);
});

// --- command matching (§12.1 execution patterns) -----------------------------

const commands = [
  ['npm test', 'npm', false],
  ['npm run test', 'npm', false],
  ['npm run test -- --coverage', 'npm', false],
  ['yarn test', 'npm', false],
  ['pnpm test', 'npm', false],
  ['npx vitest run', 'npm', false],
  ['npx jest', 'npm', false], // jest without `run` executes once — not watch mode
  ['npx vitest', 'npm', true], // vitest without `run` defaults to watch mode
  ['npx vitest --watch', 'npm', true],
  ['pytest -q', 'pytest', false],
  ['python -m pytest tests/', 'pytest', false],
  ['python3 -m pytest', 'pytest', false],
  ['uv run pytest', 'pytest', false],
  ['tox -e py312', 'pytest', false],
  ['cargo test', 'cargo', false],
  ['cargo nextest test', 'cargo', false],
  ['cargo nextest run', 'cargo', false],
  ['go test ./...', 'gotest', false],
  ['./gradlew test', 'gradle', false],
  ['gradlew.bat test --info', 'gradle', false],
  ['gradle test', 'gradle', false],
  ['mvn test', 'gradle', false],
  ['mvn -B -q test', 'gradle', false],
  ['mvnw.cmd clean test', 'gradle', false],
  ['dotnet test', 'dotnet', false],
  ['dotnet test MySln.sln --no-build', 'dotnet', false],
  ['ls -la', null, false],
  ['git status', null, false],
  ['echo test', null, false], // word "test" alone must not match a runner
  ['npm install', null, false],
  // gradle false-positive guards: path/file mentions are NOT launcher invocations
  ['cat gradle/libs.versions.toml | grep test', null, false],
  ['ls build.gradle && echo test', null, false],
  ['vim gradle.properties # test', null, false],
];

for (const [cmd, expectedRunner, expectedWatch] of commands) {
  test(`match: ${JSON.stringify(cmd)} → ${expectedRunner}${expectedWatch ? ' (watch)' : ''}`, () => {
    const { matched_runner, watch } = matchRunner(cmd, cfg, null);
    assert.equal(matched_runner, expectedRunner);
    assert.equal(watch, expectedWatch);
  });
}

test('match: test_command exact-prefix beats regexes and ignores others', () => {
  const custom = { ...cfg, test_command: 'make check' };
  assert.equal(matchRunner('make check -j4', custom, null).matched_runner, 'custom');
  // other commands still match table rows even with test_command set
  assert.equal(matchRunner('pytest', custom, null).matched_runner, 'pytest');
});

test('match: detected-runner allowlist filters foreign rows', () => {
  const r = matchRunner('pytest', cfg, ['npm']);
  assert.equal(r.matched_runner, null);
});
