# Security Policy

## What polygraph is (and isn't)

polygraph is a **proof-of-done gate**, not a security sandbox. It raises the cost of a false "done" from zero to real — it does not claim to contain an adversary who controls the shell.

Its tamper detection covers the **Edit/Write path**: a model rewriting its own state files under `.polygraph/` via those tools is caught. A model determined to evade its own gate through raw **Bash** (fabricating `verdicts.json`, editing the ledger, deleting the shadow) is explicitly **out of scope for v0.1** and documented in the README threat model. Treat polygraph as a trust aid, not an adversarial containment boundary.

## The bug class that matters most

A **false PASS** — the gate emitting "verified" for work that was not actually done, through the Edit/Write path — is the integrity failure polygraph exists to prevent (the M3 = 0% invariant: no wrong verdicts). If you find one, we want to hear about it.

## Reporting a vulnerability

Please report privately, not in a public issue:

- **GitHub Security Advisories** — the repo's **Security** tab → **Report a vulnerability**.

Include a reproduction: a contract + ledger state, or a session transcript, that produces a wrong verdict. Bring receipts.

## Supported versions

Security fixes land on the latest release. Current: `v0.1.0`.
