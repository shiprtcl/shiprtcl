/**
 * The SHIPRTCL Mapping Language (SML), spec §6. Declarative and total: no loops other
 * than `each` over an existing array, no user code, no I/O. Every rule terminates in
 * time linear in the size of the payload.
 */
import { WILDCARD, get, isObject, set } from './pointer.js';
import type { Cast, FieldMap, Json, JsonObject, ShapeEntry } from './types.js';

export class MappingError extends Error {
  constructor(public readonly to: string, message: string) {
    super(`${to}: ${message}`);
  }
}

const FIELD_KEYS = new Set(['to', 'from', 'const', 'default', 'enum', 'cast', 'scale', 'each']);
const CASTS = new Set<Cast>(['string', 'number', 'integer', 'boolean']);

/** Structural validation of a field list (spec §6.2). Returns problems, empty when valid. */
export function checkFields(fields: unknown, at = 'fields'): string[] {
  if (!Array.isArray(fields)) return [`${at}: must be an array`];
  const problems: string[] = [];
  const targets = new Set<string>();
  fields.forEach((f, i) => {
    const here = `${at}[${i}]`;
    if (!isObject(f as Json)) return problems.push(`${here}: must be an object`);
    const m = f as Record<string, unknown>;
    for (const k of Object.keys(m)) if (!FIELD_KEYS.has(k)) problems.push(`${here}: unknown key "${k}"`);
    if (typeof m.to !== 'string' || !m.to.startsWith('/') || m.to.includes(WILDCARD)) problems.push(`${here}.to: must be a concrete JSON Pointer`);
    else if (targets.has(m.to)) problems.push(`${here}.to: duplicate target ${m.to}`);
    else targets.add(m.to);
    if (m.from !== undefined && (typeof m.from !== 'string' || (m.from !== '' && !m.from.startsWith('/')) || m.from.includes(WILDCARD)))
      problems.push(`${here}.from: must be a concrete JSON Pointer`);
    if (m.from === undefined && m.const === undefined && m.default === undefined) problems.push(`${here}: needs from, const or default`);
    if (m.cast !== undefined && !CASTS.has(m.cast as Cast)) problems.push(`${here}.cast: unknown cast "${String(m.cast)}"`);
    if (m.scale !== undefined && (typeof m.scale !== 'number' || !Number.isFinite(m.scale))) problems.push(`${here}.scale: must be a finite number`);
    if (m.enum !== undefined && !isObject(m.enum as Json)) problems.push(`${here}.enum: must be an object`);
    if (m.each !== undefined) {
      if (m.from === undefined) problems.push(`${here}.each: requires from`);
      problems.push(...checkFields(m.each, `${here}.each`));
    }
  });
  return problems;
}

function castValue(v: Json, cast: Cast, to: string): Json {
  switch (cast) {
    case 'string':
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      throw new MappingError(to, `cannot cast ${typeof v} to string`);
    case 'number':
    case 'integer': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) throw new MappingError(to, `cannot cast ${typeof v} value to ${cast}`);
      return n;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string' && /^(true|1|yes)$/i.test(v)) return true;
      if (typeof v === 'string' && /^(false|0|no)$/i.test(v)) return false;
      if (v === 1 || v === 0) return v === 1;
      throw new MappingError(to, `cannot cast ${typeof v} value to boolean`);
  }
}

/** Evaluate one field against a source scope, spec §6.3 (evaluation order). */
function evalField(f: FieldMap, scope: Json): Json | undefined {
  let v: Json | undefined = f.from === undefined ? undefined : get(scope, f.from);
  if (v === null) v = undefined; // spec §6.3 step 1: a null source is treated as absent
  if (v === undefined && f.default !== undefined) v = f.default;
  if (f.const !== undefined) v = f.const;
  if (v === undefined) return undefined;
  if (f.each) {
    if (v === null) return null;
    if (!Array.isArray(v)) throw new MappingError(f.to, 'each requires an array');
    return v.map((el) => applyFields(f.each!, el));
  }
  if (v === null) return null;
  if (f.enum) {
    const key = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
    if (key !== undefined && Object.prototype.hasOwnProperty.call(f.enum, key)) v = f.enum[key]!;
  }
  if (f.cast) v = castValue(v, f.cast, f.to);
  if (f.scale !== undefined) {
    if (typeof v !== 'number') throw new MappingError(f.to, 'scale requires a number');
    v = Number((v * f.scale).toPrecision(15));
  }
  if (f.cast === 'integer') v = Math.round(v as number);
  return v;
}

export function applyFields(fields: readonly FieldMap[], source: Json): JsonObject {
  const out: JsonObject = {};
  for (const f of fields) {
    const v = evalField(f, source);
    if (v !== undefined) set(out, f.to, v);
  }
  return out;
}

/** Absolute source shape paths a field list reads from, with `~*` for `each` scopes. */
export function sourcePaths(fields: readonly FieldMap[], prefix = ''): string[] {
  const out: string[] = [];
  for (const f of fields) {
    if (f.from === undefined) continue;
    const abs = prefix + f.from;
    out.push(abs);
    if (f.each) out.push(...sourcePaths(f.each, abs + '/' + WILDCARD));
  }
  return out;
}

/** Absolute target paths written, with `~*` for array scopes. */
export function targetPaths(fields: readonly FieldMap[], prefix = ''): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const abs = prefix + f.to;
    out.push(abs);
    if (f.each) out.push(...targetPaths(f.each, abs + '/' + WILDCARD));
  }
  return out;
}

export function hasPath(shape: readonly ShapeEntry[], path: string): boolean {
  return shape.some((e) => e.path === path);
}
