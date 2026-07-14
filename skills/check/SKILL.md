---
description: Dry-run the polygraph gate now — what would it decide if the agent stopped here?
disable-model-invocation: false
---

Gate dry-run (read-only — nothing is blessed, counted, or written):

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/polygraph.mjs" gate --dry-run`

Report the decision and each failed check verbatim. Do not modify any state in response — this is a preview, not a verdict.
