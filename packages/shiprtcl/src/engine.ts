/**
 * The resolution engine, spec §7 and §10: exact lookup → absorption → synthesis,
 * then apply, validate and decide. Transport-agnostic; see proxy.ts for HTTP.
 */
import { validate } from './contract.js';
import { fingerprint, leaves, skeleton } from './fingerprint.js';
import { parse } from './ingest.js';
import { MappingError, applyFields, checkFields, sourcePaths } from './mapping.js';
import { match } from './matcher.js';
import { verifySynthesized, type Synthesizer } from './synthesizer.js';
import {
  PROTOCOL_VERSION,
  type Contract,
  type FieldMap,
  type Fingerprint,
  type Json,
  type JsonObject,
  type Rule,
  type RuleState,
  type ShapeEntry,
  type ShipEvent,
  type ValidationError,
} from './types.js';

export interface RuleStore {
  /** The rule bound to (contract, fingerprint), directly or through an alias. */
  lookup(contract: string, fp: string): Promise<Rule | undefined>;
  get(ruleId: string): Promise<Rule | undefined>;
  put(rule: Rule): Promise<void>;
  alias(contract: string, fp: string, ruleId: string): Promise<void>;
  list(contract: string): Promise<Rule[]>;
}

export class MemoryStore implements RuleStore {
  rules = new Map<string, Rule>();
  index = new Map<string, string>();

  async lookup(contract: string, fp: string) {
    const id = this.index.get(`${contract} ${fp}`);
    return id ? this.rules.get(id) : undefined;
  }
  async get(ruleId: string) {
    return this.rules.get(ruleId);
  }
  async put(rule: Rule) {
    this.rules.set(rule.id, rule);
    const key = `${rule.contract} ${rule.source}`;
    if (rule.state !== 'retired') this.index.set(key, rule.id);
    else if (this.index.get(key) === rule.id) this.index.delete(key);
    for (const [k, v] of this.index) if (v === rule.id && rule.state === 'retired') this.index.delete(k);
  }
  async alias(contract: string, fp: string, ruleId: string) {
    this.index.set(`${contract} ${fp}`, ruleId);
  }
  async list(contract: string) {
    return [...this.rules.values()].filter((r) => r.contract === contract);
  }
  toJSON() {
    return { rules: [...this.rules.values()], index: Object.fromEntries(this.index) };
  }
  static from(data: { rules: Rule[]; index: Record<string, string> }): MemoryStore {
    const s = new MemoryStore();
    for (const r of data.rules) s.rules.set(r.id, r);
    for (const [k, v] of Object.entries(data.index)) s.index.set(k, v);
    return s;
  }
}

export interface Policy {
  /** Deterministic rules at or above this confidence activate automatically. Default 0.8. */
  autoActivateThreshold: number;
  /** Whether rules that needed a synthesizer activate without human review. Default false. */
  autoActivateSynthesized: boolean;
}

export const DEFAULT_POLICY: Policy = { autoActivateThreshold: 0.8, autoActivateSynthesized: false };

export type Resolution = 'hit' | 'absorbed' | 'synthesized';
export type Status = 'translated' | 'held' | 'quarantined';

export interface ProcessResult {
  status: Status;
  resolution: Resolution;
  fingerprint: Fingerprint;
  rule: Rule;
  output?: JsonObject;
  errors: ValidationError[];
  events: ShipEvent[];
  durationMs: number;
}

export interface EngineOptions {
  contracts: Contract[];
  store?: RuleStore;
  synthesizer?: Synthesizer;
  policy?: Partial<Policy>;
  /** CloudEvents `source` attribute. */
  source?: string;
  onEvent?: (e: ShipEvent) => void;
}

export class UnknownContract extends Error {}

export type Input = { body: string; contentType?: string | null } | { value: Json };

export class Engine {
  readonly store: RuleStore;
  readonly policy: Policy;
  private contracts = new Map<string, Contract>();
  private inflight = new Map<string, Promise<Rule>>();

  constructor(private opts: EngineOptions) {
    this.store = opts.store ?? new MemoryStore();
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
    for (const c of opts.contracts) this.contracts.set(c.id, c);
  }

  contract(id: string): Contract {
    const c = this.contracts.get(id);
    if (!c) throw new UnknownContract(`unknown contract: ${id}`);
    return c;
  }

