---
title: "SHIPRTCL: Self-Healing Ingestion with Structural Fingerprints and Lazily Synthesized Mapping Rules"
version: 0.1
status: Draft
date: 2026-10-29
author: Srishesh Archik
license: CC-BY-4.0
---

# SHIPRTCL: Self-Healing Ingestion with Structural Fingerprints and Lazily Synthesized Mapping Rules

**Whitepaper · Version 0.1 (Draft) · 29 October 2026**
**Srishesh Archik** · shiprtcl.org

## Abstract

Every system that consumes third-party data — webhooks, partner APIs, file drops — encodes assumptions about the structure of that data. When the producer renames a field, nests an object, changes a type or switches API versions, those assumptions fail, usually in production and usually silently. The common responses are hand-written adapters, which have to be maintained forever, and alerting, which tells you about the outage after it has started.

We present **SHIPRTCL**, the Self-Healing Ingestion Protocol: an open specification for detecting structural drift and repairing it at the point of ingestion. SHIPRTCL reduces every payload to a value-independent **structural fingerprint**. It binds each fingerprint to a **mapping rule** written in a small, total, declarative language, and resolves unseen fingerprints by **absorbing** them into existing rules where that is provably safe, or by **synthesizing** a new rule once. Synthesis is deterministic first. A language model is an optional fallback that sees only a redacted skeleton of key paths and types — never values — and can only propose copy, rename and cast operations, which are checked against both structures before use. Every rule carries provenance, moves through a reviewable lifecycle, and every output is validated against the consumer's contract before release; anything else is quarantined.

The steady-state cost is a hash and a lookup. Our TypeScript reference implementation translates and validates a typical 1.4 KB webhook in **0.19 ms at the median and 0.58 ms at p99** on a single core, without native code. The specification, reference implementation, conformance vectors and an in-browser playground are released under CC-BY-4.0 and Apache-2.0.

## 1. Introduction

### 1.1 The problem: structure is an unwritten contract

A webhook consumer is a parser for a format someone else controls. The producer's documentation describes the format, but the consumer's code depends on the format as it actually arrives — every key name, every nesting level, every type. Hyrum's Law applies with full force: whatever the producer emits, someone depends on.

Producers do try. Stripe pins every account to an API version and transforms responses backwards through a chain of version-change modules [Leach 2017], which is possibly the most rigorous approach in the industry. Most producers are not Stripe. In practice consumers see:

- **renames** — `email` becomes `email_address`, `type` becomes `event_type`;
- **restructuring** — flat fields move into a nested object, or the reverse;
- **type changes** — numeric ids become strings, amounts move from floats to integer minor units;
- **optionality changes** — a field that was always present starts arriving as `null` or not at all;
- **format changes** — the partner who sent JSON now sends CSV, or SOAP;
- **additions** — harmless on their own, but they break consumers that validate strictly.

Each of these is a small engineering task. Collectively, across dozens of integrations, they are a permanent tax, and each occurrence is an incident: a payment not recorded, an order not shipped, a lead not created.

### 1.2 Why existing approaches fall short

**Hand-written adapters** work but don't scale. Each one is code, tests and an on-call burden.

**Liberal parsing** — Postel's "be liberal in what you accept" — makes things worse. Silent tolerance hides drift until it causes damage, and it lets accidental behaviours harden into de-facto protocol. RFC 9413 [Thomson & Schinazi 2023] argues this at length. SHIPRTCL takes the opposite position: tolerance must be **explicit, recorded and reviewable**.

**Webhook gateways** (Svix, Hookdeck, Convoy) solve delivery: retries, fan-out, signatures, replay. They largely treat payloads as opaque, or let users write transformation code by hand. That code is the adapter problem again.

**Schema registries** (Confluent Schema Registry, Avro) govern evolution when *both* sides cooperate through a shared registry. Third-party webhooks have no shared registry; the producer will not register its schema with you.

**Integration platforms** (Airbyte, Apache Camel, iPaaS products) provide connector catalogues maintained by a vendor or community. They are excellent when a connector exists and is current, and they are adapters again when it is not.

**LLM-in-the-loop transformation** — asking a model to rewrite each payload — is too slow, too expensive and too nondeterministic for the hot path, and it sends customer data to a third party on every request.

