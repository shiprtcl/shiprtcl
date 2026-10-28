---
title: SHIPRTCL Specification v0.1
status: Draft
date: 2026-10-29
editor: Srishesh Archik
license: CC-BY-4.0
---

# SHIPRTCL — Self-Healing Ingestion Protocol

**Version 0.1 · Draft · 29 October 2026**

**Status of this document.** This is a working draft published for public review. It may change in incompatible ways before version 1.0. Feedback is welcome as GitHub issues or as a SHIPRTCL Enhancement Proposal (SEP); see [GOVERNANCE.md](https://github.com/shiprtcl/shiprtcl/blob/main/GOVERNANCE.md).

**Licence.** This specification is licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). The reference implementation is licensed separately under Apache-2.0.

## Abstract

SHIPRTCL defines how an ingestion component detects that the *structure* of an incoming payload has changed, and how it repairs that change with a declarative, auditable mapping rule instead of failing or passing malformed data downstream. It specifies:

1. a normalization of wire formats into a common tree (the IAST);
2. a value-independent **structural fingerprint** of that tree;
3. a **contract** format for what the downstream consumer expects;
4. the **SHIPRTCL Mapping Language (SML)**, a small, total, declarative language for translating one structure into another;
5. a **resolution procedure** — exact lookup, absorption, synthesis — for choosing which rule applies;
6. constraints on **synthesizers** (including LLMs) so they never see payload values and can never emit executable code;
7. a **rule lifecycle** with provenance, review and rollback;
8. **runtime requirements** for acknowledgement, delivery, signatures, idempotency and quarantine; and
9. a set of **audit events** expressed as CloudEvents.

## 1. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 ([RFC 2119], [RFC 8174]) when, and only when, they appear in all capitals.

JSON is as defined in [RFC 8259]. JSON Pointer is as defined in [RFC 6901]. Hexadecimal strings are lowercase.

## 2. Terminology

- **Upstream** — the party that sends payloads (a SaaS webhook, a partner, a file drop). Upstreams are untrusted: they control both the values and the key names of what they send.
- **Downstream** — the consumer that receives translated payloads and has published a contract.
- **Engine** — a component that implements this specification. A **proxy** is an engine exposed over HTTP.
- **IAST** — Intermediate Abstract Syntax Tree: a JSON value produced from any wire format by §3.
- **Shape** — the set of (shape path, type markers) pairs of an IAST value (§4).
- **Fingerprint** — a hash identifying a shape (§4.6).
- **Contract** — the downstream's declaration of the structure it accepts (§5).
- **Rule** — an SML document translating payloads of one shape into a contract (§6).
- **Drift** — the arrival of a payload whose fingerprint has no bound rule for the contract.
- **Synthesizer** — any procedure that proposes SML fields for a drift: a deterministic matcher, a language model, or a human.

## 3. Ingestion and the IAST

An engine MUST convert each payload into an IAST value before fingerprinting. The IAST is a JSON value. Conversions MUST NOT infer types from the textual content of values; where a wire format has no native types, every scalar is a string. Type coercion is the job of SML `cast` (§6), where it is explicit and audited.

### 3.1 JSON

Media types `application/json` and any `+json` suffix. The IAST is the parsed document. Duplicate object keys SHOULD be rejected; if accepted, the last occurrence wins. Numbers are carried as IEEE 754 doubles.

### 3.2 Form-urlencoded

Media type `application/x-www-form-urlencoded`. The IAST is an object. Every value is a string. A key ending in `[]` always yields an array of strings under the key without the brackets. Any other key that occurs more than once yields an array of strings in order of occurrence; a key that occurs once yields a string. No other bracket syntax is interpreted.

> Note: because a repeated key changes `STR` into `ARR`, upstreams that sometimes repeat a key produce two fingerprints. Contracts SHOULD expect this and rules MAY be absorbed (§7.2).

### 3.3 CSV and TSV

