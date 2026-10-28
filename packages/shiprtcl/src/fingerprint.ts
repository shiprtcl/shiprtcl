/**
 * Structural fingerprinting, spec §4.
 *
 * A payload's shape is the set of (shape path, type markers) pairs found by walking
 * the IAST. Values are discarded. The canonical form is the RFC 8785 serialization of
 * the sorted shape, and the fingerprint is its SHA-256.
 */
import { WILDCARD, compareCodePoints, escapeSegment, isObject } from './pointer.js';
import { TYPE_MARKERS, type Fingerprint, type Json, type ShapeEntry, type TypeMarker } from './types.js';

export const FINGERPRINT_PREFIX = 'sr1:sha256:';

/** An object with more keys than this is always a MAP (spec §4.4, rule 3). */
export const MAX_STATIC_KEYS = 256;

/** Key patterns that indicate data used as keys (spec §4.4, rule 2). */
export const DYNAMIC_KEY_PATTERNS: readonly RegExp[] = [
  /^[0-9]+$/,
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.+\-Z]*)?$/,
  /^[0-9a-fA-F]{16,}$/,
  /^[A-Za-z]{2,8}_(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{8,}$/,
];

export function isDynamicKey(key: string): boolean {
  return DYNAMIC_KEY_PATTERNS.some((re) => re.test(key));
}

export interface ShapeOptions {
  /** Shape paths that must be treated as MAP regardless of their keys. */
  mapHints?: readonly string[];
}

export function typeOf(v: Json): TypeMarker {
  if (v === null) return 'NULL';
  if (Array.isArray(v)) return 'ARR';
  switch (typeof v) {
    case 'boolean':
      return 'BOOL';
    case 'number':
      return 'NUM';
    case 'string':
      return 'STR';
    default:
      return 'OBJ';
  }
}

/** Compute the structural shape of an IAST value (spec §4.3). */
export function shapeOf(value: Json, opts: ShapeOptions = {}): ShapeEntry[] {
  const hints = new Set(opts.mapHints ?? []);
  const acc = new Map<string, Set<TypeMarker>>();
  const add = (path: string, t: TypeMarker) => {
    let s = acc.get(path);
    if (!s) acc.set(path, (s = new Set()));
    s.add(t);
  };

  const walk = (v: Json, path: string): void => {
    if (Array.isArray(v)) {
      add(path, 'ARR');
      for (const el of v) walk(el, path + '/' + WILDCARD);
      return;
    }
    if (isObject(v)) {
      const keys = Object.keys(v);
      const asMap =
        hints.has(path) ||
        keys.length > MAX_STATIC_KEYS ||
        (keys.length > 0 && keys.every((k) => isDynamicKey(k.normalize('NFC'))));
      add(path, asMap ? 'MAP' : 'OBJ');
      for (const k of keys) {
        const child = asMap ? path + '/' + WILDCARD : path + '/' + escapeSegment(k.normalize('NFC'));
        walk(v[k]!, child);
      }
      return;
    }
    add(path, typeOf(v));
  };
  walk(value, '');

  return [...acc.entries()]
    .map(([path, types]) => ({ path, types: TYPE_MARKERS.filter((t) => types.has(t)) }))
    .sort((a, b) => compareCodePoints(a.path, b.path));
}

/** RFC 8785 canonical form of a shape. For arrays of strings this is exactly JSON.stringify. */
export function canonicalize(shape: readonly ShapeEntry[]): string {
  return JSON.stringify(shape.map((e) => [e.path, e.types.join('|')]));
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fingerprint(value: Json, opts: ShapeOptions = {}): Promise<Fingerprint> {
  const shape = shapeOf(value, opts);
  const canonical = canonicalize(shape);
  return { id: FINGERPRINT_PREFIX + (await sha256Hex(canonical)), canonical, shape };
}

/** Leaf entries: paths whose types include at least one scalar marker. */
export function leaves(shape: readonly ShapeEntry[]): ShapeEntry[] {
  return shape.filter((e) => e.types.some((t) => t === 'STR' || t === 'NUM' || t === 'BOOL'));
}

/**
 * The redacted skeleton sent to a synthesizer (spec §8.2). Segments that look like data
 * (emails, ids, phone numbers) are replaced, because key names are upstream-controlled.
 */
export function skeleton(shape: readonly ShapeEntry[]): { shape: ShapeEntry[]; redactions: number } {
  let redactions = 0;
  const looksLikeData = (seg: string) =>
    seg !== WILDCARD && (isDynamicKey(seg) || /[0-9]{7,}/.test(seg) || seg.length > 64);
  const out = shape.map((e) => ({
    path: e.path
      .split('/')
      .map((seg) => (seg && looksLikeData(seg) ? (redactions++, '~redacted') : seg))
      .join('/'),
    types: [...e.types],
  }));
  return { shape: out, redactions };
}
