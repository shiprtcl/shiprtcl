# Changelog

All notable changes to the SHIPRTCL specification and reference implementation.

## [0.1.0] — 2026-10-29

First public draft.

### Specification
- IAST normalization for JSON, form-urlencoded, CSV/TSV, XML and YAML (§3).
- `sr1` structural fingerprint: shape paths with `~*` wildcard, map classification, NFC keys, code-point ordering, RFC 8785 canonical form, SHA-256 (§4).
- Contract format over a JSON Schema 2020-12 subset (§5).
- SHIPRTCL Mapping Language (SML) with 8 members and a defined evaluation order (§6).
- Resolution: exact lookup, absorption with rename detection, single-flight synthesis (§7).
- Synthesis privacy boundary and output verification (§8); rule lifecycle (§9); runtime (§10); CloudEvents vocabulary (§11); conformance levels (§12).

### Reference implementation (`shiprtcl` 0.1.0)
- Engine, deterministic matcher, OpenAI-compatible synthesizer adapter.
- Proxy: GitHub/Stripe/HMAC verification, async 202, dedupe, retries, Standard Webhooks re-signing, AES-256-GCM quarantine, file-backed rule store, admin API.
- CLI: `shiprtcl fingerprint`, `shiprtcl serve`.
- 22 conformance vectors, 37 tests, fast-path benchmark.
