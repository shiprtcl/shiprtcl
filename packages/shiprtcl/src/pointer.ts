/**
 * JSON Pointer (RFC 6901) helpers plus the SHIPRTCL wildcard segment `~*`,
 * which stands for "every element of an array" or "every value of a MAP".
 * `~*` is not a valid RFC 6901 escape, so it can never collide with a real key.
 */
import type { Json, JsonObject } from './types.js';

export const WILDCARD = '~*';

export function escapeSegment(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapeSegment(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function split(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`invalid pointer: ${pointer}`);
  return pointer.slice(1).split('/');
}

export function join(segments: string[]): string {
  return segments.map((s) => '/' + s).join('');
}

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Resolve a concrete pointer (no wildcards). Returns undefined when absent. */
export function get(doc: Json | undefined, pointer: string): Json | undefined {
  let cur: Json | undefined = doc;
  for (const raw of split(pointer)) {
    if (raw === WILDCARD) throw new Error('wildcard not allowed in concrete pointer');
    const seg = unescapeSegment(raw);
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (isObject(cur)) {
      cur = Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : undefined;
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Set a value at a concrete pointer, creating intermediate objects. */
export function set(doc: JsonObject, pointer: string, value: Json): void {
  const segs = split(pointer).map(unescapeSegment);
  if (segs.length === 0) throw new Error('cannot set the root');
  let cur: JsonObject = doc;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const next = cur[seg];
    if (!isObject(next)) cur[seg] = {};
    cur = cur[seg] as JsonObject;
  }
  cur[segs[segs.length - 1]!] = value;
}

/** Compare two strings by Unicode code point (equivalent to UTF-8 byte order). */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx - cy;
  }
}