Media types `text/csv` (delimiter `,`) and `text/tab-separated-values` (delimiter TAB). Parsing follows [RFC 4180] with these clarifications: a leading UTF-8 BOM is ignored; CR, LF and CRLF all end a record; the first record is a header. The IAST is an array of objects, one per non-empty record, keyed by header names. Every cell is a string. Missing trailing cells are the empty string. Cells beyond the header width are stored under keys `_<index>` where `<index>` is the zero-based column index.

### 3.4 XML

Media types `application/xml`, `text/xml` and `+xml` suffixes. Each element becomes an object. Namespace prefixes are removed from element and attribute names. Attributes become string members named `@<name>`. Character content that is not whitespace-only becomes a string member named `#text`. **Every child element becomes an array**, even if it occurs once, so that the number of occurrences can never change the shape. A contract MAY declare singleton paths, in which case the engine MUST unwrap one-element arrays at exactly those paths. The root is an object with one member, the root element's name.

### 3.5 YAML

Media types `application/yaml` and `application/x-yaml`. Only the JSON-compatible subset (YAML 1.2 core schema) is supported. Anchors and aliases MUST be expanded with a bound on expansion size; documents exceeding it MUST be rejected. Tags other than the core schema MUST be rejected.

### 3.6 Other formats

Engines MAY support further formats. Each MUST document its normalization and MUST NOT infer scalar types from values.

> The v0.1 reference implementation supports §3.1–§3.3. §3.4 and §3.5 are specified but not yet implemented.

## 4. Structural fingerprint

### 4.1 Purpose and properties

The fingerprint identifies a payload's structure independently of its values. It MUST be:

- **value-independent** — two payloads that differ only in scalar values (not types) have the same fingerprint;
- **order-independent** — object member order does not affect it;
- **cardinality-independent** — array lengths do not affect it, except that an empty array contributes no element entry;
- **deterministic across implementations** — byte-identical canonical forms for the same IAST.

### 4.2 Type markers

| Marker | IAST value |
|---|---|
| `ARR` | array |
| `BOOL` | `true` or `false` |
| `MAP` | object classified as a map (§4.4) |
| `NULL` | `null` |
| `NUM` | number (integers and non-integers alike) |
| `OBJ` | object not classified as a map |
| `STR` | string |

The canonical order of markers is the order of this table (ASCII order).

### 4.3 Shape paths and the shape algorithm

A **shape path** is a JSON Pointer whose segments are either an escaped object key or the **wildcard segment** `~*`. The wildcard stands for "every element" of an array or "every value" of a map. `~*` cannot occur in an RFC 6901 pointer (a `~` must be followed by `0` or `1`), so it never collides with a key; a literal key `~*` is escaped as `~0*`.

The shape of a value *V* is computed by `walk(V, "")` where `walk(v, p)` is:

1. If *v* is an array: add `ARR` at *p*; for each element *e*, `walk(e, p + "/~*")`.
2. If *v* is an object: let *K* be its keys, each normalized to Unicode NFC [UAX15]. Classify it per §4.4. If it is a map, add `MAP` at *p* and for each value *e*, `walk(e, p + "/~*")`. Otherwise add `OBJ` at *p* and for each key *k*, `walk(v[k], p + "/" + escape(k))`, where `escape` replaces `~` with `~0` then `/` with `~1`.
3. Otherwise add the scalar's marker (`STR`, `NUM`, `BOOL`, `NULL`) at *p*.

"Add *M* at *p*" inserts *M* into the set of markers for path *p*. The **shape** is the list of (path, markers) pairs, sorted by path in ascending Unicode **code point** order (equivalently, UTF-8 byte order — *not* UTF-16 code unit order), with each marker set listed in canonical order. The root path is the empty string. If two keys of one object normalize to the same NFC string, their subtrees merge.

### 4.4 Map classification

Objects whose keys are data rather than schema (ids, emails, dates) would otherwise produce a new fingerprint on almost every request, and would leak data into shapes. An object at shape path *p* MUST be classified as a map if any of these holds:

