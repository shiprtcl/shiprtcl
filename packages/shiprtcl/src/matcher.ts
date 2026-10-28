/**
 * The deterministic matcher, spec §8.1. Proposes field mappings from the source shape and
 * the target contract alone — never from values — so the result is a pure function of
 * (shape, contract) and is safe to cache under the fingerprint.
 */
import { typesOf } from './contract.js';
import { WILDCARD, unescapeSegment } from './pointer.js';
import type { Cast, FieldMap, Schema, ShapeEntry, TypeMarker } from './types.js';

export interface FieldMatch {
  to: string;
  from: string;
  score: number;
}

export interface MatchResult {
  fields: FieldMap[];
  matches: FieldMatch[];
  /** Absolute target paths (with `~*` for arrays) that found no candidate. */
  unresolved: string[];
  /** The subset of `unresolved` that the contract marks as required. */
  unresolvedRequired: string[];
  /** Minimum score across accepted matches; 0 when nothing matched. */
  confidence: number;
}

export const ACCEPT_THRESHOLD = 0.55;

const STOP = new Set(['the', 'a', 'of', 'data', 'info', 'value', 'at', 'on', 'is', 'field', 'attr', 'attribute', 'obj', 'object', 'detail', 'details']);
const WEAK = new Set(['addr', 'line', 'no', 'num', 'number', 'code', 'raw', 'new', 'old', 'current', 'v1', 'v2', 'str']);
const WEAK_WEIGHT = 0.35;

const GROUPS: Record<string, string[]> = {
  id: ['id', 'identifier', 'uid', 'uuid', 'guid', 'ref', 'reference'],
  email: ['email', 'mail', 'emailaddress'],
  amount: ['amount', 'amt', 'total', 'subtotal', 'sum', 'price', 'cost'],
  customer: ['customer', 'buyer', 'user', 'client', 'purchaser', 'payer', 'shopper', 'member', 'contact'],
  event: ['event', 'type', 'kind', 'topic', 'action'],
  name: ['name', 'fullname', 'displayname'],
  first: ['first', 'given', 'fname', 'firstname'],
  last: ['last', 'family', 'surname', 'lname', 'lastname'],
  phone: ['phone', 'mobile', 'tel', 'telephone', 'cell', 'msisdn'],
  time: ['time', 'timestamp', 'ts', 'date', 'datetime', 'created', 'createdat', 'occurred', 'when'],
  currency: ['currency', 'cur', 'ccy', 'curr'],
  status: ['status', 'state'],
  item: ['item', 'lineitem', 'product'],
  quantity: ['quantity', 'qty', 'count', 'units'],
  order: ['order', 'purchase', 'checkout'],
  description: ['description', 'desc', 'note', 'memo', 'comment'],
  country: ['country', 'nation'],
  zip: ['zip', 'postal', 'postcode', 'pincode', 'zipcode'],
  city: ['city', 'town'],
  message: ['message', 'msg', 'body', 'text'],
};
const SYNONYM = new Map<string, string>();
for (const [canon, words] of Object.entries(GROUPS)) for (const w of words) SYNONYM.set(w, canon);

interface Tok {
  canon: string;
  viaSynonym: boolean;
}

function singular(t: string): string {
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) return t.slice(0, -1);
  return t;
}

export function tokens(segment: string): Tok[] {
  return unescapeSegment(segment)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((t) => singular(t.toLowerCase()))
    .filter((t) => t && !STOP.has(t))
    .map((t) => {
      const canon = SYNONYM.get(t) ?? t;
      return { canon, viaSynonym: canon !== t };
    });
}

