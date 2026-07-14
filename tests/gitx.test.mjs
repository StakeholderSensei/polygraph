import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { baselineStatus, changedSet, headSha, inChangedSet, summarize } from '../scripts/lib/gitx.mjs';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-test-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
  const write = (rel, content) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content, 'utf8');
  };
  return { dir, g, write };
}

test('baselineStatus: not a repo / no baseline / valid', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-test-'));
  assert.equal(baselineStatus(plain, 'abc').git, false);

  const { dir, g, write } = repo();
  assert.equal(baselineStatus(dir, 'none').valid, false); // fresh repo, no baseline
  write('a.txt', '1'); g('add', '.'); g('commit', '-qm', 'c1');
  const sha = headSha(dir);
  assert.deepEqual(baselineStatus(dir, sha), { git: true, valid: true, reason: null });
  assert.match(baselineStatus(dir, 'deadbeef'.repeat(5)).reason, /object missing/);
});

test('baselineStatus: reset below baseline ⇒ not an ancestor ⇒ baseline lost', () => {
  const { dir, g, write } = repo();
  write('a.txt', '1'); g('add', '.'); g('commit', '-qm', 'c1');
  const c1 = headSha(dir);
  write('a.txt', '2'); g('add', '.'); g('commit', '-qm', 'c2');
  const c2 = headSha(dir);
  g('reset', '-q', '--hard', c1); // history rewind: c2 exists but is no ancestor
  const st = baselineStatus(dir, c2);
  assert.equal(st.valid, false);
  assert.match(st.reason, /not an ancestor/);
});

test('changedSet: committed + staged + worktree + untracked all unioned (A1)', () => {
  const { dir, g, write } = repo();
  write('base.txt', 'base'); g('add', '.'); g('commit', '-qm', 'baseline');
  const baseline = headSha(dir);

  write('committed.txt', 'x'); g('add', 'committed.txt'); g('commit', '-qm', 'work'); // mid-session commit
  write('staged.txt', 'y'); g('add', 'staged.txt'); // staged, not committed
  write('worktree.txt', 'z'); g('add', 'worktree.txt'); g('commit', '-qm', 'w2');
  fs.appendFileSync(path.join(dir, 'worktree.txt'), 'more'); // dirty on top of commit
  write('sub/untracked.txt', 'u'); // never staged

  const files = changedSet(dir, baseline);
  for (const p of ['committed.txt', 'staged.txt', 'worktree.txt', 'sub/untracked.txt']) {
    assert.ok(inChangedSet(files, p), `${p} must be in the baseline-anchored changed set`);
  }
  assert.ok(!inChangedSet(files, 'base.txt'), 'pre-baseline file must NOT be attributed');
  assert.equal(files.get('sub/untracked.txt').untracked, true);
  assert.match(summarize(files), /^4 files, \+/);
});

test('changedSet: case-insensitive membership (NFR-C3)', () => {
  const { dir, g, write } = repo();
  write('a.txt', '1'); g('add', '.'); g('commit', '-qm', 'c1');
  const baseline = headSha(dir);
  write('Src/File.TS', 'x');
  const files = changedSet(dir, baseline);
  assert.ok(inChangedSet(files, 'src/file.ts'));
});

test('non-ASCII filenames survive (quotepath): città.txt is a real key, not octal soup', () => {
  const { dir, g, write } = repo();
  write('a.txt', '1'); g('add', '.'); g('commit', '-qm', 'c1');
  const baseline = headSha(dir);
  write('città.txt', 'ciao');
  write('café notes.md', 'x');
  const files = changedSet(dir, baseline);
  assert.ok(inChangedSet(files, 'città.txt'), [...files.keys()].join(','));
  assert.ok(inChangedSet(files, 'café notes.md'));
});

test('renames keep BOTH sides in the changed set (git mv after write)', () => {
  const { dir, g, write } = repo();
  write('old-name.ts', 'const x = 1;\nconst y = 2;\n'); g('add', '.'); g('commit', '-qm', 'c1');
  const baseline = headSha(dir);
  g('mv', 'old-name.ts', 'new-name.ts');
  g('commit', '-qm', 'rename');
  const files = changedSet(dir, baseline);
  assert.ok(inChangedSet(files, 'new-name.ts'), 'new side present');
  assert.ok(inChangedSet(files, 'old-name.ts'), 'old side present — the written path must stay corroborated');
});

test('no double-counting: staged/committed lines are not summed twice', () => {
  const { dir, g, write } = repo();
  write('a.txt', 'base\n'); g('add', '.'); g('commit', '-qm', 'c1');
  const baseline = headSha(dir);
  write('a.txt', 'base\nline2\nline3\n'); // +2
  g('add', 'a.txt'); // staged: same +2 visible from both diff sources
  let files = changedSet(dir, baseline);
  assert.equal(files.get('a.txt').ins, 2, `staged edit must not double: ${JSON.stringify([...files])}`);
  g('commit', '-qm', 'c2'); // committed: still +2 vs baseline
  files = changedSet(dir, baseline);
  assert.equal(files.get('a.txt').ins, 2, 'committed edit must not double');
});