### 1.3 Our approach

SHIPRTCL's central observation is that **drift is rare, while traffic is constant**. A webhook endpoint may receive millions of payloads in a handful of distinct structures. If we can recognize a structure cheaply and exactly, then the expensive work — deciding how a structure maps to the consumer's contract — happens once per structure, not once per payload, and its result can be inspected, versioned and reused like any other configuration.

This splits the problem in two:

1. **Recognition** (every request): compute a value-independent structural fingerprint and look it up. This is pure computation over the payload with no network calls, and it costs microseconds.
2. **Resolution** (once per new structure): decide how the new structure maps to the contract — by proving an existing rule still applies, by deterministic name and type matching, by an optional model, or by a human — and record the decision as a declarative rule with provenance.

Because a rule is data in a deliberately weak language, it can be proposed by an untrusted model, verified mechanically, reviewed by a human, diffed, rolled back, and shared.

### 1.4 Contributions

1. A **structural fingerprint** over a normalized tree, with precise rules for arrays, maps, Unicode, escaping and ordering, and published conformance vectors (§4).
2. **Absorption**, a criterion for safely reusing a rule across fingerprints that differ only by added, omitted or null fields, while sending likely renames to synthesis (§6).
3. **SML**, a total mapping language whose operations cannot introduce values, which makes model output safe to *verify* even if it isn't trustworthy (§5).
4. A **privacy boundary** for synthesis — a redacted skeleton — plus a verification procedure that confines prompt injection to wrong-but-valid mappings (§7).
5. A **rule lifecycle** and **CloudEvents audit vocabulary** that make self-healing observable and reversible (§8).
6. An open-source **reference implementation** with a proxy that verifies upstream signatures, re-signs with Standard Webhooks, and encrypts its quarantine (§9).

## 2. Design goals and non-goals

**Goals.**

- *Fail closed.* Never deliver output that does not satisfy the consumer's contract.
- *Values never leave.* No component outside the consumer's trust boundary sees payload values in order to repair structure.
- *Deterministic steady state.* The same payload structure always takes the same path through the same rule.
- *Explainable.* Every translation can be traced to a rule, and every rule to who or what created it and why.
- *Zero code at integration.* A consumer adopts SHIPRTCL by publishing a contract and pointing an upstream at an engine.
- *Implementable.* Any competent team can build a conforming engine in any language from the specification and the vectors.

**Non-goals.**

- *Semantic understanding.* SHIPRTCL repairs structure. It does not know that `amount` changed from dollars to cents (§10).
- *Arbitrary transformation.* SML is not a programming language. Computed fields, joins and lookups belong downstream.
- *Delivery infrastructure.* SHIPRTCL specifies the minimum delivery behaviour a proxy needs to be correct. It doesn't compete with webhook gateways and can sit in front of or behind one.

## 3. System model

```
 upstream ──► [ ingest → fingerprint → resolve → apply → validate ] ──► downstream
 (untrusted)           SHIPRTCL engine (consumer's trust boundary)       (contract owner)
                                    │                 │
                          synthesizer (optional,   quarantine
                          sees skeleton only)      (encrypted)
```

The **upstream** is untrusted. It controls values and key names, and it may be compromised or malicious. The **engine** runs inside the consumer's trust boundary: the consumer operates it, or a provider operates it on their behalf. The **contract** is the consumer's declaration of what it accepts. The **synthesizer** is outside the trust boundary by default and receives only what §7.2 allows.

## 4. Structural fingerprints

### 4.1 Normalization

Payloads first become an **IAST**, a plain JSON tree. JSON is parsed. Form bodies become objects of strings. CSV becomes an array of objects of strings. XML elements become objects whose child elements are *always* arrays, so that one occurrence and two occurrences have the same structure. One rule is applied without exception: **types are never inferred from text**. A ZIP code `01234` stays a string. If it were inferred as a number on some rows and a string on others, the fingerprint would depend on values, and recognition would become flaky. Conversion is the job of an explicit, audited `cast`.

### 4.2 Shape

