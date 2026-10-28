// Landing page: cycles real payloads through the real engine, in the browser.
import { Engine } from './shiprtcl.min.js';

const contract = {
  id: 'payments.v1',
  schema: {
    type: 'object',
    required: ['event', 'customer', 'amount'],
    properties: {
      event: { type: 'string' },
      amount: { type: 'number' },
      customer: { type: 'object', required: ['email', 'id'], properties: { email: { type: 'string' }, id: { type: 'string' } } },
    },
  },
};
const v1 = { event: 'payment_success', customer: { email: 'ana@example.com', id: 'cus_8812' }, amount: 49.5 };
const steps = [
  ['v1 · first sighting', v1],
  ['v1 · repeat traffic', { ...v1, amount: 120 }],
  ['upstream adds a field', { ...v1, livemode: true }],
  ['upstream ships v2 — fields renamed', { event_type: 'payment_success', buyer: { email_addr: 'ana@example.com', id: 8812 }, subtotal: 49.5 }],
  ['v2 · repeat traffic', { event_type: 'refund', buyer: { email_addr: 'li@example.org', id: 77 }, subtotal: 12 }],
  ['breaking change — fields gone', { event_type: 'payment_success', buyer: { id: 8812 } }],
];
const known = new Set(['event', 'customer', 'email', 'id', 'amount']);

const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const highlight = (text) => esc(text).replace(/"([^"]+)":/g, (m, k) => (known.has(k) ? m : `<span class="k-drift">"${k}"</span>:`));
const label = { hit: 'cache hit', absorbed: 'absorbed', synthesized: 'healed' };

let engine;
let i = 0;
let paused = false;

async function tick() {
  if (i === 0) engine = new Engine({ contracts: [contract] });
  const [title, value] = steps[i];
  const r = await engine.process(contract.id, { value });
  $('live-step').textContent = `${i + 1}/${steps.length} · ${title}`;
  $('live-in').innerHTML = highlight(JSON.stringify(value, null, 1));
  $('live-fp').textContent = r.fingerprint.id.slice(0, 36) + '…';
  const res = r.status === 'quarantined' ? 'quarantined' : r.resolution === 'synthesized' && i === 0 ? 'learned' : label[r.resolution];
  $('live-res').className = 'badge b-' + (r.status === 'quarantined' ? 'quarantined' : r.resolution === 'hit' ? 'hit' : 'synthesized');
  $('live-res').textContent = res;
  $('live-status').className = 'badge b-' + r.status;
  $('live-status').textContent = r.status;
  $('live-t').textContent = r.durationMs.toFixed(2) + ' ms';
  const out = $('live-out');
  out.textContent = r.output ? JSON.stringify(r.output, null, 1) : r.errors.map((e) => `✗ ${e.path} ${e.message}`).join('\n');
  out.classList.remove('flash');
  void out.offsetWidth;
  out.classList.add('flash');
  i = (i + 1) % steps.length;
}

const card = $('live');
if (card && globalThis.crypto?.subtle) {
  card.addEventListener('mouseenter', () => (paused = true));
  card.addEventListener('mouseleave', () => (paused = false));
  card.addEventListener('focusin', () => (paused = true));
  card.addEventListener('focusout', () => (paused = false));
  $('live-next')?.addEventListener('click', () => tick());
  tick();
  setInterval(() => !paused && !document.hidden && tick(), 3200);
}
