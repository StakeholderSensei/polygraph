// Every hooks.json command line must survive plugin-root AND project paths
// containing spaces — string-form commands re-introduce the quoting hazard
// the (broken-on-2.1.59) exec form existed to avoid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooksJson = JSON.parse(fs.readFileSync(path.join(REPO, 'hooks', 'hooks.json'), 'utf8'));

// plugin root and project dir BOTH contain spaces
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-test-'));
const pluginRoot = path.join(base, 'plugin root with spaces');
const projectDir = path.join(base, 'project dir with spaces');
fs.cpSync(path.join(REPO, 'scripts'), path.join(pluginRoot, 'scripts'), { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });

function allCommands() {
  const out = [];
  for (const [event, registrations] of Object.entries(hooksJson.hooks)) {
    for (const reg of registrations) {
      for (const h of reg.hooks) out.push({ event, command: h.command });
    }
  }
  return out;
}

const payloadFor = (event, cwd) => JSON.stringify({
  hook_event_name: event, session_id: 's_spaces', cwd, permission_mode: 'default',
  ...(event === 'PostToolUse'
    ? { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'echo hi' },
        tool_response: { stdout: 'hi\n', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }
    : {}),
  ...(event === 'PostToolUseFailure'
    ? { tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'boom' }, error: 'Exit code 1\n', is_interrupt: false }
    : {}),
  ...(event === 'UserPromptSubmit' ? { prompt: 'hello' } : {}),
  ...(event === 'Stop' ? { stop_hook_active: false, last_assistant_message: 'x' } : {}),
});

const shells = [
  { name: 'bash', run: (cmd, input, cwd) => spawnSync('bash', ['-lc', cmd], { input, cwd, encoding: 'utf8', timeout: 20000 }) },
  { name: 'cmd', run: (cmd, input, cwd) => spawnSync('cmd.exe', ['/d', '/s', '/c', cmd], { input, cwd, encoding: 'utf8', timeout: 20000, windowsVerbatimArguments: true }) },
];

for (const shell of shells) {
  const probe = shell.run('node --version', '', projectDir);
  const available = probe.status === 0;
  for (const { event, command } of allCommands()) {
    test(`[${shell.name}] ${event} command survives spaces in both paths`, { skip: !available && `${shell.name} unavailable` }, () => {
      const cmd = command.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
      const res = shell.run(cmd, payloadFor(event, projectDir), projectDir);
      assert.equal(res.status, 0, `exit 0 expected; stderr: ${res.stderr}`);
    });
  }
}

test('hook execution in spaced paths actually wrote state (not just exited 0)', () => {
  const ledger = path.join(projectDir, '.polygraph', 'ledger.jsonl');
  assert.ok(fs.existsSync(ledger), 'ledger must exist in the spaced project dir');
  const kinds = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).kind);
  assert.ok(kinds.includes('session_start'), 'SessionStart recorded');
  assert.ok(kinds.includes('command'), 'PostToolUse recorded');
  assert.ok(kinds.includes('tool_fail'), 'PostToolUseFailure recorded');
});
