/**
 * Wire format → IAST normalization, spec §3.
 * The reference implementation covers JSON, form-urlencoded and CSV. XML and YAML
 * normalization rules are specified (§3.4, §3.5) but not yet implemented here.
 */
import type { Json, JsonObject } from './types.js';

export class UnsupportedMediaType extends Error {
  constructor(public readonly mediaType: string) {
    super(`unsupported media type: ${mediaType || '(none)'}`);
  }
}

export function mediaTypeOf(contentType: string | undefined | null): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

export function parse(body: string, contentType: string | undefined | null): Json {
  const mt = mediaTypeOf(contentType);
  if (mt === 'application/json' || mt.endsWith('+json') || mt === '') return JSON.parse(body) as Json;
  if (mt === 'application/x-www-form-urlencoded') return parseForm(body);
  if (mt === 'text/csv' || mt === 'text/tab-separated-values') return parseCsv(body, mt === 'text/csv' ? ',' : '\t');
  throw new UnsupportedMediaType(mt);
}

/**
 * §3.2: every value is a string. A key ending in `[]` always yields an array under the
 * bare name; any other key repeated more than once also yields an array.
 */
export function parseForm(body: string): JsonObject {
  const out: JsonObject = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const forced = rawKey.endsWith('[]');
    const key = forced ? rawKey.slice(0, -2) : rawKey;
    const prev = out[key];
    if (forced) out[key] = Array.isArray(prev) ? [...prev, value] : [value];
    else if (prev === undefined) out[key] = value;
    else out[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
  }
  return out;
}

/**
 * §3.3: RFC 4180 with a mandatory header row. Every cell is a string — types are never
 * inferred from values, so a ZIP code like "01234" cannot change the fingerprint.
 * Short rows are padded with "", extra cells are kept under `_<index>` keys.
 */
export function parseCsv(body: string, delimiter = ','): JsonObject[] {
  const rows = csvRows(body.replace(/^﻿/, ''), delimiter);
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => !(r.length === 1 && r[0] === ''))
    .map((r) => {
      const obj: JsonObject = {};
      header.forEach((h, i) => (obj[h] = r[i] ?? ''));
      for (let i = header.length; i < r.length; i++) obj[`_${i}`] = r[i]!;
      return obj;
    });
}

function csvRows(text: string, d: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') (cell += '"'), i++;
        else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === d) row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += c;
  }
  if (cell !== '' || row.length) row.push(cell), rows.push(row);
  return rows;
}
