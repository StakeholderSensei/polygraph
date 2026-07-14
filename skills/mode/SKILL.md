---
description: Set polygraph severity mode (strict / standard / confess) for this repo
argument-hint: <strict|standard|confess> [--repo]
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/polygraph.mjs" mode $ARGUMENTS`

Report to the user exactly what the line above says. `standard` blocks unproven completions (max 2 blocks, then the honest-confession path); `strict` additionally requires verifier verdicts on diff/cmd items; `confess` never blocks — it only asks for an honest confession. `--repo` persists to `.polygraph/config.json` as committed policy.