  async process(contractId: string, input: Input): Promise<ProcessResult> {
    const t0 = performance.now();
    const contract = this.contract(contractId);
    const events: ShipEvent[] = [];
    const emit = (type: string, data: Record<string, unknown>) => {
      const e = this.event(type, contract.id, data);
      events.push(e);
      this.opts.onEvent?.(e);
    };

    const value = 'value' in input ? input.value : parse(input.body, input.contentType);
    const fp = await fingerprint(value, { mapHints: contract.mapHints });

    let resolution: Resolution = 'hit';
    let rule = await this.store.lookup(contract.id, fp.id);
    if (rule?.state === 'retired') rule = undefined;

    if (!rule) {
      const absorbed = await this.absorb(contract, fp, value);
      if (absorbed) {
        resolution = 'absorbed';
        rule = absorbed.rule;
        await this.store.alias(contract.id, fp.id, rule.id);
        emit('org.shiprtcl.drift.absorbed', { fingerprint: fp.id, rule: rule.id, added: absorbed.added, missing: absorbed.missing });
      }
    }

    if (!rule) {
      resolution = 'synthesized';
      const previous = await this.latestActive(contract.id);
      emit('org.shiprtcl.drift.detected', { fingerprint: fp.id, previous: previous?.source ?? null, diff: previous ? shapeDiff(previous.shape, fp.shape) : null });
      const key = `${contract.id} ${fp.id}`;
      let pending = this.inflight.get(key);
      const leader = !pending;
      if (!pending) {
        pending = this.synthesize(contract, fp, value).finally(() => this.inflight.delete(key));
        this.inflight.set(key, pending);
      }
      rule = await pending;
      if (leader)
        emit('org.shiprtcl.rule.created', {
          rule: rule.id, fingerprint: fp.id, state: rule.state, method: rule.provenance.method,
          model: rule.provenance.model ?? null, confidence: rule.provenance.confidence, notes: rule.provenance.notes ?? [],
        });
    }

    const { output, errors } = run(rule.fields, value, contract);
    let status: Status;
    if (errors.length) {
      status = 'quarantined';
      emit('org.shiprtcl.payload.quarantined', { fingerprint: fp.id, rule: rule.id, errors });
      if (resolution !== 'synthesized' && rule.state === 'active') emit('org.shiprtcl.rule.suspect', { rule: rule.id, fingerprint: fp.id, errors });
    } else if (rule.state === 'active') {
      status = 'translated';
      emit('org.shiprtcl.payload.translated', { fingerprint: fp.id, rule: rule.id, resolution });
    } else {
      status = 'held';
      emit('org.shiprtcl.payload.held', { fingerprint: fp.id, rule: rule.id, state: rule.state });
    }

    return {
      status, resolution, fingerprint: fp, rule, errors, events,
      output: status === 'quarantined' ? undefined : output,
      durationMs: performance.now() - t0,
    };
  }

  /** Move a rule through its lifecycle (spec §9). */
  async transition(ruleId: string, state: RuleState, actor = 'human'): Promise<Rule> {
    const rule = await this.store.get(ruleId);
    if (!rule) throw new Error(`unknown rule: ${ruleId}`);
    const from = rule.state;
    const next: Rule = { ...rule, state };
    await this.store.put(next);
    this.opts.onEvent?.(this.event(`org.shiprtcl.rule.${state === 'active' ? 'activated' : state}`, rule.contract, { rule: rule.id, from, to: state, actor }));
    return next;
  }

  private async latestActive(contractId: string): Promise<Rule | undefined> {
    const rules = (await this.store.list(contractId)).filter((r) => r.state === 'active');
    return rules.sort((a, b) => b.provenance.createdAt.localeCompare(a.provenance.createdAt))[0];
  }

  /** Absorption, spec §7.2: reuse an active rule when the new shape cannot change its meaning. */
  private async absorb(contract: Contract, fp: Fingerprint, value: Json) {
    const shape = new Map(fp.shape.map((e) => [e.path, e.types]));
    const rules = (await this.store.list(contract.id))
      .filter((r) => r.state === 'active')
      .sort((a, b) => b.provenance.createdAt.localeCompare(a.provenance.createdAt));
    for (const rule of rules) {
      const ruleShape = new Map(rule.shape.map((e) => [e.path, e.types]));
      const used = sourcePaths(rule.fields);
      const typeDrift = used.some((p) => {
        const now = shape.get(p)?.filter((t) => t !== 'NULL');
        const then = ruleShape.get(p)?.filter((t) => t !== 'NULL') ?? [];
        return now !== undefined && now.length > 0 && then.length > 0 && now.some((t) => !then.includes(t));
      });
      if (typeDrift) continue;
      const missing = used.filter((p) => !shape.has(p));
      const added = leaves(fp.shape).map((e) => e.path).filter((p) => !ruleShape.has(p));
      if (missing.length && added.length) continue; // looks like a rename: synthesize instead
      if (run(rule.fields, value, contract).errors.length) continue;
      return { rule, missing, added };
    }
    return undefined;
  }