The **shape** of a tree is the set of (path, types) pairs reached by walking it, with values discarded. Paths are JSON Pointers [RFC 6901] extended with one segment, `~*`, meaning "every element". `~*` is not a legal RFC 6901 escape, so it cannot collide with a real key. Arrays contribute their element shapes as a **union**. A key that appears in only some line items still appears once, and array length has no effect. Seven type markers are used: `ARR`, `BOOL`, `MAP`, `NULL`, `NUM`, `OBJ`, `STR`. Integers and non-integers are deliberately both `NUM`, because many producers emit `50` and `50.0` for the same field.

### 4.3 Maps

The naive fingerprint has a fatal flaw. Many payloads contain objects whose *keys are data*: metadata dictionaries, maps keyed by id, per-email or per-date buckets. Every distinct key set yields a new fingerprint — so nearly every request would be a cache miss — and the keys themselves can be personal data. SHIPRTCL classifies an object as a `MAP` when the contract hints that it is one, when it has more than 256 keys, or when *every* key matches a dynamic-key pattern: digits, UUIDs, emails, ISO dates, long hex strings, or prefixed opaque ids such as `price_1NxYz2AbCdEf`. A map's values are walked under `~*`, like array elements. Its keys vanish from the shape, along with any data they carried.

### 4.4 Canonical form and hash

The shape is sorted by path in Unicode **code-point** order. We specify code-point order explicitly because JavaScript's default string sort uses UTF-16 code units, and that disagrees with UTF-8 byte order for characters outside the Basic Multilingual Plane; our vectors include such a case. The sorted shape is serialized with the JSON Canonicalization Scheme [RFC 8785] and hashed with SHA-256. Keys are normalized to Unicode NFC first, so a composed `é` and a decomposed `e + ◌́` produce the same fingerprint.

For the payload

```json
{"event":"payment_success","customer":{"email":"user@example.com","id":9812},"amount":49.50,"items":["sku_1","sku_2"]}
```

the canonical form is

```
[["","OBJ"],["/amount","NUM"],["/customer","OBJ"],["/customer/email","STR"],["/customer/id","NUM"],["/event","STR"],["/items","ARR"],["/items/~*","STR"]]
```

and the fingerprint is

```
sr1:sha256:687cb54f1c77c419347a344b75fb970457eca760500bfec3f3d326c88171b0ae
```

The `sr1` prefix versions the algorithm, so it can evolve without ambiguity. The conformance suite contains 22 vectors covering these rules. Any implementation, in any language, must reproduce them byte for byte.

### 4.5 Prior art

Fingerprinting a *schema* is not new. Avro defines a Parsing Canonical Form for schemas and fingerprints it with CRC-64 or SHA-256 [Avro]. The difference is that SHIPRTCL fingerprints a *payload*, inferring its shape from the instance alone, because third-party producers do not hand you a schema. That one difference is why map classification, array unions and the never-infer-types rule are needed.

## 5. The SHIPRTCL Mapping Language

A rule is a list of fields. Each field writes one output path:

```json
[ { "to": "/event",          "from": "/event_type" },
  { "to": "/customer/id",    "from": "/buyer/id", "cast": "string" },
  { "to": "/amount_minor",   "from": "/amount", "cast": "integer", "scale": 100 },
  { "to": "/status",         "from": "/state", "enum": { "succeeded": "paid" } },
  { "to": "/currency",       "from": "/currency", "default": "INR" },
  { "to": "/items",          "from": "/line_items",
    "each": [ { "to": "/sku", "from": "/sku" }, { "to": "/quantity", "from": "/qty", "cast": "integer" } ] } ]
```

There are eight members (`to`, `from`, `const`, `default`, `enum`, `cast`, `scale`, `each`) and one evaluation order. There are no variables, conditionals or functions, and every rule terminates in time linear in the payload. A `null` source counts as absent, so an upstream that starts sending `null` for an optional field degrades gracefully.

We chose this weakness on purpose. JSONata, JMESPath and jq are far more expressive, and that expressiveness is exactly what we cannot verify. With SML, every question that matters about a rule — which source paths does it read, which target paths does it write, can it introduce values — can be answered by reading the rule, without running it. §7 depends on that.

## 6. Resolution: hit, absorb, synthesize

For each payload, the engine resolves a rule in three steps.

**Hit.** If a non-retired rule is bound to (contract, fingerprint), use it. This is the fast path: no synthesizer and no network.

