# Contributing to polygraph

Thanks for considering it. polygraph is a verification tool, so the bar is simple: **changes come with evidence.**

## Ground rules

- **Zero runtime dependencies.** No `package.json` deps, no `node_modules` — if you reach for a package, it's probably a few lines of Node stdlib.
- **Tests and bench stay green.** New behavior needs a test; new gate logic needs a bench scenario.
- **Never weaken a check to make a flow pass.** The M3 = 0% rule (no wrong verdicts) is non-negotiable. Fix the flow, or degrade to `unknown` — never to a false pass.
- Match the surrounding style: plain ESM, `node:` builtins only, terse comments that state a constraint rather than narrate the code.

## Running it

```bash
node --test tests/*.test.mjs   # the full suite
node bench/run.mjs             # end-to-end bench scenarios
node bench/metrics.mjs         # the metric run (catch rate / false positives / latency / tokens)
```

## Pull requests

Keep them focused. In the description, say what you changed and **paste the green test/bench output**. Bring receipts — it's the whole point.
