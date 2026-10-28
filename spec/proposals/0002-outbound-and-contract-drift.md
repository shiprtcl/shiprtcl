# SEP-0002: Outbound translation and contract drift

- **Author(s):** Srishesh Archik
- **Status:** Draft
- **Created:** 2026-10-29
- **Spec sections affected:** §2 (terminology), §5 (contracts), §7 (resolution), §9 (lifecycle), §11 (events), §13 (security); new section
- **Breaks fingerprints?** no

## Summary

SHIPRTCL v0.1 detects drift by fingerprinting payloads it **receives**. Outbound calls invert the problem. When your application writes to a vendor — creating an invoice in an accounting API, upserting a contact in a CRM — the payload is yours and its structure is stable. What drifts is the **vendor's contract**: the request schema it accepts. A fingerprint of your own payload never changes, so v0.1 cannot see this drift at all.

This SEP introduces **contract drift**. It covers how an engine learns that a target contract changed, how it repairs the outbound mapping with the existing machinery (matcher, SML, lifecycle), and the stricter safety rules that writes with side effects require.

## Motivation

A typical failure: an application posts `{"customer_id": "42", "lines": [...]}` to an accounting API. A new API version requires `{"CustomerRef": {"value": "42"}, "Line": [...]}`. The vendor answers `400`, and invoices silently stop being created until someone reads the logs. Teams solve this with hand-maintained, per-vendor serializers, which is the same adapter tax SHIPRTCL removes on the inbound side.

## Model

- **Canonical contract (C).** The structure your application emits. It is owned by you and changes only when you change it.
- **Target contract (T@n).** The structure the vendor accepts at version *n*. It is owned by the vendor and changes without your consent.
- **Egress rule.** An SML rule (§6) mapping C → T@n. It is keyed by `(C, T, n)`. The source fingerprint is still recorded, but since C is stable it rarely varies.

The engine applies the active egress rule to every outbound request body, validates the result against **T@n**, and forwards only valid bodies.

## Specification (proposed normative text)

### 1. Target contracts are versioned

A target contract document adds `version` (an opaque, orderable string) and an OPTIONAL `source` describing where it came from:

```json
{ "id": "vendor.invoice.create", "version": "2026-10-01", "source": { "type": "openapi", "url": "https://…/openapi.json", "pointer": "/components/schemas/Invoice" },
  "schema": { "...": "§5.2 subset" } }
```

Importers from OpenAPI 3.x and JSON Schema are RECOMMENDED. Constructs outside the §5.2 subset MUST be reported, not silently dropped.

### 2. Detecting contract drift

An engine MUST support at least the first of these signals, and SHOULD support all three:

1. **Schema change.** A newly imported version T@n+1 differs from T@n. The engine computes the shape diff of the two schemas and emits `org.shiprtcl.contract.changed` (`contract`, `from`, `to`, `diff`).
2. **Rejection.** The vendor rejects a request produced by an active egress rule with a validation-class error (`400`, `422`, or a configured vendor error code). The engine emits `org.shiprtcl.rule.rejected` (`rule`, `status`, `vendorError` with values removed) and marks the rule `suspect`.
3. **Deprecation notice.** Responses carrying `Deprecation` (RFC 9745) or `Sunset` (RFC 8594) headers emit `org.shiprtcl.contract.deprecating`.

A rejection alone does not reveal the new contract. The engine MUST NOT probe the vendor with guessed request variations, because every probe is a potential write.

### 3. Repairing: contract-to-contract matching

When T@n+1 is known, the engine synthesizes a new egress rule C → T@n+1. Two strategies are RECOMMENDED, in order:

1. **Composition.** Run the §8.1 matcher between the shapes of T@n and T@n+1 to obtain a *bridge* (T@n → T@n+1). Compose it with the active rule (C → T@n). Composition of SML field lists is defined field by field: `to` of the inner rule meets `from` of the outer rule, and `cast` operations compose left to right. Composition is preferred because it preserves decisions a human already reviewed.
2. **Direct matching.** Run the matcher directly from C's shape to T@n+1.

Model synthesizers MAY be used under the same constraints as §8.2–§8.3. They see schemas only. On the outbound side, no payload values exist in the synthesis input at all.

### 4. Lifecycle: no automatic activation for writes

Outbound requests have side effects, so the activation policy (§9.2) is stricter:

- An egress rule MUST NOT become `active` without explicit human approval, whatever its confidence or method. Policies MAY relax this only per contract and only for operations the operator marks idempotent and reversible.
- A `shadow` egress rule MUST NOT send writes. Shadow mode means a **dry run**: translate, validate against T@n+1, and record the result. Where the vendor offers a validation-only or sandbox endpoint, the engine MAY send the translated body there.
- `const`, `default`, `enum` and `scale` remain reserved for human authors (§8.3). This matters even more outbound, because a fabricated default here becomes a real record at the vendor.

### 5. Blocking and replay

When no active egress rule yields a body valid against the current target contract:

- **Synchronous callers** receive an RFC 9457 problem (`https://shiprtcl.org/problems/blocked-write`) and the vendor is not called.
- **Asynchronous senders** MUST queue the request in quarantine (§10.5) and MUST preserve any idempotency key (for example `Idempotency-Key`, or a vendor-specific request id), so a replay after approval cannot create duplicates.

### 6. Events

New types: `org.shiprtcl.contract.changed`, `org.shiprtcl.contract.deprecating`, `org.shiprtcl.rule.rejected`, `org.shiprtcl.payload.blocked`. As in §11, event data MUST NOT contain payload values; vendor error messages MUST have values removed before they are recorded.

### 7. Conformance

A new level, **SHIPRTCL Egress**: Engine conformance plus §1–§6 of this SEP.

## Security and privacy considerations

- Outbound mistakes are writes. Hence the mandatory human activation (§4) and the no-probing rule (§2).
- Imported vendor schemas are untrusted input. Schema text such as descriptions and titles enters synthesizer prompts, so it is a prompt-injection channel just like key names. The §8.3 verification bounds the impact.
- The engine holds vendor credentials. It MUST run inside the caller's trust boundary.

## Alternatives considered

- **Generate client SDKs from OpenAPI on every change.** This works for typed languages and complements this SEP, but it still needs a code change and a deploy for every vendor change. SEP-0002 keeps the mapping as reviewable data.
- **Infer the new contract from error messages.** Rejected. Vendor errors are unstructured and inconsistent, and learning by trial means making writes.

## Open questions

1. Should composition be normative, or only RECOMMENDED?
2. How should an egress rule handle **enum** changes on the vendor side (e.g. a status vocabulary rename)? Human-authored `enum` maps only, or a reviewed suggestion workflow?
3. Should `T@n` be pinned per request (a header) so that callers can migrate gradually?

## Reference implementation

Not yet started. Planned for `shiprtcl` 0.3, starting with an OpenAPI importer and composition.