**Absorb.** Otherwise, test the contract's active rules, newest first. A rule absorbs the new fingerprint when:

1. none of the paths it reads has changed type;
2. the change does not look like a rename — that is, it is *not* the case that a path the rule reads has disappeared **and** a new scalar path has appeared; and
3. applying the rule produces valid output.

Absorbed fingerprints are aliased to the rule. This one mechanism handles the most common harmless drifts: added fields, omitted optional fields, and fields that become `null`. No new rule is written, but an event records exactly what was added and what was missing.

Condition 2 matters most. Suppose `amount` disappears and `total_amount` appears. Without condition 2, the old rule would be "valid" whenever `amount` was optional, and the value would be silently dropped. With it, the engine recognizes a likely rename and synthesizes.

**Synthesize.** Otherwise, the engine emits a `drift.detected` event carrying the structural diff (paths added, removed and retyped against the newest active rule) and synthesizes a rule. Concurrent requests with the same new fingerprint share one synthesis ("single flight"), so a burst of a thousand identical new payloads costs one synthesis, not a thousand.

## 7. Synthesis

### 7.1 Deterministic first

Most renames are easy. `event_type`→`event`, `email_addr`→`email`, `qty`→`quantity` and `buyer`→`customer` can all be resolved without a model, using case and delimiter splitting, singularization, a small synonym table, context from parent path segments, and type compatibility. The reference matcher scores every (target, source) pair as name similarity × type fit and assigns greedily, one-to-one. The type fit table encodes caution: a `NUM` feeding a `string` target is easy (0.9), while a `STR` feeding an `integer` target is risky (0.7), because `"2"` might be `"two"` tomorrow.

The matcher is a pure function of (shape, contract). It never reads values, so its output is equally valid for every payload with that fingerprint, which is exactly what makes it safe to cache.

In the worked example of the specification (Appendix A), six renames (including `buyer` → `customer` on a nested object) and one type change are all resolved deterministically, with minimum confidence above the default activation threshold of 0.8. No model is involved.

### 7.2 The model, behind a privacy boundary

When targets remain unresolved, an engine *may* call a synthesizer — typically a small language model. The reference implementation speaks to any OpenAI-compatible `/chat/completions` endpoint, so Cloudflare Workers AI, Ollama, vLLM and hosted providers all work. The synthesizer receives:

- the **redacted skeleton**: paths and types only, with any segment that looks like data (an email, an id, a long digit run, an over-long key) replaced by `~redacted`;
- the target contract;
- what is already resolved, and what is not.

It never receives values, headers or bodies. This is stronger than "PII scrubbing" of values: there are no values to scrub, and the key names that might themselves be data are redacted too.

### 7.3 Verifying an untrusted proposer

Key names come from the upstream, so they are attacker-controlled text inside a prompt — a textbook prompt-injection channel. SHIPRTCL does not try to make the model trustworthy. It makes the model's output **checkable**:

1. it must parse as SML;
2. it may use only `to`, `from`, `cast` and `each` — never `const`, `default`, `enum` or `scale`, so it cannot introduce or rescale a value;
3. every `from` must exist in the skeleton, and no redacted path may be read;
4. every `to` must exist in the contract.

Output that fails any check is discarded in full. The worst a successful injection can achieve is a **wrong-but-valid mapping**: a real source field copied into a real target field of a compatible type. That is a real risk, and §8 exists to contain it. But it is bounded, visible in the rule, and reversible. It cannot exfiltrate data, execute code, or fabricate values.

## 8. Lifecycle, provenance and audit

Every rule records its **method** (`deterministic`, `llm` or `human`), the model identifier if one was used, a **confidence**, a timestamp and notes. Rules move between four states:

| State | Delivered | Typical cause |
|---|---|---|
| `proposed` | no | failed validation on its first payload |
| `shadow` | no | valid, but below the activation policy — output held for review |
| `active` | yes | in use |
| `retired` | no | withdrawn; matching payloads re-enter resolution |

The default policy activates deterministic rules at confidence ≥ 0.8 and holds every model-assisted rule in `shadow` until a human approves it. Operators can loosen this where speed matters more than review, for example for analytics events, and tighten it where review matters more, for example for money movement.

