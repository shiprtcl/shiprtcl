# Contributing to SHIPRTCL

Thanks for helping. SHIPRTCL is a protocol first and an implementation second, so contributions come in a few distinct shapes.

## Ways to contribute

| You want to… | Do this |
|---|---|
| Report a bug in the reference implementation | Open a **Bug report** issue with a minimal payload + contract. |
| Question or challenge the spec | Open a **Spec feedback** issue quoting the section (e.g. §4.4). |
| Change the spec | Write a **SHIPRTCL Enhancement Proposal** (see below). |
| Contribute a real-world drift | Open a **Drift example** issue (see "Drift corpus"). |
| Write another implementation | Go ahead! Pass `conformance/fingerprint-vectors.json` and tell us; we'll list it. |
| Report a vulnerability | **Don't open an issue.** See [SECURITY.md](SECURITY.md). |

## Development

Requirements: Node.js ≥ 20.

```bash
npm install
npm run build     # compile packages/shiprtcl
npm test          # 37 tests incl. all conformance vectors
npm run vectors   # regenerate conformance vectors (only when §4 changes!)
npm run bench     # fast-path benchmark
npm run site      # build public/ (the website + playground)
npm run all       # all of the above
```

Guidelines:

- Keep the reference implementation **dependency-free at runtime**. Dev dependencies are fine.
- Every behaviour the spec describes should have a test. Every spec change needs a matching code and test change in the same PR.
- **Never** let payload values reach error messages, events or synthesizer input. Tests check for this; keep it that way.
- Changing the output of `fingerprint()` is a breaking protocol change. It requires a SEP and a new fingerprint prefix (`sr2:`).
- Commit `public/` after running `npm run site` when you change site sources, so the deployed site stays in sync.

## SHIPRTCL Enhancement Proposals (SEPs)

Substantive spec changes go through a SEP:

1. Copy [`spec/proposals/0000-template.md`](spec/proposals/0000-template.md) to `spec/proposals/0000-short-title.md`.
2. Open a PR. Discussion happens on the PR.
3. The editors assign a number once the proposal has been discussed, and record a decision: accepted, rejected or deferred.
4. Accepted SEPs are merged into the spec in the next draft version.

Editorial fixes (typos, clarifications that don't change behaviour) can be plain PRs.

## Drift corpus

We want an open, labelled corpus of real-world structural drifts, to measure matcher and synthesizer accuracy (whitepaper §10, item 9). Please contribute **shapes, not payloads**:

```bash
node packages/shiprtcl/dist/cli.js fingerprint before.json   # paths + types only
node packages/shiprtcl/dist/cli.js fingerprint after.json
```

Submit both shapes, the provider and API version if public, and the correct mapping. Never submit real values or secrets.

## Developer Certificate of Origin

By contributing, you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/). Please sign off your commits:

```bash
git commit -s -m "your message"
```

Code contributions are licensed under Apache-2.0. Contributions to `spec/` and `whitepaper/` are licensed under CC-BY-4.0.

## Code of Conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
