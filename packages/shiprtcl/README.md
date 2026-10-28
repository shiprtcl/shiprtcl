# shiprtcl

The reference implementation of **[SHIPRTCL](https://shiprtcl.org)**, the Self-Healing Ingestion Protocol: structural fingerprints, the SHIPRTCL Mapping Language, drift resolution, and a reference ingestion proxy.

Zero runtime dependencies. It runs in Node.js ≥ 20 and in modern browsers; the proxy and CLI are Node-only.

```ts
import { Engine, fingerprint } from 'shiprtcl';

(await fingerprint({ event: 'paid', customer: { id: 1 } })).id;
// 'sr1:sha256:…' — identical for any payload with the same structure

const engine = new Engine({ contracts: [{ id: 'payments.v1', schema }] });
const r = await engine.process('payments.v1', { body, contentType: 'application/json' });
// r.status: 'translated' | 'held' | 'quarantined'
```

| Module | Spec |
|---|---|
| `ingest` — JSON, form, CSV/TSV → IAST | §3 |
| `fingerprint` — shape, canonical form, `sr1` hash, skeleton | §4, §8.2 |
| `contract` — JSON Schema subset validator | §5 |
| `mapping` — SML evaluator and checker | §6 |
| `engine` — hit / absorb / synthesize, lifecycle, events | §7, §9, §11 |
| `matcher` — deterministic synthesizer | §8.1 |
| `synthesizer` — model prompt, output verification, OpenAI-compatible adapter | §8.2–8.3 |
| `signatures` — GitHub, Stripe, HMAC, Standard Webhooks | §10.3 |
| `proxy` (`shiprtcl/proxy`) — reference HTTP proxy | §10 |

CLI:

```bash
shiprtcl fingerprint payload.json [--type text/csv]
shiprtcl serve shiprtcl.config.json
```

Proxy environment variables: `SHIPRTCL_ADMIN_TOKEN` (admin API bearer token), `SHIPRTCL_DLQ_KEY` (base64 32-byte AES-256-GCM key for quarantine), plus the secret variables each contract names.

Apache-2.0 · https://github.com/shiprtcl/shiprtcl
