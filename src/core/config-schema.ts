import type { JsonSchema } from './manifest.ts';

export type FieldType = 'string' | 'number' | 'boolean' | 'enum';

/** One renderable config control, derived entirely from a manifest's JSON Schema. */
export interface FieldDescriptor {
  key: string;
  type: FieldType;
  title: string;
  description?: string;
  default?: string | number | boolean;
  /** Allowed values for `enum` fields. */
  options?: string[];
  required: boolean;
  /** `password` masks the input — for keys and tokens. */
  format?: string;
}

function properties(schema: JsonSchema | undefined): Record<string, Record<string, unknown>> {
  const props = schema?.properties;
  if (!props || typeof props !== 'object') return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    if (value && typeof value === 'object') out[key] = value as Record<string, unknown>;
  }
  return out;
}

function requiredKeys(schema: JsonSchema | undefined): Set<string> {
  const required = schema?.required;
  return new Set(Array.isArray(required) ? required.filter((k): k is string => typeof k === 'string') : []);
}

/**
 * Turn a manifest's `config` schema into form controls.
 *
 * This is the point of the schema-driven design: adding a setting is a manifest change, not a
 * dashboard change. Unsupported shapes (arrays, objects) are skipped rather than crashing, so a
 * richer schema degrades gracefully instead of breaking the page.
 */
export function fieldDescriptors(schema: JsonSchema | undefined): FieldDescriptor[] {
  const required = requiredKeys(schema);
  const fields: FieldDescriptor[] = [];

  for (const [key, prop] of Object.entries(properties(schema))) {
    const title = typeof prop.title === 'string' ? prop.title : key;
    const description = typeof prop.description === 'string' ? prop.description : undefined;
    const format = typeof prop.format === 'string' ? prop.format : undefined;
    const rawDefault = prop.default;
    const defaultValue =
      typeof rawDefault === 'string' || typeof rawDefault === 'number' || typeof rawDefault === 'boolean'
        ? rawDefault
        : undefined;
    const options = Array.isArray(prop.enum) ? prop.enum.map(String) : undefined;

    let type: FieldType;
    if (options && options.length > 0) type = 'enum';
    else if (prop.type === 'boolean') type = 'boolean';
    else if (prop.type === 'number' || prop.type === 'integer') type = 'number';
    else if (prop.type === 'string') type = 'string';
    else continue; // arrays/objects/unknown: no control

    fields.push({ key, type, title, description, default: defaultValue, options, required: required.has(key), format });
  }

  return fields;
}

/** The manifest-side defaults, the lowest-precedence config layer. */
export function schemaDefaults(schema: JsonSchema | undefined): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const field of fieldDescriptors(schema)) {
    if (field.default !== undefined) defaults[field.key] = field.default;
  }
  return defaults;
}

export interface CoercionResult {
  values: Record<string, unknown>;
  errors: string[];
}

/**
 * Validate and coerce submitted values against the schema. Unknown keys are dropped so a stale
 * form cannot smuggle settings a plugin does not declare, and bad values are reported rather
 * than silently stored.
 */
export function coerceValues(schema: JsonSchema | undefined, input: Record<string, unknown>): CoercionResult {
  const fields = fieldDescriptors(schema);
  const byKey = new Map(fields.map(f => [f.key, f]));
  const values: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const [key, raw] of Object.entries(input)) {
    const field = byKey.get(key);
    if (!field) continue; // not part of this harness's schema
    if (raw === '' || raw === undefined || raw === null) continue; // blank means "unset"

    switch (field.type) {
      case 'boolean': {
        if (typeof raw === 'boolean') values[key] = raw;
        else if (raw === 'true' || raw === '1') values[key] = true;
        else if (raw === 'false' || raw === '0') values[key] = false;
        else errors.push(`${field.title} must be true or false`);
        break;
      }
      case 'number': {
        const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
        if (Number.isFinite(num)) values[key] = num;
        else errors.push(`${field.title} must be a number`);
        break;
      }
      case 'enum': {
        const text = String(raw);
        if (field.options?.includes(text)) values[key] = text;
        else errors.push(`${field.title} must be one of: ${(field.options ?? []).join(', ')}`);
        break;
      }
      default: {
        values[key] = String(raw);
        break;
      }
    }
  }

  for (const field of fields) {
    if (field.required && !(field.key in values)) errors.push(`${field.title} is required`);
  }

  return { values, errors };
}

/** `maxTurns` -> `MAX_TURNS`. The env suffix for a config key. */
export function envKeyFor(harnessId: string, key: string): string {
  const prefix = `AGENT_BRIDGE_${harnessId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}__`;
  return prefix + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/**
 * Environment overrides for one harness, using the convention the contract documents:
 * `AGENT_BRIDGE_<HARNESS_ID>__<KEY>`, e.g. `AGENT_BRIDGE_CMD__MODEL`. These sit above the
 * dashboard's saved values, so CI or a container can pin a setting regardless of the UI.
 */
export function envOverrides(
  harnessId: string,
  schema: JsonSchema | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};

  for (const field of fieldDescriptors(schema)) {
    const raw = env[envKeyFor(harnessId, field.key)];
    if (raw === undefined || raw.trim() === '') continue;

    if (field.type === 'boolean') overrides[field.key] = raw.trim() === 'true' || raw.trim() === '1';
    else if (field.type === 'number') {
      const num = Number(raw);
      if (Number.isFinite(num)) overrides[field.key] = num;
    } else overrides[field.key] = raw.trim();
  }

  return overrides;
}
