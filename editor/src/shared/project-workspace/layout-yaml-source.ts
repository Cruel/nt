import { layoutDataSchema } from '../project-schema/authoring-layouts';
import { authoringRecordSchemas } from '../project-schema/authoring-records';
import { decodeStructuredYaml, encodeStructuredYaml } from './structured-yaml-source';
import { annotatedYamlPaths } from './yaml-comment-impact';
import { convertLayoutYamlReferences } from './sparse-record-yaml-source';

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
  const record = convertLayoutYamlReferences(decodeStructuredYaml(text), 'read');
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
      (!Object.hasOwn(priorData, key) || !same(priorData[key], field))
    )
      continue;
    data[key] = field;
  }
  return encodeStructuredYaml(
    convertLayoutYamlReferences({ ...value, data }, 'write'),
    previousText,
  );
}

function layoutEffectiveProof(text: string): unknown {
  const source = decodeLayoutYaml(text);
  if (!object(source) || !object(source.data)) throw new Error('Invalid Layout YAML source.');
  const record = structuredClone(source);
  const data = record.data as Dictionary;
  for (const channel of ['rml', 'rcss', 'lua'] as const) {
    const selector = data[channel];
    if (!object(selector)) throw new Error(`Invalid Layout ${channel} selector.`);
    if (selector.sourceMode === 'file' || (channel === 'lua' && selector.sourceMode === 'none')) {
      if (Object.keys(selector).join(',') !== 'sourceMode')
        throw new Error(`Invalid Layout ${channel} file selector.`);
      data[channel] =
        channel === 'lua'
          ? { sourceMode: 'inline', sourceText: '' }
          : { sourceMode: 'inline', sourceText: '', sourceAsset: null };
    } else if (
      selector.sourceMode === 'asset' &&
      channel !== 'lua' &&
      Object.keys(selector).sort().join(',') === 'sourceAsset,sourceMode'
    ) {
      data[channel] = selector;
    } else {
      throw new Error(`Unsupported Layout ${channel} selector.`);
    }
  }
  return authoringRecordSchemas.layouts.parse(record);
}

/** Explicit CLI-only compaction of Layout's schema-declared source defaults. */
export function stripLayoutYamlDefaults(text: string): string {
  const before = layoutEffectiveProof(text);
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
  const after = layoutEffectiveProof(result);
  if (!same(before, after)) throw new Error('Layout compaction changed normalized record data.');
  return result;
}
