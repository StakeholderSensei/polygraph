---
description: Enable polygraph (mode standard by default; strict/confess optional)
argument-hint: [standard|strict|confess] [--repo]
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/polygraph.mjs" mode $ARGUMENTS`

Report to the user exactly what the line above says. Modes: `standard` blocks unproven completions (max 2 blocks, then honest-confession path); `strict` adds mandatory verifier verdicts; `confess` never blocks, only asks for honesty. `--repo` persists to `.polygraph/config.json`.
