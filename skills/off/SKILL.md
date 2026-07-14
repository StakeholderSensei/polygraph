---
description: Disable polygraph for this repo (user-only escape hatch; all hooks no-op)
argument-hint: [--repo]
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/polygraph.mjs" mode off $ARGUMENTS`

Report to the user exactly what the line above says. polygraph is now **off**: contract capture, ledger, and the gate are all disabled. Re-enable with `/polygraph:on` (add `--repo` to persist either way as committed repo policy).
