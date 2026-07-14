// sandbox.mjs — every bench run executes in a throwaway repo under
// %TEMP%\polygraph-bench\<run-id>\ (local disk, outside any synced folder)
// and is cleaned up afterwards. Only reports flow back into the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BENCH_ROOT = path.join(os.tmpdir(), 'polygraph-bench');

export function makeSandbox(files = {}, { git = false } = {}) {
  const runId = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(BENCH_ROOT, runId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  if (git) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'bench'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'bench@local'], { cwd: dir });
  }
  return dir;
}

export function cleanup(dir) {
  if (!dir.startsWith(BENCH_ROOT)) throw new Error(`refusing to clean outside bench root: ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