1. *p* appears in the contract's `mapHints` (§5.2);
2. it has at least one key and **every** key (after NFC) fully matches at least one of:
   - `^[0-9]+$`
   - `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`
   - `^[^\s@]+@[^\s@]+\.[^\s@]+$`
   - `^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.+\-Z]*)?$`
   - `^[0-9a-fA-F]{16,}$`
   - `^[A-Za-z]{2,8}_(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{8,}$`
3. it has more than 256 keys.

An empty object is never a map unless hinted. Patterns use ECMAScript regular expression semantics.

### 4.5 Canonical form

The canonical form of a shape is the JSON array of two-element arrays `[path, markers]`, where `markers` is the marker set joined by `|`, serialized per the JSON Canonicalization Scheme [RFC 8785]. Since every element is a string, this is the ECMAScript `JSON.stringify` output with no whitespace.

Example — for

```json
{"event":"payment_success","customer":{"email":"user@example.com","id":9812},"amount":49.50,"items":["sku_1","sku_2"]}
```

the canonical form is

```
[["","OBJ"],["/amount","NUM"],["/customer","OBJ"],["/customer/email","STR"],["/customer/id","NUM"],["/event","STR"],["/items","ARR"],["/items/~*","STR"]]
```

### 4.6 Fingerprint identifier

The fingerprint is `sr1:sha256:` followed by the lowercase hex SHA-256 [FIPS 180-4] of the UTF-8 encoding of the canonical form. The example above has fingerprint

```
sr1:sha256:687cb54f1c77c419347a344b75fb970457eca760500bfec3f3d326c88171b0ae
```

The prefix `sr1` names this algorithm version. Future algorithms MUST use a different prefix. Engines MUST treat fingerprints as opaque strings when comparing.

### 4.7 Collisions

SHA-256 collisions are not a practical concern. Two distinct IASTs having the *same shape* is intended. Engines MUST NOT use the fingerprint as an integrity or authenticity check; it identifies structure only.

## 5. Contracts

### 5.1 Contract document

```json
{
  "id": "payments.v1",
  "schema": { "type": "object", "required": ["event"], "properties": { "event": { "type": "string" } } },
  "mapHints": ["/data/object/metadata"]
}
```

`id` is a string unique within an engine. A contract MUST NOT change once rules reference it; publish a new `id` instead.

### 5.2 Schema subset

