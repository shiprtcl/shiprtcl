# Security Policy

SHIPRTCL sits in the path of webhooks that often carry payments and personal data, so we take security reports seriously.

## Reporting a vulnerability

Please **do not** open a public issue. Instead, use either:

- GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this repository, or
- email **security@shiprtcl.org**.

Include affected versions, a description, and reproduction steps or a proof of concept. We aim to acknowledge reports within **3 business days** and to agree a disclosure timeline with you, normally within 90 days. We're happy to credit reporters.

## Scope

In scope:

- the reference implementation in `packages/shiprtcl` (engine, matcher, synthesizer verification, proxy, signatures);
- **specification-level weaknesses**: ways a conforming engine could leak payload values to a synthesizer, deliver unvalidated output, or be steered by an upstream into an unsafe rule. These are as important to us as code bugs.

Especially interesting: bypasses of the synthesizer-output verification (spec §8.3), value leakage into events or errors (§11), signature-verification flaws (§10.3), and shape-flooding or cost-amplification attacks (§10.6).

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (draft) | ✅ |
