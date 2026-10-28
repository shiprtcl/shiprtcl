// Fast-path micro-benchmark for the reference implementation (in-process, no network).
// Usage: npm run build && npm run bench
import os from 'node:os';
import { Engine, fingerprint } from '../packages/shiprtcl/dist/index.js';

const N = Number(process.env.N ?? 20000);

// A Stripe-like event of ~2 KB with nested objects, an array of line items and metadata.
const payload = {
  id: 'evt_1Nf3x2AbCdEfGh', object: 'event', api_version: '2026-09-30', created: 1761700000, type: 'invoice.paid', livemode: false,
  data: { object: {
    id: 'in_1Nf3x2AbCdEfGh', object: 'invoice', amount_due: 4950, amount_paid: 4950, currency: 'usd', status: 'paid',
    customer: 'cus_Ox1Nf3x2AbCd', customer_email: 'user@example.com', customer_name: 'A. Customer',
    customer_address: { line1: '1 Main St', line2: null, city: 'Bengaluru', postal_code: '560001', country: 'IN' },
    lines: { object: 'list', has_more: false, data: Array.from({ length: 5 }, (_, i) => ({
      id: `il_${i}AbCdEfGh12`, amount: 990, currency: 'usd', description: `Seat ${i}`, quantity: 1,
      price: { id: `price_${i}AbCdEf12`, unit_amount: 990, recurring: { interval: 'month' } } })) },
    metadata: { campaign: 'launch', utm_source: 'hn' },
  } },
};
const schema = {
  type: 'object', required: ['event', 'invoice'],
  properties: {
    event: { type: 'string' },
    invoice: { type: 'object', required: ['id', 'amount', 'currency', 'email'], properties: {
      id: { type: 'string' }, amount: { type: 'integer' }, currency: { type: 'string' }, email: { type: 'string' }, status: { type: 'string' },
    } },
    lines: { type: 'array', items: { type: 'object', properties: { amount: { type: 'integer' }, description: { type: 'string' } } } },
  },
};
const fields = [
  { to: '/event', from: '/type' },
  { to: '/invoice/id', from: '/data/object/id' },
  { to: '/invoice/amount', from: '/data/object/amount_paid' },
  { to: '/invoice/currency', from: '/data/object/currency' },
  { to: '/invoice/email', from: '/data/object/customer_email' },
  { to: '/invoice/status', from: '/data/object/status' },
  { to: '/lines', from: '/data/object/lines/data', each: [{ to: '/amount', from: '/amount' }, { to: '/description', from: '/description' }] },
];

const contract = { id: 'invoices', schema, mapHints: ['/data/object/metadata'] };
const engine = new Engine({ contracts: [contract] });
const fp = await fingerprint(payload, { mapHints: contract.mapHints });
await engine.store.put({ shiprtcl: '0.1', id: 'rule_bench', contract: 'invoices', source: fp.id, shape: fp.shape, state: 'active',
  provenance: { method: 'human', confidence: 1, createdAt: new Date().toISOString() }, fields });

const body = JSON.stringify(payload);
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
async function measure(label, fn) {
  for (let i = 0; i < 2000; i++) await fn(); // warm-up
  const t = [];
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    await fn();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  const mean = t.reduce((a, b) => a + b, 0) / t.length;
  console.log(`${label.padEnd(34)} p50 ${pct(t, 50).toFixed(3)} ms   p99 ${pct(t, 99).toFixed(3)} ms   ~${Math.round(1000 / mean).toLocaleString()} ops/s/core`);
}

console.log(`payload ${body.length} bytes, ${fp.shape.length} shape entries, N=${N}`);
console.log(`${os.cpus()[0]?.model ?? 'cpu'} ×${os.cpus().length}, Node ${process.version}\n`);
await measure('fingerprint (parse + shape + sha256)', async () => fingerprint(JSON.parse(body), { mapHints: contract.mapHints }));
await measure('fast path (parse → validate)', async () => {
  const r = await engine.process('invoices', { body, contentType: 'application/json' });
  if (r.status !== 'translated') throw new Error(r.status);
});