`schema` is a JSON Schema [JSON-SCHEMA-2020-12] restricted to these keywords: `type`, `properties`, `required`, `additionalProperties` (boolean only), `items` (single schema), `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `title`, `description`, `$schema`, `$id`. Engines MUST reject contracts using other keywords rather than silently ignoring them. `minLength` and `maxLength` count Unicode code points.

`mapHints` is an OPTIONAL array of shape paths that MUST be classified as maps (§4.4).

Profiles that translate Zod, TypeScript or Protobuf definitions into this subset MAY be defined separately.

## 6. The SHIPRTCL Mapping Language (SML)

SML is deliberately small. It has no variables, no user-defined functions, no conditionals and no I/O. Every SML program terminates in time linear in the size of the payload. This is what makes it safe to accept rules proposed by an LLM: a rule can be *wrong*, but it cannot *do* anything except copy, rename and convert.

### 6.1 Rule document

```json
{
  "shiprtcl": "0.1",
  "id": "rule_687cb54f1c77_mvsl0a1b",
  "contract": "payments.v1",
  "source": "sr1:sha256:687cb54f…",
  "shape": [ { "path": "", "types": ["OBJ"] }, "…" ],
  "state": "active",
  "provenance": { "method": "deterministic", "confidence": 0.95, "createdAt": "2026-10-29T10:00:00Z", "notes": [] },
  "fields": [
    { "to": "/event", "from": "/event_type" },
    { "to": "/customer/id", "from": "/buyer/id", "cast": "string" },
    { "to": "/items", "from": "/line_items", "each": [ { "to": "/sku", "from": "/sku" } ] }
  ]
}
```

| Member | Requirement |
|---|---|
| `shiprtcl` | MUST be `"0.1"`. |
| `id` | Unique, opaque. |
| `contract` | The contract id. |
| `source` | The fingerprint the rule was created for. |
| `shape` | The source shape (§4.3) as an array of `{path, types}` objects. REQUIRED for absorption (§7.2). |
| `state` | One of `proposed`, `shadow`, `active`, `retired` (§9). |
| `provenance` | `method` (`deterministic`, `llm`, `human`), `confidence` (0–1), `createdAt` (RFC 3339), OPTIONAL `model`, OPTIONAL `notes` (strings). MUST NOT contain payload values. |
| `fields` | A field list (§6.2). |

### 6.2 Field list

A field list is an array of field objects. Each field object has only these members:

| Member | Meaning |
|---|---|
| `to` | REQUIRED. JSON Pointer into the output, relative to the current output scope. MUST NOT be empty or contain `~*`. Unique within its list. |
| `from` | JSON Pointer into the source, relative to the current source scope. The empty string means the scope itself. MUST NOT contain `~*`. |
| `const` | A JSON value written as-is. |
| `default` | A JSON value used when `from` resolves to absent. |
| `enum` | An object mapping the string form of a scalar source value to an output value. |
| `cast` | One of `string`, `number`, `integer`, `boolean`. |
| `scale` | A finite number to multiply by. |
| `each` | A field list applied to every element of the array at `from`. Requires `from`. |

Each field MUST have at least one of `from`, `const`, `default`. Unknown members MUST cause the rule to be rejected.

### 6.3 Evaluation

`apply(fields, scope)` starts with an empty output object and evaluates each field in order:

1. Resolve `from` against `scope` as a JSON Pointer. A missing member, an out-of-range index, or a **`null`** value yields *absent*.
2. If absent and `default` is present, use `default`.
3. If `const` is present, use `const` (overriding steps 1–2).
4. If still absent, write nothing and continue.
5. If `each` is present: the value MUST be an array; the result is the array of `apply(each, element)` for every element.
6. If `enum` is present and the value is a string, number or boolean whose string form is a member of `enum`, replace the value with that member's value.
7. If `cast` is present, convert:
   - `string`: strings unchanged; numbers and booleans to their ECMAScript `String()` form; otherwise error.
   - `number`, `integer`: numbers unchanged; non-blank strings parsed with ECMAScript `Number()`; non-finite results are errors.
   - `boolean`: booleans unchanged; `true`/`1`/`yes` and `false`/`0`/`no` (case-insensitive strings) and numbers `1`/`0`; otherwise error.
8. If `scale` is present, the value MUST be a number; multiply and round to 15 significant digits.
9. If `cast` is `integer`, round to the nearest integer, with halves rounded toward +∞ (ECMAScript `Math.round`).
10. Write the value at `to`, creating intermediate objects.

An error makes the whole application fail; the payload MUST then be quarantined (§10.5). Error messages MUST NOT include payload values.

Because `null` is absent (step 1), an upstream that starts sending `null` for an optional field does not produce invalid output. Contracts that need explicit `null`s can use `default: null`.

## 7. Rule resolution

For each payload, after computing its fingerprint *F* for contract *C*, an engine MUST select a rule as follows.

### 7.1 Exact lookup

If a non-retired rule is bound to (*C*, *F*), directly or through an alias, use it. This is the **fast path**. It MUST NOT invoke a synthesizer or any network service.

### 7.2 Absorption

Otherwise, for each active rule *R* of *C*, newest first, let *U* be the source paths *R* reads (each `from`, with `~*` appended for `each` scopes), *S* the payload shape, and *S<sub>R</sub>* the rule's stored shape. *R* absorbs *F* if all hold:

1. **No type drift:** for every path in *U* present in both *S* and *S<sub>R</sub>*, the non-`NULL` markers in *S* are a subset of those in *S<sub>R</sub>*.
2. **Not a rename:** it is not the case that some path in *U* is missing from *S* **and** some scalar-bearing path of *S* is missing from *S<sub>R</sub>*. (A disappeared path plus a new path is treated as a likely rename and resolved by synthesis.)
3. **Valid output:** applying *R* to the payload produces output that validates against *C*.

On absorption, the engine MUST bind *F* to *R* as an alias and emit `org.shiprtcl.drift.absorbed` (§11). Absorption handles added fields, omitted optional fields and newly-null fields without new rules.

### 7.3 Synthesis

Otherwise the engine MUST emit `org.shiprtcl.drift.detected` and synthesize a new rule (§8). Concurrent payloads with the same (*C*, *F*) MUST share one synthesis ("single flight"). The new rule's initial state is decided by policy (§9.2) and it is bound to (*C*, *F*).

### 7.4 Decision

The engine then applies the selected rule and validates the output against the contract:

- validation fails or a mapping error occurs → **quarantine** (§10.5); if the rule was `active` and selected by §7.1 or §7.2, also emit `org.shiprtcl.rule.suspect`;
- rule is `active` → **deliver**;
- rule is `proposed` or `shadow` → **hold**: do not deliver, retain for review.

Engines MUST validate on every request, including the fast path. Engines MUST NOT deliver output that fails validation.

## 8. Synthesis

### 8.1 Deterministic matching

Engines SHOULD attempt deterministic matching before any model. A deterministic matcher:

- MUST be a pure function of (shape, contract); it MUST NOT read payload values, so its output is valid for every payload with that fingerprint;
- MUST report a confidence in [0, 1] for each mapped target and the list of unresolved targets;
- SHOULD use name normalization (case and delimiter splitting, singularization, synonym groups) and type compatibility.

RECOMMENDED type compatibility factors (source marker → target type, implied `cast`):

| | `string` | `number` | `integer` | `boolean` |
|---|---|---|---|---|
| `STR` | 1.0 | 0.75 (`number`) | 0.7 (`integer`) | 0.7 (`boolean`) |
| `NUM` | 0.9 (`string`) | 1.0 | 0.95 (`integer`) | 0.7 (`boolean`) |
| `BOOL` | 0.9 (`string`) | — | — | 1.0 |

Matchers MUST NOT infer `scale`, `enum` or `const`; those carry meaning that structure alone cannot reveal.

### 8.2 Synthesizer input (privacy boundary)

A synthesizer that is not part of the engine's trust boundary (for example a hosted LLM) MUST receive only:

- the **redacted skeleton**: the shape paths and markers of the payload, with any path segment that matches a §4.4 dynamic-key pattern, contains 7 or more consecutive digits, or exceeds 64 characters replaced by `~redacted`;
- the contract schema;
- the fields already resolved and the targets still unresolved.

It MUST NOT receive payload values, headers, query strings, or any part of the raw body. Engines SHOULD log how many segments were redacted.

### 8.3 Verification of synthesizer output

Synthesizer output is untrusted. Before it can become part of a rule, the engine MUST verify that:

1. it parses as an SML field list (§6.2);
2. it uses only `to`, `from`, `cast` and `each` — `const`, `default`, `enum` and `scale` are reserved for human authors, so a model can never introduce values;
3. every source path it reads exists in the skeleton and is not redacted;
4. every target path it writes exists in the contract.

Output that fails verification MUST be discarded in full, and the reason recorded in provenance notes. Key names are attacker-controlled text and therefore a prompt-injection vector; this verification is what bounds the damage to a wrong-but-valid mapping, which §9 addresses.

## 9. Rule lifecycle

### 9.1 States

| State | Delivered? | Meaning |
|---|---|---|
| `proposed` | no | Synthesized but failed validation on its triggering payload, or awaiting authoring. |
| `shadow` | no | Valid, but below the auto-activation policy. Output is computed and held for review. |
| `active` | yes | In use. |
| `retired` | no | Withdrawn. Bindings to it are removed; the next matching payload re-enters resolution. |

Any transition is permitted. Each transition MUST emit an event naming the actor.

### 9.2 Activation policy

Engines MUST make activation a configurable policy. RECOMMENDED defaults:

- rules produced only by deterministic matching activate when their minimum confidence is ≥ 0.8 and they validate;
- rules that include synthesizer (model) output start in `shadow` and require explicit activation.

### 9.3 Provenance and rollback

Rules MUST be stored durably with their provenance; an in-memory cache MAY front the store but MUST NOT be the only copy. Engines MUST support retiring a rule and SHOULD keep retired rules for audit.

## 10. Runtime requirements

### 10.1 Acknowledgement

A proxy SHOULD acknowledge an upstream request with `202 Accepted` once the body is received, its signature verified (§10.3) and its media type parsed, and SHOULD perform resolution, delivery and quarantine asynchronously. A proxy MUST respond `401` to failed signature verification, `413` to oversized bodies, `415` to unsupported media types and `400` to unparseable bodies. Synchronous synthesis inside the upstream's request is NOT RECOMMENDED: upstream timeouts are short and concurrent drift would multiply model calls.

### 10.2 Delivery

Deliveries MUST be retried on network errors, `429` and `5xx`, with backoff. They SHOULD NOT be retried on other `4xx`. Exhausted deliveries MUST be quarantined.

### 10.3 Signatures

Translation breaks the upstream's signature over the body. Therefore:

- a proxy that has the upstream signing secret MUST verify the upstream signature over the **raw** body before parsing;
- a proxy SHOULD sign every delivery using [Standard Webhooks] (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>`);
- a proxy SHOULD add `shiprtcl-fingerprint` and `shiprtcl-rule` headers to deliveries.