Every decision emits a **CloudEvents 1.0** event: `drift.detected` (with the structural diff), `drift.absorbed`, `rule.created`, `rule.activated`, `rule.retired`, `rule.suspect`, `payload.translated`, `payload.held` and `payload.quarantined`. Event data never contains payload values, so the audit stream can flow to ordinary logging infrastructure. Because the format is standard, it plugs straight into existing event routers.

This is what "self-healing" means in SHIPRTCL. It does not mean the system silently changes behaviour. It means the system proposes a fix, applies it only when policy allows, and leaves a complete, value-free record of what changed and why.

## 9. Runtime

### 9.1 Proxy behaviour

The reference proxy (`shiprtcl serve`) exposes `POST /in/{contract}` and:

1. reads the body up to a size limit;
2. **verifies the upstream signature on the raw body** — GitHub's `X-Hub-Signature-256`, Stripe's timestamped `Stripe-Signature`, or a generic HMAC — before anything is parsed;
3. parses the media type, returning `400` or `415` immediately on failure;
4. assigns a stable message id and drops duplicates within 24 hours;
5. returns **`202 Accepted`** and continues asynchronously, so upstream timeouts and synthesis latency are decoupled;
6. resolves, applies and validates;
7. delivers with retries and backoff, **re-signing with Standard Webhooks** [Standard Webhooks] and adding `shiprtcl-fingerprint` and `shiprtcl-rule` headers;
8. quarantines anything held, invalid or undeliverable, **encrypted with AES-256-GCM** when a key is configured.

Re-signing matters. Translation necessarily breaks the upstream's signature, and a proxy that forwards unsigned payloads would quietly remove a security control. With SHIPRTCL, trust is verified at the edge and re-established toward the consumer with a widely implemented scheme.

Rules persist durably, in an atomically rewritten JSON file in the reference implementation. A cache such as Redis may front the store, but it must never be the only copy. An early draft of this design kept rules only in Redis with eviction enabled. That is a configuration under which "permanent" rules can be evicted, or under which writes fail once memory is full.

### 9.2 Performance

The fast path is linear in payload size: one parse, one tree walk, one SHA-256, one map lookup, one rule application, one validation. We measured the reference implementation — plain TypeScript on Node.js 22, without native code — on an AMD EPYC 9354P virtual machine (2 vCPU), using a 1,445-byte Stripe-style invoice event with 41 shape entries, five line items and a metadata map, over 20,000 iterations after warm-up:

| Operation | p50 | p99 | Throughput per core |
|---|---|---|---|
| Fingerprint (parse + shape + SHA-256) | 0.147 ms | 0.411 ms | ~5,900 / s |
| Full fast path (parse → fingerprint → lookup → apply → validate) | 0.193 ms | 0.578 ms | ~4,600 / s |

The benchmark is in the repository (`npm run bench`), so these numbers can be reproduced and challenged. At these figures, ingestion overhead is negligible next to network latency. Native parsers and a shared cache are optimizations for very high volumes, not prerequisites. Synthesis costs one matcher pass (sub-millisecond) and, only if needed, one model call. Because results are cached per fingerprint and shared through single-flight, model cost scales with the number of *distinct structures*, not with traffic.

## 10. Known limitations

We would rather list these than have readers discover them.

