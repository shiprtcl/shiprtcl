/** Contract validation over the JSON Schema subset defined in spec §5. */
import { escapeSegment, isObject } from './pointer.js';
import type { Json, Schema, SchemaType, ValidationError } from './types.js';

const KNOWN_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
  'minimum', 'maximum', 'minLength', 'maxLength', 'description', 'title', '$schema', '$id',
]);

/** Reject schemas that use keywords outside the subset, so behaviour never silently differs. */
export function checkSchema(schema: Schema, path = ''): string[] {
  const problems: string[] = [];
  for (const k of Object.keys(schema)) if (!KNOWN_KEYWORDS.has(k)) problems.push(`${path || '/'}: unsupported keyword "${k}"`);
  for (const [k, s] of Object.entries(schema.properties ?? {})) problems.push(...checkSchema(s, `${path}/${escapeSegment(k)}`));
  if (schema.items) problems.push(...checkSchema(schema.items, `${path}/items`));
  return problems;
}

export function typesOf(schema: Schema): SchemaType[] {
  if (!schema.type) return [];
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function matchesType(v: Json, t: SchemaType): boolean {
  switch (t) {
    case 'null': return v === null;
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'array': return Array.isArray(v);
    case 'object': return isObject(v);
  }
}

export function validate(value: Json, schema: Schema, path = ''): ValidationError[] {
  const errs: ValidationError[] = [];
  const at = path || '/';
  const types = typesOf(schema);
  if (types.length && !types.some((t) => matchesType(value, t))) {
    errs.push({ path: at, message: `expected ${types.join(' | ')}` });
    return errs;
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    errs.push({ path: at, message: `must be one of ${JSON.stringify(schema.enum)}` });
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push({ path: at, message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errs.push({ path: at, message: `must be <= ${schema.maximum}` });
  }
  if (typeof value === 'string') {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) errs.push({ path: at, message: `length must be >= ${schema.minLength}` });
    if (schema.maxLength !== undefined && len > schema.maxLength) errs.push({ path: at, message: `length must be <= ${schema.maxLength}` });
  }
  if (Array.isArray(value) && schema.items)
    value.forEach((el, i) => errs.push(...validate(el, schema.items!, `${path}/${i}`)));
  if (isObject(value)) {
    const props = schema.properties ?? {};
    for (const r of schema.required ?? [])
      if (!(r in value)) errs.push({ path: `${path}/${escapeSegment(r)}`, message: 'is required' });
    for (const [k, v] of Object.entries(value)) {
      const sub = props[k];
      if (sub) errs.push(...validate(v, sub, `${path}/${escapeSegment(k)}`));
      else if (schema.additionalProperties === false) errs.push({ path: `${path}/${escapeSegment(k)}`, message: 'is not allowed' });
    }
  }
  return errs;
}
