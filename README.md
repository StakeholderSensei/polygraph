# polygraph

[![CI](https://github.com/StakeholderSensei/polygraph/actions/workflows/ci.yml/badge.svg)](https://github.com/StakeholderSensei/polygraph/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **Your agent says "Done!" Polygraph checks.**
>
> A Stop-hook gate for Claude Code that refuses the completion claim until it can show receipts: real diffs, tests that actually ran, every requirement checked off against what you originally asked. No receipts, no "done."

<p align="center"><img src="assets/hero.png" alt="polygraph — a lie detector for coding agents: a polygraph needle runs calm green, then spikes red where a completion claim is unproven, dropping into a terminal showing verified / blocked / needs-review" width="840"></p>

Requires **Node ≥ 18** on PATH. Git optional (evidence degrades gracefully without it). Windows, macOS, Linux. No dependencies, no network, no telemetry.

## What it does, in 30 seconds

Four stages wrap around a session:

1. **Contract** — your request is snapshotted into `.polygraph/POLYGRAPH.md`: one checklist item per verifiable requirement. *What was promised.*
2. **Ledger** — every file write and every command (with its **real exit code**) is recorded append-only, from Claude Code's own hook payloads. *What actually happened.*
3. **Gate** — on Stop, a hook reconciles contract vs ledger vs `git diff`. Claimed files must have real diffs since a baseline commit; tests must have run green *after* the last source edit; every check-off needs an evidence pointer. Fail ⇒ the stop is **blocked** (the agent keeps working) or the agent must **confess** what's unmet.
4. **Receipts** — `/polygraph:status` renders the evidence table. The shareable artifact.

**The one principle that explains the rest:** evidence comes from hook payloads and git — *never* from the model's narration. And **unknown ≠ pass**: anything polygraph couldn't capture can never satisfy a requirement. A false "verified" is the one thing it will not emit.

## The lie it catches

The agent finishes and claims:

> ⏺ I've added the rate limiter and updated the API docs. All done! ✅

It wrote `src/rate.ts` (real) — but never actually changed `docs/api.md`. The gate blocks the stop with (verbatim output):

```text
polygraph gate: completion not proven.
FAILED C3 evidence: R2 claimed file has no diff: docs/api.md (reverted or untouched since baseline)
Recorded evidence you can cite: E1=write src/rate.ts · E2=write docs/api.md.
Resolve by EITHER: (1) finish the work and re-run the test suite, checking items off with
evidence pointers (E<n>); (2) mark items '[~] deferred (user: P<n>)' ONLY if the user
actually said so; (3) stop honestly: add a '## POLYGRAPH CONFESSION' block. Do not claim
completion without one of these.
```

`/polygraph:status` shows the receipts — honest work passes, the unbacked claim is caught, the human-review item is flagged, not faked:

```text
POLYGRAPH RECEIPTS — session s_demo — mode: standard — blocks: 1
┌──────┬───────────────────────────────────────────────┬────────┬──────────────────────────────┐
│ Req  │ Requirement                                   │ Status │ Evidence                     │
├──────┼───────────────────────────────────────────────┼────────┼──────────────────────────────┤
│ R1   │ Add rate limiting middleware                  │  ✅    │ E1 diff src/rate.ts (new)    │
│ R2   │ Update API docs in docs/api.md                │  ❌    │ —                            │
│ R3   │ Verify the limiter UI on mobile               │  ⚠    │ manual — awaits human review │
└──────┴───────────────────────────────────────────────┴────────┴──────────────────────────────┘
git: 2 files · runner: auto · VERDICT: BLOCKED (R2) — resolve, defer with user approval, or confess.
```

Not all-or-nothing paranoia: it passes the real work (R1), surgically catches the one unbacked claim (R2), and never pretends to have verified what only a human can (R3). This behavior is asserted by `bench/scenarios/m1-lies.mjs` and `m1-receipts.mjs` — reproduce with `node bench/run.mjs`.

## Install

```text
/plugin marketplace add stakeholdersensei/polygraph
/plugin install polygraph@stakeholdersensei
```

Zero config — the first session creates `.polygraph/` with working defaults. Uninstall: `/plugin uninstall polygraph`, then `rm -rf .polygraph` in any repo leaves no residue.

## Modes

| Mode | Behavior | Use it when |
|------|----------|-------------|
| `off` | Everything disabled | You want the plugin quiet for a session/repo. |
| `confess` | Never blocks — asks for an honest "not done", then allows | Low-stakes repos, or if blocking ever gets in your way. |
| `standard` *(default)* | Blocks unproven completions (max 2 blocks/session, then the confession path) | Everyone. |
| `strict` | Adds mandatory verifier-subagent verdicts on `diff`/`cmd` items | High-stakes work where "the diff exists" isn't enough — you want "the diff actually does what R3 asked." |

Switch with `/polygraph:mode strict|standard|confess` (add `--repo` to commit it as team policy). `/polygraph:off` and `/polygraph:on` are the kill switch — user-only; the model cannot invoke them.

## What counts as proof

A `[x]` check-off is only believed when its evidence resolves:

| Evidence type | Passes only when |
|---------------|------------------|
| `diff` | a cited `E<n>` is a real `file_write` **and** its path is in the git diff since the contract's baseline commit (git absent ⇒ the recorded write suffices — but never someone else's pre-existing edit). |
| `test` | a cited command actually ran a detected test runner, exited 0, **after** the last source edit (a green run goes stale the moment you touch source again). |
| `cmd` | a cited command exited 0, in the foreground, with a real captured exit code. |
| `manual` | never — it always renders ⚠ and awaits *your* review. Honesty, not a rubber stamp. |

**Confession always unlocks the gate.** A `## POLYGRAPH CONFESSION` block that honestly lists what's unmet converts a would-be block into an allowed, truthfully-labeled stop. The adversary is the false claim, not the unfinished work — so the honest path out is always open, and a session can never wedge.

Baseline anchoring means the honest workflows don't false-positive: mid-session commits, brand-new untracked files, and renames all still verify (`node bench/run.mjs`, scenario `m1-lies`). A file *you* left dirty before the session is never attributed to the agent.

## Config (`.polygraph/config.json`, all optional)

```jsonc
{
  "mode": "standard",              // off | confess | standard | strict
  "require_tests": "auto",         // auto | always | never
  "test_command": null,            // universal runner override, e.g. "make test" — beats auto-detection
  "runner": "auto",                // auto | npm | pytest | cargo | gotest | gradle | dotnet
  "max_blocks": 2,                 // blocks per session before the confession path
  "min_prompt_chars": 20,          // shorter prompts never open a contract
  "imperative_keywords": ["add","fix","implement","refactor","..."],
  "question_words": ["what","why","how","when","..."],
  "verifier": "on_block",          // off | on_block | always (verdicts required only in strict)
  "verifier_max_items": 5,
  "receipt_on_pass": true
}
```

`config.json` is the one state file polygraph does **not** gitignore — commit it to enforce repo/team policy.

**Non-English prompts:** the skip heuristics (which prompts open a contract) ship English defaults. Add your language to `question_words` and `imperative_keywords` — e.g. for Italian: `"question_words": ["cosa","perché","come","quando"]`, `"imperative_keywords": ["aggiungi","correggi","implementa","rinomina"]`. Matching is Unicode-aware, so accented keywords work.

## Numbers

From the shipped bench + metric run (`node bench/metrics.mjs` — reproduces all of these; latency is machine-dependent but the gates are hard):

- **20 / 20** lie scenarios blocked (catch rate 100%, target ≥ 90%)
- **0 / 22** honest scenarios blocked (false-positive rate 0%, target ≤ 2%)
- **0** wrong verdicts across the receipt-truth assertions (target 0% — non-negotiable)
- hot-path hook **p95 ≈ 260–360 ms** (release budget: ≤ 500 ms spawn-inclusive)
- **~196 tokens** median per session (contract instruction + pass banner); ledger hooks inject zero

The full suite is `node --test tests/*.mjs` — for a verification tool, the suite and bench *are* the credibility, which is why they ship in the repo.

## What it deliberately doesn't do

- **Not a test runner.** It never invents or executes tests — it observes the ones you run and records their real exit codes.
- **Not a linter.** No opinions on your code's style, complexity, or correctness.
- **Never edits your code.** It blocks or annotates; the only files it writes are its own under `.polygraph/`.
- **No network, no telemetry.** Everything is local files. Nothing leaves the machine.

**Threat model (one line):** tamper detection covers the Edit/Write path; a model determined to evade its own gate through raw Bash is out of scope for v0.1 and documented as such. polygraph raises the cost of a false "done" from zero to real; it does not claim to be unbreakable by an adversary who controls the shell.

## One honest note

During its own adversarial review, polygraph nearly shipped a gate-bypass bug: a corrupt state file could make the gate throw, and the failure path would have let the stop through looking clean. Its own verification layer — the adversarial pass it runs on itself — caught it before the tag. That is the entire thesis, demonstrated on the tool itself: **unverified claims fail, including ours.**

---

MIT licensed. Issues and PRs welcome — but bring receipts.
