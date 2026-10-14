import { layoutDataSchema } from '../project-schema/authoring-layouts';
import { decodeStructuredYaml, encodeStructuredYaml } from './structured-yaml-source';

type Dictionary = Record<string, unknown>;
const object = (value: unknown): value is Dictionary =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

// These defaults come from the normalized Layout schema, not an editor starter.
// The three source selectors are always explicit: they own separate companion files.
const defaults = Object.fromEntries(
  Object.entries(layoutDataSchema.parse({})).filter(
    ([key]) => !['rml', 'rcss', 'lua'].includes(key),
  ),
) as Dictionary;

export function decodeLayoutYaml(text: string): unknown {
  const record = decodeStructuredYaml(text);
  if (!object(record) || !object(record.data)) return record;
  return { ...record, data: { ...defaults, ...record.data } };
}

export function encodeLayoutYaml(value: unknown, previousText?: string): string {
  if (!object(value) || !object(value.data)) return encodeStructuredYaml(value, previousText);
  const previous = previousText === undefined ? undefined : decodeStructuredYaml(previousText);
  const priorData = object(previous) && object(previous.data) ? previous.data : {};
  const data: Dictionary = {};
  for (const [key, field] of Object.entries(value.data)) {
    if (
      Object.hasOwn(defaults, key) &&
      same(field, defaults[key]) &&
      !Object.hasOwn(priorData, key)
    )
      continue;
    data[key] = field;
  }
  return encodeStructuredYaml({ ...value, data }, previousText);
}
