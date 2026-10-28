# Governance

## Today

SHIPRTCL was created by **Srishesh Archik** ([@Srishesh-Archik](https://github.com/Srishesh-Archik)), who currently serves as **spec editor** and **lead maintainer**.

- The **spec editor** owns `spec/`, assigns SEP numbers and records SEP decisions after public discussion.
- **Maintainers** review and merge code. New maintainers are invited after sustained, high-quality contributions.
- Decisions are made in public, on issues and pull requests. The editor aims for rough consensus and explains decisions in writing.

## Versioning

- The **specification** uses `MAJOR.MINOR`. Until 1.0, minor versions may break compatibility. Anything that changes fingerprint output also changes the fingerprint prefix (`sr1` → `sr2`).
- The **reference implementation** follows semantic versioning, with its minor version tracking the spec version it implements.

## Toward 1.0

Before 1.0 we intend to have at least two independent implementations passing the conformance suite, and an open drift corpus with published accuracy results. If adoption warrants it, governance will move to a multi-stakeholder steering group with a written charter, or to a neutral foundation. That change will itself be made through a SEP.

## Trademarks

The specification is open (CC-BY-4.0) and anyone may implement it. "SHIPRTCL" as a name for the protocol and project is held by the creator. Implementations may say they "implement SHIPRTCL" or are "SHIPRTCL-conformant" when they pass the conformance suite.