### 10.4 Idempotency

A proxy MUST assign each accepted payload a stable message id and SHOULD drop duplicates within a window of at least 24 hours. The reference implementation derives the id from SHA-256 of the contract id and body.

### 10.5 Quarantine

Quarantined payloads contain real data and MUST be stored with access control, SHOULD be encrypted at rest (for example AES-256-GCM) and MUST be replayable once a rule is activated.

### 10.6 Bounding drift

A proxy SHOULD rate-limit synthesis per contract and alert when the number of distinct fingerprints per contract grows abnormally, since an attacker can mint new shapes at will.

## 11. Events

Engines MUST emit audit events as CloudEvents 1.0 [CLOUDEVENTS] in structured JSON mode, with `subject` set to the contract id. Event `data` MUST NOT contain payload values.

| `type` | `data` members |
|---|---|
| `org.shiprtcl.drift.detected` | `fingerprint`, `previous` (fingerprint of the newest active rule or `null`), `diff` (`added`, `removed`, `retyped`) |
| `org.shiprtcl.drift.absorbed` | `fingerprint`, `rule`, `added`, `missing` |
| `org.shiprtcl.rule.created` | `rule`, `fingerprint`, `state`, `method`, `model`, `confidence`, `notes` |
| `org.shiprtcl.rule.activated` / `.shadow` / `.proposed` / `.retired` | `rule`, `from`, `to`, `actor` |
| `org.shiprtcl.rule.suspect` | `rule`, `fingerprint`, `errors` |
| `org.shiprtcl.payload.translated` | `fingerprint`, `rule`, `resolution` (`hit`, `absorbed`, `synthesized`) |
| `org.shiprtcl.payload.held` | `fingerprint`, `rule`, `state` |
| `org.shiprtcl.payload.quarantined` | `fingerprint`, `rule`, `errors` (`path`, `message`) |