function weightedJaccard(a: Tok[], b: Tok[]): { sim: number; viaSynonym: boolean } {
  const wa = new Map<string, number>();
  const wb = new Map<string, number>();
  const w = (t: string) => (WEAK.has(t) ? WEAK_WEIGHT : 1);
  for (const t of a) wa.set(t.canon, w(t.canon));
  for (const t of b) wb.set(t.canon, w(t.canon));
  let inter = 0;
  let union = 0;
  for (const [k, v] of wa) (wb.has(k) ? (inter += v) : 0), (union += v);
  for (const [k, v] of wb) if (!wa.has(k)) union += v;
  const shared = new Set([...wa.keys()].filter((k) => wb.has(k)));
  const viaSynonym = [...a, ...b].some((t) => shared.has(t.canon) && t.viaSynonym);
  return { sim: union === 0 ? 0 : inter / union, viaSynonym };
}

/** Name similarity between two relative shape paths, 0..1. */
export function pathSimilarity(target: string, source: string): number {
  const ts = target.split('/').filter(Boolean);
  const ss = source.split('/').filter(Boolean);
  const leaf = weightedJaccard(tokens(ts[ts.length - 1] ?? ''), tokens(ss[ss.length - 1] ?? ''));
  const tp = ts.slice(0, -1).flatMap(tokens);
  const sp = ss.slice(0, -1).flatMap(tokens);
  const ctx = tp.length === 0 && sp.length === 0 ? 1 : tp.length === 0 || sp.length === 0 ? 0.5 : weightedJaccard(tp, sp).sim;
  const whole = weightedJaccard(ts.flatMap(tokens), ss.flatMap(tokens));
  const penalty = (viaSynonym: boolean) => (viaSynonym ? 0.9 : 1);
  return Math.max((0.7 * leaf.sim + 0.3 * ctx) * penalty(leaf.viaSynonym), whole.sim * 0.95 * penalty(whole.viaSynonym));
}

/** How well source types satisfy target types, and the cast needed (spec §8.1 table). */
export function typeFit(src: readonly TypeMarker[], target: Schema): { factor: number; cast?: Cast } {
  const s = src.filter((t) => t !== 'NULL');
  const want = typesOf(target).filter((t) => t !== 'null');
  if (s.length !== 1 || want.length === 0) return { factor: s.length === 1 && want.length === 0 ? 1 : 0 };
  const t = s[0]!;
  let best: { factor: number; cast?: Cast } = { factor: 0 };
  const consider = (factor: number, cast?: Cast) => factor > best.factor && (best = { factor, cast });
  for (const w of want) {
    if (w === 'string') t === 'STR' ? consider(1) : t === 'NUM' || t === 'BOOL' ? consider(0.9, 'string') : 0;
    if (w === 'number') t === 'NUM' ? consider(1) : t === 'STR' ? consider(0.75, 'number') : 0;
    if (w === 'integer') t === 'NUM' ? consider(0.95, 'integer') : t === 'STR' ? consider(0.7, 'integer') : 0;
    if (w === 'boolean') t === 'BOOL' ? consider(1) : t === 'STR' || t === 'NUM' ? consider(0.7, 'boolean') : 0;
    if (w === 'object') t === 'OBJ' || t === 'MAP' ? consider(1) : 0;
  }
  return best;
}

interface TargetLeaf {
  rel: string;
  schema: Schema;
  required: boolean;
}

