// Playground: the reference engine running entirely in your browser. Nothing is sent anywhere.
import { Engine, skeleton, checkSchema } from './shiprtcl.min.js?v=27013dc883';
import { scenarios } from './scenarios.js?v=d26eaa615a';

const $ = (id) => document.getElementById(id);
const els = {
  chips: $('pg-chips'), explain: $('pg-explain'), contract: $('pg-contract'), payload: $('pg-payload'),
  type: $('pg-type'), send: $('pg-send'), reset: $('pg-reset'), out: $('pg-out'), cache: $('pg-cache'),
};

const engines = new Map(); // contract text → Engine
let current = scenarios[0];

function engineFor(text) {
  let e = engines.get(text);
  if (!e) {
    const contract = JSON.parse(text);
    if (!contract.id || !contract.schema) throw new Error('A contract needs "id" and "schema".');
    const problems = checkSchema(contract.schema);
    if (problems.length) throw new Error(problems.join('\n'));
    e = new Engine({ contracts: [contract] });
    engines.set(text, e);
  }
  return e;
}

function choose(s, { run = false } = {}) {
  current = s;
  for (const b of els.chips.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.key === s.key));
  const text = JSON.stringify(s.contract, null, 2);
  if (els.contract.value !== text) els.contract.value = text;
  els.payload.value = s.body;
  els.type.value = s.type;
  els.explain.textContent = s.explain;
  try {
    history.replaceState(null, '', '#' + s.key);
  } catch {}
  if (run) send();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pretty = (v) => esc(JSON.stringify(v, null, 2));
const box = (title, body, open = false) => `<details class="box"${open ? ' open' : ''}><summary>${title}</summary><pre>${body}</pre></details>`;

async function send() {
  let engine, contractId;
  try {
    engine = engineFor(els.contract.value);
    contractId = JSON.parse(els.contract.value).id;
  } catch (e) {
    els.out.innerHTML = `<p class="err">Contract error: ${esc(e.message)}</p>`;
    return;
  }
  let r;
  try {
    r = await engine.process(contractId, { body: els.payload.value, contentType: els.type.value });
  } catch (e) {
    els.out.innerHTML = `<p class="err">Payload error: ${esc(e.message)}</p>`;
    return;
  }
  render(engine, r);
  renderCache(engine, contractId);
}

const resText = { hit: 'Cache hit', absorbed: 'Absorbed', synthesized: 'Synthesized' };
const statusText = { translated: 'Delivered', held: 'Held for review', quarantined: 'Quarantined' };
const sentence = (r) => {
  if (r.status === 'quarantined') return 'No rule could produce output that satisfies the contract, so nothing was delivered. The payload would be stored, encrypted, for replay.';
  if (r.status === 'held') return `The rule's confidence (${r.rule.provenance.confidence}) is below the auto-activation threshold (0.8). Its output is shown, but would not be delivered until approved.`;
  if (r.resolution === 'hit') return 'Fast path: a known fingerprint, no matching, no model, just apply and validate.';
  if (r.resolution === 'absorbed') return 'New fingerprint, but an existing rule provably still applies. It was aliased; no new rule.';
  return 'New fingerprint. The deterministic matcher wrote a rule from the shape alone, and it validated and activated.';
};

function render(engine, r) {
  const sk = skeleton(r.fingerprint.shape);
  const review = r.rule.state === 'shadow' || r.rule.state === 'proposed'
    ? `<div class="review"><button class="btn sm" data-act="active" data-rule="${esc(r.rule.id)}">Approve rule</button><button class="btn sm ghost" data-act="retired" data-rule="${esc(r.rule.id)}">Reject</button><span class="muted">then send again</span></div>`
    : '';
  els.out.innerHTML = `
    <div class="verdict">
      <span class="badge b-${r.resolution === 'hit' ? 'hit' : r.resolution}">${resText[r.resolution]}</span>
      <span class="badge b-${r.status}">${statusText[r.status]}</span>
      <span class="badge b-${r.rule.state}">rule: ${r.rule.state}</span>
      <span class="t">${r.durationMs.toFixed(2)} ms</span>
    </div>
    <p class="muted" style="margin:0;font-size:14.5px">${esc(sentence(r))}</p>
    ${review}
    <dl class="kv">
      <dt>fingerprint</dt><dd>${esc(r.fingerprint.id)}</dd>
      <dt>rule</dt><dd>${esc(r.rule.id)}</dd>
      <dt>provenance</dt><dd>${esc(r.rule.provenance.method)} · confidence ${r.rule.provenance.confidence}</dd>
      ${r.rule.provenance.notes?.length ? `<dt>notes</dt><dd>${esc(r.rule.provenance.notes.join('; '))}</dd>` : ''}
    </dl>
    ${r.output ? box('Output → downstream', pretty(r.output), true) : box('Validation errors', esc(r.errors.map((e) => `✗ ${e.path}  ${e.message}`).join('\n')), true)}
    ${box('Rule (SML)', pretty(r.rule.fields))}
    ${box(`Shape · ${r.fingerprint.shape.length} entries`, esc(r.fingerprint.shape.map((e) => `${(e.path || '(root)').padEnd(34)} ${e.types.join('|')}`).join('\n')))}
    ${box('What a model would see', esc(`// redacted skeleton — paths and types only, ${sk.redactions} segment(s) redacted\n`) + pretty(sk.shape.map((e) => [e.path, e.types.join('|')])))}
    ${box(`Audit events · ${r.events.length}`, pretty(r.events))}`;
  els.out.querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', async () => {
      await engine.transition(b.dataset.rule, b.dataset.act, 'you');
      send();
    }),
  );
}

async function renderCache(engine, contractId) {
  const rules = await engine.store.list(contractId);
  const aliases = [...engine.store.index.entries()].filter(([k]) => k.startsWith(contractId + ' ')).length;
  els.cache.innerHTML = rules.length
    ? rules.map((r) => `<li><span>${esc(r.id)}</span><span class="badge b-${r.state}">${r.state}</span></li>`).join('') + `<li class="muted"><span>${aliases} fingerprint binding(s)</span></li>`
    : '<li class="muted">empty — send a payload</li>';
}

els.chips.innerHTML = scenarios.map((s) => `<button class="chip" type="button" data-key="${s.key}" aria-pressed="false">${esc(s.label)}</button>`).join('');
els.chips.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-key]');
  if (b) choose(scenarios.find((s) => s.key === b.dataset.key), { run: true });
});
els.send.addEventListener('click', send);
els.reset.addEventListener('click', () => {
  engines.clear();
  els.out.innerHTML = '<p class="muted">Cache cleared. Every structure is unseen again.</p>';
  els.cache.innerHTML = '<li class="muted">empty — send a payload</li>';
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    send();
  }
});

if (!globalThis.crypto?.subtle) {
  els.out.innerHTML = '<p class="err">This page needs a secure context (https) for Web Crypto.</p>';
} else {
  const initial = scenarios.find((s) => s.key === location.hash.slice(1)) ?? scenarios[0];
  // Seed the baseline so absorption scenarios linked directly still make sense.
  if (initial.contract.id === 'payments.v1' && initial.key !== 'baseline') {
    const seed = scenarios[0];
    await engineFor(JSON.stringify(seed.contract, null, 2)).process(seed.contract.id, { body: seed.body, contentType: seed.type });
  }
  choose(initial, { run: true });
}