`payload.translated` MAY be sampled or omitted at high volume.

## 12. Conformance

An implementation MAY claim conformance at one or more levels:

- **SHIPRTCL Fingerprint** — §3 (for the formats it supports) and §4. It MUST reproduce every vector in `conformance/fingerprint-vectors.json` exactly.
- **SHIPRTCL Mapping** — Fingerprint, plus §5 and §6.
- **SHIPRTCL Engine** — Mapping, plus §7–§9 and §11.
- **SHIPRTCL Proxy** — Engine, plus §10.

## 13. Security considerations

- **Upstreams are adversarial.** They control values and key names. Key names enter synthesizer prompts (§8.2) and are a prompt-injection channel; §8.3 limits any model's output to existing paths and non-value-producing operations.
- **Valid is not correct.** A verified rule can still map the wrong field to a field of the same type (for example two string fields). The lifecycle (§9), confidence reporting and shadow mode exist for this reason. Engines SHOULD require review for rules touching money, identity or authorization fields.
- **Semantic drift is invisible to structure.** A change in units (cents to dollars), enum vocabulary or meaning, with no change of type, produces the same fingerprint. Contracts SHOULD use `enum`, `minimum` and `maximum` to turn such drift into validation failures.
- **Shape flooding.** Distinct shapes are cheap to produce; see §10.6.
- **The proxy is a trust intermediary.** It sees plaintext payloads and holds signing secrets; it SHOULD be operated by, or under the control of, the downstream party.
- **Denial of service** through deep nesting or huge bodies MUST be bounded by body-size and depth limits.