1. **Semantic drift is invisible to structure.** If a producer changes `amount` from dollars to cents, or renames enum values from `paid` to `succeeded`, without changing types, the fingerprint is unchanged and SHIPRTCL will not notice. Contracts can catch some such changes through `enum`, `minimum` and `maximum`, which turn them into validation failures. Value-distribution monitoring is future work.
2. **Valid is not correct.** A rule can map the wrong field into a field of the same type — two strings swapped — and still validate. Confidence scores, shadow mode, human review for sensitive contracts and complete provenance mitigate this. They do not eliminate it.
3. **The matcher is English-centric.** Tokenization and synonyms assume English-like key names. Other languages, and abbreviations outside the synonym table, fall through to the optional model or to a human.
4. **Map classification is heuristic.** Free-form metadata keys such as `campaign` or `utm_source` look like schema, so they need a `mapHints` entry. Conversely, a schema whose real keys are numeric would be misclassified as a map. Contracts can override both cases.
5. **SML is intentionally limited.** In v0.1 it cannot concatenate or split strings, convert date formats, cast the elements of scalar arrays, or compute values. Those belong downstream, or in a future, equally verifiable extension.
6. **Format coverage.** The specification covers JSON, form bodies, CSV/TSV, XML and YAML. The reference implementation covers JSON, form bodies and CSV/TSV. Form bodies with sometimes-repeated keys produce two shapes, which absorption usually merges.
7. **The reference proxy is single-node.** Deduplication is in memory, rules live in a local file, and there is no replay UI. It demonstrates the runtime requirements. It is not yet a production gateway.
8. **The proxy is a trusted intermediary.** It sees plaintext payloads and holds signing secrets, so it must run inside, or be contractually bound to, the consumer's trust boundary. "Zero code" does not mean "zero trust".
9. **No synthesis-quality benchmark yet.** We have not published accuracy numbers for the matcher or for model-assisted synthesis against a labelled corpus of real-world drifts. Building that corpus openly is the most valuable contribution the community could make. Valentine [Koutras et al. 2021] is a model for how such an evaluation could be run.
10. **Draft status.** The fingerprint algorithm may change before 1.0. If it does, the `sr1` prefix will change, so old and new fingerprints can never be confused.

## 11. Roadmap

- **0.2:** XML and YAML in the reference implementation; contract importers for OpenAPI and Zod; a replay API for quarantine; a durable SQLite store.
- **0.3:** an open drift corpus and evaluation harness; publication of matcher accuracy; a second implementation in Rust or Go, to prove the specification stands on its own.
- **1.0:** a frozen fingerprint algorithm and SML, a conformance badge, and a governance hand-off to a multi-stakeholder group if adoption warrants it.

Proposals follow a lightweight SHIPRTCL Enhancement Proposal (SEP) process, described in the repository.

## 12. Conclusion

Third-party data will keep changing shape. That cannot be prevented, but it can stop being an incident. By separating recognition (cheap, exact, every request) from resolution (rare, careful, recorded), SHIPRTCL turns drift from an outage into a reviewable configuration change. Language models are useful here precisely because the design does not trust them: they see no data, they can propose only what can be checked, and their proposals pass through the same lifecycle as a human's.

The specification is short enough to read in an afternoon, the vectors are strict enough to implement against, and the playground runs entirely in your browser. We invite implementers, webhook producers and anyone who has been paged for a renamed field to try it, break it and improve it.

## References

- [Avro] Apache Software Foundation. *Apache Avro Specification* — "Parsing Canonical Form for Schemas" and "Schema Fingerprints".
- [CloudEvents] Cloud Native Computing Foundation. *CloudEvents Specification, Version 1.0*.
- [Koutras et al. 2021] C. Koutras, G. Siachamis, A. Ionescu, K. Psarakis, J. Brons, M. Fragkoulis, C. Lofi, A. Bonifati, A. Katsifodimos. "Valentine: Evaluating Matching Techniques for Dataset Discovery." *IEEE ICDE*, 2021.
- [Leach 2017] B. Leach. "APIs as infrastructure: future-proofing Stripe with versioning." Stripe Engineering Blog, 2017.
- [Rahm & Bernstein 2001] E. Rahm, P. A. Bernstein. "A survey of approaches to automatic schema matching." *The VLDB Journal* 10(4), 2001.
- [RFC 6901] P. Bryan, K. Zyp, M. Nottingham. *JavaScript Object Notation (JSON) Pointer*. IETF, 2013.
- [RFC 8785] A. Rundgren, B. Jordan, S. Erdtman. *JSON Canonicalization Scheme (JCS)*. IETF, 2020.
- [RFC 9413] M. Thomson, D. Schinazi. *Maintaining Robust Protocols*. IETF, 2023.
- [Standard Webhooks] *Standard Webhooks Specification*. https://www.standardwebhooks.com.
- [JSON Schema] *JSON Schema: A Media Type for Describing JSON Documents*, draft 2020-12.
- [UAX #15] Unicode Consortium. *Unicode Normalization Forms*.

---

*Cite this work:* Archik, S. (2026). *SHIPRTCL: Self-Healing Ingestion with Structural Fingerprints and Lazily Synthesized Mapping Rules* (Version 0.1, Draft). Zenodo. https://doi.org/10.5281/zenodo.23747812
