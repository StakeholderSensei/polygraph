# Live-probe drift protocol

polygraph's exit-code detection rests on **empirically-verified** Claude Code behavior
(observed on 2.1.59: exec-form hooks are ignored → string form, tracked upstream at
[#77160](https://github.com/anthropics/claude-code/issues/77160); the Bash `tool_response`
carries no exit-code field; a nonzero exit routes to `PostToolUseFailure` with
`error: "Exit code N\n…"`). This routing is undocumented and can drift between Claude Code
versions — so on every observed version bump, re-run the **dichotomy canary**:

One short live session in a throwaway sandbox with the dev plugin installed, covering ALL of:

1. **exit 0** — e.g. `echo ok` → must land as `PostToolUse`; ledger `exit_source: "harness_event"`, `exit_code: 0`.
2. **exit 3** — e.g. `node -e "process.exit(3)"` → must land as `PostToolUseFailure`; ledger `exit_source: "failure_text"`, `exit_code: 3`.
3. **run_in_background command** — must NEVER record `exit_code: 0` (a job acknowledgement is not a completion); expected `exit_source: "unknown"` with `background: true`.

Record the Claude Code version (`claude --version`) and the three resulting ledger lines. Any
deviation ⇒ stop, re-derive the detection strategy, and update the synthesized bench payloads
(`bench/lib/payloads.mjs`) to match the new reality before trusting a run. If upstream fixes
exec-form hooks (#77160), the string-form workaround can revert to the documented form.
