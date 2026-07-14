---
description: Show the polygraph evidence table (receipts) — requirement × status × proof for this project
argument-hint: [session]
disable-model-invocation: false
---

Receipts, rendered by the deterministic engine (the exact same check implementation the gate uses — FR-4.4):

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/polygraph.mjs" receipts $ARGUMENTS`

Render the table above **verbatim, in a single code block**. Do not edit, reorder, summarize, or "improve" statuses, glyphs, or the VERDICT line — the receipt must match the gate byte-for-byte. After the code block you may add at most one sentence pointing at unresolved items.
