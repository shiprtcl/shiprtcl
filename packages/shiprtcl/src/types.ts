/** SHIPRTCL v0.1 — shared types. See spec/shiprtcl-v0.1.md. */

export const PROTOCOL_VERSION = '0.1';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Type markers, spec §4.2. Order here is the canonical sort order. */
export const TYPE_MARKERS = ['ARR', 'BOOL', 'MAP', 'NULL', 'NUM', 'OBJ', 'STR'] as const;
export type TypeMarker = (typeof TYPE_MARKERS)[number];

/** One entry of a structural shape: a shape path and the set of types observed there. */
export interface ShapeEntry {
  path: string;
  types: TypeMarker[];
}

export interface Fingerprint {
  /** `sr1:sha256:<64 hex>` */
  id: string;
  /** The exact UTF-8 string that was hashed. */
  canonical: string;
  shape: ShapeEntry[];
}

/** A JSON Schema (2020-12) subset, spec §5. */
export interface Schema {
  type?: SchemaType | SchemaType[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: Json[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  description?: string;
  title?: string;
}
export type SchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export interface Contract {
  id: string;
  schema: Schema;
  /** Shape paths in upstream payloads that must be treated as MAP (spec §4.4). */
  mapHints?: string[];
}

export type Cast = 'string' | 'number' | 'integer' | 'boolean';

/** A single field mapping in the SHIPRTCL Mapping Language, spec §6. */
export interface FieldMap {
  to: string;
  from?: string;
  const?: Json;
  default?: Json;
  enum?: Record<string, Json>;
  cast?: Cast;
  scale?: number;
  each?: FieldMap[];
}

export type RuleState = 'proposed' | 'shadow' | 'active' | 'retired';
export type SynthesisMethod = 'deterministic' | 'llm' | 'human';

export interface Provenance {
  method: SynthesisMethod;
  /** Model identifier when method = llm. */
  model?: string;
  /** 0..1, the minimum per-field confidence. */
  confidence: number;
  createdAt: string;
  /** Free-form notes, e.g. unresolved targets. Never contains payload values. */
  notes?: string[];
}

/** A rule document, spec §6.1. */
export interface Rule {
  shiprtcl: typeof PROTOCOL_VERSION;
  id: string;
  contract: string;
  /** The fingerprint this rule was synthesized for. */
  source: string;
  /** The source shape, used for absorption (spec §7.2). */
  shape: ShapeEntry[];
  state: RuleState;
  provenance: Provenance;
  fields: FieldMap[];
}

/** CloudEvents 1.0 structured event, spec §11. */
export interface ShipEvent {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  time: string;
  subject: string;
  datacontenttype: 'application/json';
  data: Record<string, unknown>;
}

export interface ValidationError {
  path: string;
  message: string;
}
