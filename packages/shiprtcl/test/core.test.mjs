import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  Engine, applyFields, checkFields, fingerprint, match, parse, parseCsv, signStandardWebhook,
  skeleton, validate, verifyGitHub, verifyStandardWebhook, verifyStripe, verifySynthesized,
} from '../dist/index.js';

const vectors = JSON.parse(await readFile(new URL('../../../conformance/fingerprint-vectors.json', import.meta.url), 'utf8'));

test('conformance vectors', async (t) => {
  for (const v of vectors.vectors) {
    await t.test(v.name, async () => {
      const fp = await fingerprint(parse(v.body, v.mediaType), { mapHints: v.mapHints });
      assert.equal(fp.canonical, v.canonical);
      assert.equal(fp.id, v.fingerprint);
    });
  }
});

test('fingerprint ignores values and key order', async () => {
  const a = await fingerprint({ x: 1, y: { z: 'a' } });
  const b = await fingerprint({ y: { z: 'something else' }, x: 99 });
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, (await fingerprint({ x: '1', y: { z: 'a' } })).id);
});

test('csv never infers types from values', () => {
  const rows = parseCsv('a,b\n"1,5",01234\n"say ""hi""",\n');
  assert.deepEqual(rows, [{ a: '1,5', b: '01234' }, { a: 'say "hi"', b: '' }]);
});

test('mapping language: casts, scale, enum, default, const, each', () => {
  const out = applyFields(
    [
      { to: '/id', from: '/n', cast: 'string' },
      { to: '/cents', from: '/amount', cast: 'integer', scale: 100 },
      { to: '/status', from: '/s', enum: { succeeded: 'paid' } },
      { to: '/currency', from: '/cur', default: 'INR' },
      { to: '/v', const: 1 },
      { to: '/lines', from: '/items', each: [{ to: '/sku', from: '/code' }] },
      { to: '/gone', from: '/missing' },
      { to: '/nulled', from: '/nil' },
    ],
    { n: 7, amount: 49.99, s: 'succeeded', cur: null, items: [{ code: 'a' }, { code: 'b' }], nil: null },
  );
  assert.deepEqual(out, { id: '7', cents: 4999, status: 'paid', currency: 'INR', v: 1, lines: [{ sku: 'a' }, { sku: 'b' }] });
});

test('mapping errors never include payload values', () => {
  assert.throws(() => applyFields([{ to: '/n', from: '/x', cast: 'number' }], { x: 'secret@example.com' }), (e) => !String(e.message).includes('secret'));
});

test('checkFields rejects unknown operations and wildcards', () => {
  assert.ok(checkFields([{ to: '/a', from: '/b', eval: 'x' }]).some((p) => p.includes('unknown key')));
  assert.ok(checkFields([{ to: '/a/~*', from: '/b' }]).length > 0);
  assert.ok(checkFields([{ to: '/a', from: '/b' }, { to: '/a', from: '/c' }]).some((p) => p.includes('duplicate')));
});

test('validator', () => {
  const schema = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'integer', minimum: 0 }, b: { type: ['string', 'null'] } } };
  assert.deepEqual(validate({ a: 1, b: null }, schema), []);
  assert.equal(validate({ a: -1, c: 1 }, schema).length, 2);
  assert.equal(validate({}, schema)[0].message, 'is required');
});