/** Flatten an object schema into leaves, descending into nested objects but not arrays. */
function targetLeaves(schema: Schema, prefix = '', parentRequired = true): TargetLeaf[] {
  const out: TargetLeaf[] = [];
  const req = new Set(schema.required ?? []);
  for (const [k, sub] of Object.entries(schema.properties ?? {})) {
    const rel = `${prefix}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    const required = parentRequired && req.has(k);
    if (typesOf(sub).includes('object') && sub.properties) out.push(...targetLeaves(sub, rel, required));
    else out.push({ rel, schema: sub, required });
  }
  return out;
}

/** Source entries directly inside `scope` (not crossing another wildcard). */
function inScope(shape: readonly ShapeEntry[], scope: string): { rel: string; entry: ShapeEntry }[] {
  return shape
    .filter((e) => e.path.startsWith(scope + '/') && !e.path.slice(scope.length + 1).split('/').includes(WILDCARD))
    .map((e) => ({ rel: e.path.slice(scope.length), entry: e }));
}

export function match(shape: readonly ShapeEntry[], schema: Schema): MatchResult {
  const result: MatchResult = { fields: [], matches: [], unresolved: [], unresolvedRequired: [], confidence: 0 };
  result.fields = matchScope(shape, schema, '', '', true, result);
  result.confidence = result.matches.length ? Math.min(...result.matches.map((m) => m.score)) : 0;
  return result;
}

function matchScope(shape: readonly ShapeEntry[], schema: Schema, srcScope: string, tgtAbs: string, required: boolean, result: MatchResult): FieldMap[] {
  const fields: FieldMap[] = [];
  const candidates = inScope(shape, srcScope);
  const leaves = targetLeaves(schema, '', required);
  // A scope that is itself an array (e.g. a CSV drop) can feed a target's only array field.
  const scopeEntry = shape.find((e) => e.path === srcScope);
  const arrayTargets = leaves.filter((l) => typesOf(l.schema).includes('array'));
  const rootFeeds = scopeEntry?.types.includes('ARR') && arrayTargets.length === 1 ? arrayTargets[0] : undefined;
  if (rootFeeds) candidates.push({ rel: '', entry: scopeEntry! });
  const used = new Set<string>();

  const scored: { leaf: TargetLeaf; rel: string; score: number; cast?: Cast; isArray: boolean }[] = [];
  for (const leaf of leaves) {
    const isArray = typesOf(leaf.schema).includes('array');
    for (const c of candidates) {
      if (isArray !== c.entry.types.includes('ARR')) continue;
      let fit: { factor: number; cast?: Cast };
      if (isArray) {
        const items = leaf.schema.items ?? {};
        const isObjArray = typesOf(items).includes('object');
        const elem = shape.find((e) => e.path === srcScope + c.rel + '/' + WILDCARD);
        fit = isObjArray ? { factor: elem && elem.types.includes('OBJ') ? 1 : elem ? 0 : 0.8 } : elem ? typeFit(elem.types, items) : { factor: 0.8 };
        if (fit.cast) fit = { factor: 0 }; // scalar arrays are copied as-is in v0.1
      } else fit = typeFit(c.entry.types, leaf.schema);
      if (fit.factor === 0) continue;
      if (c.rel === '' && leaf !== rootFeeds) continue;
      const sim = c.rel === '' ? 0.9 : leaf.rel === c.rel ? 1 : pathSimilarity(leaf.rel, c.rel);
      const score = Number((sim * fit.factor).toFixed(4));
      if (score >= ACCEPT_THRESHOLD) scored.push({ leaf, rel: c.rel, score, cast: fit.cast, isArray });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.leaf.rel.localeCompare(b.leaf.rel));

  const done = new Set<string>();
  for (const s of scored) {
    if (done.has(s.leaf.rel) || used.has(s.rel)) continue;
    done.add(s.leaf.rel);
    used.add(s.rel);
    const f: FieldMap = { to: s.leaf.rel, from: s.rel };
    if (s.cast) f.cast = s.cast;
    const items = s.leaf.schema.items;
    if (s.isArray && items && typesOf(items).includes('object')) {
      f.each = matchScope(shape, items, srcScope + s.rel + '/' + WILDCARD, tgtAbs + s.leaf.rel + '/' + WILDCARD, s.leaf.required, result);
    }
    fields.push(f);
    result.matches.push({ to: tgtAbs + s.leaf.rel, from: srcScope + s.rel, score: s.score });
  }
  for (const leaf of leaves) {
    if (done.has(leaf.rel)) continue;
    result.unresolved.push(tgtAbs + leaf.rel);
    if (leaf.required) result.unresolvedRequired.push(tgtAbs + leaf.rel);
  }
  return fields.sort((a, b) => a.to.localeCompare(b.to));
}
