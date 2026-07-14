// payloads.mjs — synthesized hook payloads. THE single calibration point:
// shapes below mirror the LIVE PROBE observations so every scenario
// exercises reality, not assumptions.
export const CALIBRATION = {
  source: 'observed — Claude Code 2.1.59 (harness-dichotomy; re-verify per bench/PROBE_PROTOCOL.md)',
  bash_success_response: '{stdout, stderr, interrupted, isImage, noOutputExpected} — NO exit-code field',
  bash_failure: 'PostToolUseFailure with error "Exit code N\\n<output>" + is_interrupt',
};

const base = (sid, cwd, extra) => ({
  session_id: sid,
  cwd,
  transcript_path: `${cwd}/.fake-transcript.jsonl`,
  permission_mode: 'default',
  ...extra,
});

export const sessionStart = (sid, cwd, source = 'startup') =>
  base(sid, cwd, { hook_event_name: 'SessionStart', source });

export const write = (sid, cwd, toolUseId, filePath, content) =>
  base(sid, cwd, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_use_id: toolUseId,
    tool_input: { file_path: filePath, content },
    tool_response: { type: 'create', filePath },
  });

export const edit = (sid, cwd, toolUseId, filePath, oldString, newString) =>
  base(sid, cwd, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_use_id: toolUseId,
    tool_input: { file_path: filePath, old_string: oldString, new_string: newString },
    tool_response: { filePath },
  });

/** Successful Bash — the observed 2.1.59 success shape (no exit-code field). */
export const bashOk = (sid, cwd, toolUseId, command, opts = {}) =>
  base(sid, cwd, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: toolUseId,
    tool_input: { command, ...(opts.background ? { run_in_background: true } : {}) },
    tool_response: {
      stdout: opts.stdout ?? '',
      stderr: opts.stderr ?? '',
      interrupted: opts.interrupted ?? false,
      isImage: false,
      noOutputExpected: false,
    },
  });

/** Unrecognizable response shape — must stay exit_source "unknown" (FR-2.6). */
export const bashOpaque = (sid, cwd, toolUseId, command, opts = {}) =>
  base(sid, cwd, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: toolUseId,
    tool_input: { command, ...(opts.background ? { run_in_background: true } : {}) },
    tool_response: { blob: 'opaque' },
  });

/** Failing Bash — the observed failure channel: error text leads "Exit code N". */
export const bashFailure = (sid, cwd, toolUseId, command, exitCode, outputText = '') =>
  base(sid, cwd, {
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_use_id: toolUseId,
    tool_input: { command },
    error: `Exit code ${exitCode}\n${outputText}\n\n${outputText}`,
    is_interrupt: false,
  });

export const userPrompt = (sid, cwd, prompt) =>
  base(sid, cwd, { hook_event_name: 'UserPromptSubmit', prompt });

export const stop = (sid, cwd, stopHookActive = false, lastMessage = 'Done!') =>
  base(sid, cwd, { hook_event_name: 'Stop', stop_hook_active: stopHookActive, last_assistant_message: lastMessage });