const schema = {
  type: 'object', required: ['event', 'customer', 'amount'], additionalProperties: false,
  properties: {
    event: { type: 'string' }, amount: { type: 'number' },
    customer: { type: 'object', required: ['email', 'id'], properties: { email: { type: 'string' }, id: { type: 'string' } } },
    items: { type: 'array', items: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' }, quantity: { type: 'integer' } } } },
  },
};
const v1 = { event: 'payment_success', customer: { email: 'a@b.co', id: 'cus_1' }, amount: 49.5, items: [{ sku: 's1', quantity: 2 }] };
const renamed = { event_type: 'payment_success', buyer: { email_addr: 'a@b.co', id: 9812 }, subtotal: 49.5, line_items: [{ sku: 's1', qty: 2 }] };

test('matcher resolves common renames deterministically', async () => {
  const m = match((await fingerprint(renamed)).shape, schema);
  assert.deepEqual(m.unresolvedRequired, []);
  const byTo = Object.fromEntries(m.matches.map((x) => [x.to, x.from]));
  assert.equal(byTo['/event'], '/event_type');
  assert.equal(byTo['/amount'], '/subtotal');
  assert.equal(byTo['/customer/email'], '/buyer/email_addr');
  assert.equal(byTo['/items/~*/quantity'], '/line_items/~*/qty');
});

test('engine: synthesize → hit → absorb → heal → quarantine', async () => {
  const e = new Engine({ contracts: [{ id: 'pay', schema }] });
  const first = await e.process('pay', { value: v1 });
  assert.equal(first.status, 'translated');
  assert.equal(first.resolution, 'synthesized');
  assert.equal((await e.process('pay', { value: v1 })).resolution, 'hit');

  const extra = await e.process('pay', { value: { ...v1, livemode: true } });
  assert.equal(extra.resolution, 'absorbed');
  const nulled = await e.process('pay', { value: { ...v1, items: null } });
  assert.equal(nulled.resolution, 'absorbed');

  const healed = await e.process('pay', { value: renamed });
  assert.equal(healed.resolution, 'synthesized');
  assert.equal(healed.status, 'translated');
  assert.deepEqual(healed.output, { amount: 49.5, customer: { email: 'a@b.co', id: '9812' }, event: 'payment_success', items: [{ quantity: 2, sku: 's1' }] });
  assert.ok(healed.events.some((x) => x.type === 'org.shiprtcl.drift.detected' && x.data.diff.added.includes('/subtotal')));

  const broken = await e.process('pay', { value: { event_type: 'x', buyer: { id: 1 } } });
  assert.equal(broken.status, 'quarantined');
  assert.equal(broken.output, undefined);
  for (const ev of broken.events) assert.ok(!JSON.stringify(ev).includes('a@b.co'));
});

test('engine: rename is not mistaken for absence', async () => {
  const e = new Engine({ contracts: [{ id: 'pay', schema }] });
  await e.process('pay', { value: v1 });
  const { amount, ...rest } = v1;
  const r = await e.process('pay', { value: { ...rest, total_amount: amount } });
  assert.equal(r.resolution, 'synthesized');
  assert.equal(r.output.amount, 49.5);
});

test('engine: low-confidence rules are held, then activated by a human', async () => {
  const e = new Engine({ contracts: [{ id: 'pay', schema }] });
  const r = await e.process('pay', { value: { ...renamed, line_items: [{ sku: 's1', qty: '2' }] } });
  assert.equal(r.status, 'held');
  assert.equal(r.rule.state, 'shadow');
  await e.transition(r.rule.id, 'active');
  assert.equal((await e.process('pay', { value: { ...renamed, line_items: [{ sku: 's9', qty: '5' }] } })).status, 'translated');
});

test('engine: concurrent first sightings synthesize once', async () => {
  let calls = 0;
  const synthesizer = { name: 'counting', synthesize: async () => (calls++, await new Promise((r) => setTimeout(r, 20)), []) };
  const e = new Engine({ contracts: [{ id: 'c', schema: { type: 'object', properties: { zz: { type: 'string' } } } }], synthesizer });
  await Promise.all(Array.from({ length: 50 }, () => e.process('c', { value: { unrelated: 'x' } })));
  assert.equal(calls, 1);
});

test('synthesizer output is verified against both shapes', async () => {
  const sk = skeleton((await fingerprint({ buyer: { mail: 'x' } })).shape).shape;
  const target = { type: 'object', properties: { email: { type: 'string' } } };
  assert.deepEqual(verifySynthesized([{ to: '/email', from: '/buyer/mail' }], sk, target), []);
  assert.ok(verifySynthesized([{ to: '/email', from: '/buyer/password' }], sk, target).length);
  assert.ok(verifySynthesized([{ to: '/admin', from: '/buyer/mail' }], sk, target).length);
  assert.ok(verifySynthesized([{ to: '/email', const: 'fabricated@x.com' }], sk, target).length);
});

test('skeleton redacts data-like key segments', async () => {
  const { shape, redactions } = skeleton((await fingerprint({ 'alice@example.com': { x: 1 }, ok: 1 })).shape);
  assert.ok(redactions > 0);
  assert.ok(!JSON.stringify(shape).includes('alice'));
});

test('signatures', async () => {
  const { createHmac } = await import('node:crypto');
  const body = '{"a":1}';
  assert.ok(await verifyGitHub('s', body, 'sha256=' + createHmac('sha256', 's').update(body).digest('hex')));
  assert.ok(!(await verifyGitHub('s', body, 'sha256=00')));
  const t = Math.floor(Date.now() / 1000);
  assert.ok(await verifyStripe('whsec', body, `t=${t},v1=` + createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex')));
  assert.ok(!(await verifyStripe('whsec', body, `t=${t - 1000},v1=` + createHmac('sha256', 'whsec').update(`${t - 1000}.${body}`).digest('hex'))));
  const secret = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
  const sig = await signStandardWebhook(secret, 'msg_1', t, body);
  const expected = createHmac('sha256', Buffer.from('0123456789abcdef0123456789abcdef')).update(`msg_1.${t}.${body}`).digest('base64');
  assert.equal(sig, 'v1,' + expected);
  assert.ok(await verifyStandardWebhook(secret, 'msg_1', t, body, sig));
});
