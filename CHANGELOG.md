# Changelog

All notable changes to polygraph. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions match `.claude-plugin/plugin.json`.

## 0.1.0

First public release — the deterministic proof-of-done gate for Claude Code.

### Added

- **Contract capture** (UserPromptSubmit) — verifiable requirements snapshotted into `.polygraph/POLYGRAPH.md`; skip heuristics keep Q&A turns from creating noise; Unicode-aware keyword matching for non-English prompts.
- **Evidence ledger** (PostToolUse) — append-only record of file writes and commands with real exit codes, taken from hook payloads, never model narration. Exit codes derived from Claude Code's own event routing (harness-dichotomy: success → PostToolUse, failure → PostToolUseFailure); unknown ≠ pass.
- **The gate** (Stop) — reconciles contract vs ledger vs `git diff` against a baseline commit. Checks: contract parse, item closure, contract monotonicity (no silent requirement deletion), per-type evidence resolution (`diff`/`test`/`cmd`/`manual`), test staleness, and a state-tamper partition. Blocks unproven completions; the honest confession path always unlocks.
- **Receipts** — `/polygraph:status` renders the evidence table; `receipt.md` carries a machine-readable payload. Rendered by the same check implementation as the gate, so a receipt can never disagree with it.
- **Verifier subagent** (`strict` mode) — a read-only skeptic that judges whether a diff or command actually satisfies each requirement; verdicts are deterministically screened and honored (a fresh `unmet` blocks in any mode).
- **Gate-authored repair** — on a format-only block, the gate emits the corrected contract line(s) to copy back; syntax-and-restoration only, never semantics (a repaired-but-unproven check-off still fails on evidence).
- **Modes** `off` / `confess` / `standard` / `strict`; per-session and committable per-repo config; user-only kill switch.
- **Cross-platform**: Windows, macOS, Linux; Node ≥ 18, zero dependencies; git optional; lock-hardened atomic state writes for sync-folder (OneDrive/Dropbox) safety.
- **Bench + test suite** shipped in-repo — 200+ tests, end-to-end bench scenarios, and a metric harness (`node bench/metrics.mjs`) that goes INVALID on manifest drift.

### Notes

- Repository trimmed to product files for public release: the development spec (PRD) and per-milestone build evidence were moved to a separate archive; the plugin, its skills/agent/hooks, the bench, and the test suite remain — for a verification tool, the suite and bench are the credibility.
- Exit-code detection is pinned to observed Claude Code behavior and re-verified on version bumps (see `bench/PROBE_PROTOCOL.md`); tracks upstream [anthropics/claude-code#77160](https://github.com/anthropics/claude-code/issues/77160) (exec-form hooks) to revert to the documented hook form when fixed.

[unreleased backlog: 3-OS CI matrix, `cmd`-item path corroboration, per-session contract files, PreCompact/SubagentStop hooks]