## 14. Privacy considerations

Fingerprints and shapes contain only key names and type markers, but key names can themselves be personal data; §4.4 collapses the common cases into `MAP`, and §8.2 redacts further. Quarantine stores real data (§10.5). Events never contain values (§11).

## 15. Versioning

This document is version 0.1. The `shiprtcl` member of rule documents and the `sr1` fingerprint prefix identify the versions in use. Changes to §4 that alter canonical forms MUST change the fingerprint prefix.

## 16. References

- [RFC 2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119, 1997.
- [RFC 8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174, 2017.
- [RFC 8259] Bray, T., "The JavaScript Object Notation (JSON) Data Interchange Format", RFC 8259, 2017.
- [RFC 6901] Bryan, P., Zyp, K., Nottingham, M., "JavaScript Object Notation (JSON) Pointer", RFC 6901, 2013.
- [RFC 8785] Rundgren, A., Jordan, B., Erdtman, S., "JSON Canonicalization Scheme (JCS)", RFC 8785, 2020.
- [RFC 4180] Shafranovich, Y., "Common Format and MIME Type for Comma-Separated Values (CSV) Files", RFC 4180, 2005.
- [UAX15] Unicode Standard Annex #15, "Unicode Normalization Forms".
- [FIPS 180-4] NIST, "Secure Hash Standard (SHS)", 2015.
- [JSON-SCHEMA-2020-12] JSON Schema: A Media Type for Describing JSON Documents, draft 2020-12.
- [CLOUDEVENTS] CNCF, "CloudEvents — Version 1.0".
- [Standard Webhooks] Standard Webhooks specification, https://www.standardwebhooks.com.

## Appendix A. Worked example

Contract `payments.v1`:

```json
{ "type": "object", "required": ["event", "customer", "amount"], "additionalProperties": false,
  "properties": {
    "event": { "type": "string" }, "amount": { "type": "number" },
    "customer": { "type": "object", "required": ["email", "id"],
                  "properties": { "email": { "type": "string" }, "id": { "type": "string" } } },
    "items": { "type": "array", "items": { "type": "object", "required": ["sku"],
               "properties": { "sku": { "type": "string" }, "quantity": { "type": "integer" } } } } } }
```

The upstream renames fields in a new API version:

```json
{ "event_type": "payment_success", "buyer": { "email_addr": "a@b.co", "id": 9812 },
  "subtotal": 49.5, "line_items": [ { "sku": "s1", "qty": 2 } ] }
```

The fingerprint is new and no active rule absorbs it (paths `/event`, `/customer/…`, `/amount` are missing while new scalar paths appear), so the engine synthesizes. The reference deterministic matcher produces, without a model:

```json
[ { "to": "/amount", "from": "/subtotal" },
  { "to": "/customer/email", "from": "/buyer/email_addr" },
  { "to": "/customer/id", "from": "/buyer/id", "cast": "string" },
  { "to": "/event", "from": "/event_type" },
  { "to": "/items", "from": "/line_items", "each": [ { "to": "/quantity", "from": "/qty", "cast": "integer" },
                                                     { "to": "/sku", "from": "/sku" } ] } ]
```

with minimum confidence above 0.8, so under the default policy it activates, validates, and delivers:

```json
{ "amount": 49.5, "customer": { "email": "a@b.co", "id": "9812" }, "event": "payment_success",
  "items": [ { "quantity": 2, "sku": "s1" } ] }
```

Every later payload with this structure takes the fast path.
