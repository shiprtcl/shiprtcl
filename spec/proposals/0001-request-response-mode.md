# SEP-0001: Request/response mode

- **Author(s):** Srishesh Archik
- **Status:** Draft
- **Created:** 2026-10-29
- **Spec sections affected:** §5 (contracts), §7.4 (decision), §10 (runtime), §11 (events), §12 (conformance)
- **Breaks fingerprints?** no

## Summary

SHIPRTCL v0.1 specifies the runtime for **pushed** payloads: an upstream POSTs to a proxy, the proxy acknowledges with `202`, and translation and delivery happen asynchronously (§10.1). Much third-party data is **pulled** instead. An application calls a vendor API (for example `GET /invoice/123` on an accounting API) and parses the response. When the response's structure drifts, the application breaks just as a webhook consumer would.

This SEP defines a synchronous **request/response mode**: a SHIPRTCL engine sits in the call path, forwards the request, and translates the vendor's response to the caller's contract before returning it. Fingerprinting, SML, resolution and the lifecycle are unchanged. What changes is how contracts are selected, what happens on a miss when nobody can wait, and some HTTP details.

## Motivation

- Pull integrations are at least as common as push. Accounting, CRM, ERP and e-commerce APIs are mostly read by polling or on demand.
- Vendors evolve response shapes through API versions and minor versions. Pinning helps until the pinned version is sunset.
- The v0.1 engine already handles this as a library: `engine.process(contractId, { body: responseText, contentType })` works on a response body today. What is missing is a specified **gateway** behaviour, so implementations agree on routing, misses, errors and headers.

## Specification (proposed normative text)

### 1. Route contracts

A request/response deployment binds contracts to routes:

```json
{
  "id": "accounting.invoice.read.v1",
  "match": { "method": "GET", "upstream": "https://api.vendor.example", "path": "/v3/company/{realm}/invoice/{id}", "status": "2xx" },
  "schema": { "...": "JSON Schema subset, as §5.2" }
}
```

- `upstream` MUST be an exact scheme + host (+ optional port). A gateway MUST NOT forward to hosts that no route names. This is an allow-list, and it prevents the gateway being used for server-side request forgery.
- `path` uses `{name}` placeholders matching one path segment.
- `status` is an exact code or a class (`2xx`, `4xx`). Responses whose status matches no route MUST be returned unmodified, with header `shiprtcl-status: untranslated`. In particular, vendor error bodies are not translated unless a route says so.
- When several routes match, the most specific wins: exact status beats class, and literal segments beat placeholders.

### 2. Synchronous resolution and the miss budget

The gateway runs §7 resolution inline:

- **Hit** and **absorption** MUST run inline. Both are sub-millisecond.
- **Deterministic synthesis** (§8.1) MAY run inline within a configurable **miss budget** (RECOMMENDED default: 50 ms).
- **Model synthesis** (§8.2) MUST NOT run inline. If deterministic synthesis does not yield an *active* rule, the gateway MUST start model synthesis in the background (single-flight, §7.3) and apply the `onUnresolved` policy to the current call.

### 3. `onUnresolved` policy

Each route declares what the caller gets when no active rule produces valid output:

| Value | Behaviour |
|---|---|
| `fail` (default) | Respond `502 Bad Gateway` with an RFC 9457 problem document of type `https://shiprtcl.org/problems/unresolved-drift`, including `fingerprint`, `rule` (if any) and the validation errors. MUST NOT include response values. |
| `passthrough` | Return the vendor's original body unmodified with `shiprtcl-status: untranslated`. Intended for callers that can tolerate drift and prefer availability. |

The default is `fail`, consistent with "fail closed" (§7.4). A held rule (`shadow`/`proposed`) never translates a live response.

### 4. HTTP semantics

- The gateway MUST recompute `Content-Length` and MUST remove or replace `ETag`, `Content-MD5`, `Digest`/`Content-Digest` and any vendor body signature on translated responses, because they describe the untranslated body. It SHOULD emit a weak ETag derived from the translated body.
- `Cache-Control`, `Expires` and `Vary` SHOULD be preserved. Caches in front of the gateway then cache translated bodies.
- The gateway MUST add `shiprtcl-status: translated | untranslated`, plus `shiprtcl-fingerprint` and `shiprtcl-rule` when translated.
- Request bodies are forwarded unmodified in this mode. (Translating outbound bodies is the subject of SEP-0002.)
- Credentials (`Authorization`, cookies, API keys) MUST be forwarded as received and MUST NOT be logged, stored, or included in events.

### 5. Pagination and collections

Each response is processed independently. Gateways MUST NOT merge pages. A contract describing a page (for example `{ "items": [...], "next": "..." }`) is an ordinary contract.

Streaming responses (NDJSON, server-sent events) are out of scope for this SEP.

### 6. Events

All v0.1 events apply. Event `data` gains an OPTIONAL `route` member (the route contract id). `payload.held` is replaced in this mode by `payload.unresolved`, with `policy` (`fail` | `passthrough`).

### 7. Conformance

A new level, **SHIPRTCL Gateway**: Engine conformance plus §1–§6 of this SEP.

## Security and privacy considerations

- The gateway sees credentials in flight; it is a stronger trust intermediary than the push proxy (§13). It MUST run inside the caller's trust boundary.
- The host allow-list (§1) is mandatory, to prevent SSRF.
- `passthrough` weakens fail-closed guarantees by design. Implementations SHOULD log it prominently and SHOULD NOT make it the default.
- Values never reach synthesizers, exactly as in §8.2.

## Alternatives considered

- **Translate in the client library only.** This already works with the v0.1 engine and remains a supported pattern. A gateway is useful when many services call the same vendor, or when the calling code cannot be changed.
- **Always pass through on a miss.** Rejected as the default, because it silently hands drifted data to callers, which is exactly the failure SHIPRTCL exists to prevent.

## Open questions

1. Should a route be able to declare a *stale rule* fallback, i.e. apply the newest active rule even when absorption fails, marked `shiprtcl-status: degraded`?
2. Should the miss budget be per route or global?
3. Is `502` the right status, or `424 Failed Dependency`?

## Reference implementation

Not yet started. Planned for `shiprtcl` 0.2 as `shiprtcl serve --mode gateway`.