  private async synthesize(contract: Contract, fp: Fingerprint, value: Json): Promise<Rule> {
    const m = match(fp.shape, contract.schema);
    let fields: FieldMap[] = m.fields;
    let method: Rule['provenance']['method'] = 'deterministic';
    let model: string | undefined;
    const notes: string[] = [];

    if (m.unresolved.length && this.opts.synthesizer) {
      const sk = skeleton(fp.shape);
      if (sk.redactions) notes.push(`${sk.redactions} key segment(s) redacted from synthesizer input`);
      try {
        const proposed = await this.opts.synthesizer.synthesize({ contractId: contract.id, skeleton: sk.shape, target: contract.schema, resolved: m.fields, unresolved: m.unresolved });
        const taken = new Set(fields.map((f) => f.to));
        const extra = proposed.filter((f) => !taken.has(f.to));
        const problems = verifySynthesized(extra, sk.shape, contract.schema);
        if (problems.length) notes.push(`synthesizer output rejected: ${problems.slice(0, 5).join('; ')}`);
        else if (extra.length) {
          fields = [...fields, ...extra].sort((a, b) => a.to.localeCompare(b.to));
          method = 'llm';
          model = this.opts.synthesizer.name;
        }
      } catch (err) {
        notes.push(`synthesizer failed: ${(err as Error).message}`);
      }
    }
    const structural = checkFields(fields);
    if (structural.length) throw new Error(`invalid rule: ${structural.join('; ')}`);

    const unresolved = m.unresolved.filter((p) => !fields.some((f) => f.to === p));
    if (unresolved.length) notes.push(`unmapped targets: ${unresolved.join(', ')}`);
    const ok = run(fields, value, contract).errors.length === 0;
    let state: RuleState;
    if (!ok) state = 'proposed';
    else if (method === 'deterministic') state = m.confidence >= this.policy.autoActivateThreshold ? 'active' : 'shadow';
    else state = this.policy.autoActivateSynthesized ? 'active' : 'shadow';

    const rule: Rule = {
      shiprtcl: PROTOCOL_VERSION,
      id: `rule_${fp.id.slice(-64, -52)}_${Date.now().toString(36)}`,
      contract: contract.id,
      source: fp.id,
      shape: fp.shape,
      state,
      provenance: { method, ...(model ? { model } : {}), confidence: m.confidence, createdAt: new Date().toISOString(), notes },
      fields,
    };
    await this.store.put(rule);
    return rule;
  }

  private event(type: string, subject: string, data: Record<string, unknown>): ShipEvent {
    return {
      specversion: '1.0',
      id: globalThis.crypto.randomUUID(),
      source: this.opts.source ?? 'shiprtcl://engine',
      type,
      time: new Date().toISOString(),
      subject,
      datacontenttype: 'application/json',
      data,
    };
  }
}

function run(fields: FieldMap[], value: Json, contract: Contract): { output?: JsonObject; errors: ValidationError[] } {
  try {
    const output = applyFields(fields, value);
    return { output, errors: validate(output, contract.schema) };
  } catch (err) {
    if (err instanceof MappingError) return { errors: [{ path: err.to, message: err.message }] };
    throw err;
  }
}

/** Paths added and removed between two shapes — the "structural diff" in audit events. */
export function shapeDiff(before: readonly ShapeEntry[], after: readonly ShapeEntry[]) {
  const b = new Map(before.map((e) => [e.path, e.types.join('|')]));
  const a = new Map(after.map((e) => [e.path, e.types.join('|')]));
  return {
    added: [...a.keys()].filter((p) => !b.has(p)),
    removed: [...b.keys()].filter((p) => !a.has(p)),
    retyped: [...a.keys()].filter((p) => b.has(p) && b.get(p) !== a.get(p)).map((p) => ({ path: p, from: b.get(p), to: a.get(p) })),
  };
}
