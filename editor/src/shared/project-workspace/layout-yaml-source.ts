import { layoutDataSchema } from '../project-schema/authoring-layouts';
import { authoringRecordSchemas } from '../project-schema/authoring-records';
import { decodeStructuredYaml, encodeStructuredYaml } from './structured-yaml-source';
import { annotatedYamlPaths } from './yaml-comment-impact';

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

/** Explicit CLI-only compaction of Layout's schema-declared source defaults. */
export function stripLayoutYamlDefaults(text: string): string {
  const before = authoringRecordSchemas.layouts.parse(decodeLayoutYaml(text));
  const source = decodeStructuredYaml(text);
  if (!object(source) || !object(source.data)) throw new Error('Invalid Layout YAML source.');
  const annotated = annotatedYamlPaths(text);
  const data = { ...source.data };
  for (const [key, fallback] of Object.entries(defaults)) {
    const path = `data.${key}`;
    if (
      Object.hasOwn(data, key) &&
      same(data[key], fallback) &&
      ![...annotated].some((note) => note === path || note.startsWith(`${path}.`))
    )
      delete data[key];
  }
  const result = encodeStructuredYaml({ ...source, data }, text);
  const after = authoringRecordSchemas.layouts.parse(decodeLayoutYaml(result));
  if (!same(before, after)) throw new Error('Layout compaction changed normalized record data.');
  return result;
}
