import {
  Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Node,
  type Pair,
} from 'yaml';
import { authoringRecordSchemas } from '../project-schema/authoring-records';

/** Restricted YAML is a source spelling of the existing strict Variable record, not a new model. */
export const variableYamlSourceSchema = authoringRecordSchemas.variables.extend({
  data: authoringRecordSchemas.variables.shape.data
    .omit({ kind: true })
    .meta(authoringRecordSchemas.variables.shape.data.meta() ?? {}),
});

function inspectNode(node: Node | null | undefined, mappingKey = false): void {
  if (!node) return;
  if (isAlias(node) || node.anchor || (node.tag && node.tag !== 'tag:yaml.org,2002:str'))
    throw new Error('YAML aliases, anchors and explicit tags are not supported.');
  if (isMap(node)) {
    for (const pair of node.items as Pair[]) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
        throw new Error('YAML mapping keys must be strings. Quote numeric keys.');
      inspectNode(pair.key, true);
      if (pair.key.value === '<<' || pair.key.value === '__proto__')
        throw new Error('YAML merge and prototype keys are not supported.');
      inspectNode(pair.value as Node | null);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) inspectNode(item as Node | null);
  } else if (isScalar(node)) {
    if (mappingKey && node.type === 'PLAIN' && typeof node.value !== 'string')
      throw new Error('YAML mapping keys must be strings.');
    if (node.type !== 'PLAIN') return;
    const spelling = node.source;
    if (typeof spelling !== 'string') return;
    if (
      /^(yes|no|on|off|y|n|~|true|false|null)$/iu.test(spelling) &&
      !['true', 'false', 'null'].includes(spelling)
    )
      throw new Error(`Ambiguous YAML scalar '${spelling}' must be quoted.`);
    if (
      typeof node.value === 'number' &&
      !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(spelling)
    )
      throw new Error(`YAML numeric scalar '${spelling}' is not a JSON number.`);
    if (typeof node.value === 'string' && /^(?:[-+]?0[0-9]+|\.inf|\.nan)$/iu.test(spelling))
      throw new Error(`Ambiguous YAML scalar '${spelling}' must be quoted.`);
  }
}

export function parseVariableYamlDocument(text: string) {
  const docs = parseAllDocuments(text, { uniqueKeys: true, version: '1.2', strict: true });
  if (docs.length !== 1 || docs[0]!.errors.length > 0)
    throw new Error(docs[0]?.errors[0]?.message ?? 'Expected one valid YAML document.');
  const doc = docs[0]!;
  inspectNode(doc.contents);
  return doc;
}

export function decodeVariableYaml(text: string): unknown {
  const value = parseVariableYamlDocument(text).toJS();
  return authoringRecordSchemas.variables.parse(variableYamlSourceSchema.parse(value));
}

function sparseVariable(value: unknown): Record<string, unknown> {
  const parsed = authoringRecordSchemas.variables.parse(value);
  const data: Record<string, unknown> = { type: parsed.data.type, value: parsed.data.value };
  if (parsed.data.nullable) data.nullable = true;
  if (parsed.data.scope !== 'global') data.scope = parsed.data.scope;
  if (parsed.data.enumValues !== undefined) data.enumValues = parsed.data.enumValues;
  return {
    id: parsed.id,
    label: parsed.label,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    data,
  };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Update only changed source fields so unrelated nodes retain attached comments and order. */
export function encodeVariableYaml(value: unknown, previousText?: string): string {
  const target = sparseVariable(value);
  if (previousText === undefined) {
    return new Document(target).toString({ indent: 2, lineWidth: 0 });
  }
  const doc = parseVariableYamlDocument(previousText);
  const previous = doc.toJS() as Record<string, unknown>;
  // An existing explicit default is intentional: ordinary saves never strip it.
  for (const key of ['nullable', 'scope'] as const) {
    const oldData = previous.data as Record<string, unknown> | undefined;
    if (oldData && Object.hasOwn(oldData, key) && !(key in (target.data as object)))
      (target.data as Record<string, unknown>)[key] = key === 'nullable' ? false : 'global';
  }
  if (same(previous, target)) return previousText;
  const update = (
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    path: string[],
  ) => {
    for (const key of Object.keys(before)) if (!(key in after)) doc.deleteIn([...path, key]);
    for (const [key, next] of Object.entries(after)) {
      const old = before[key];
      if (same(old, next)) continue;
      if (
        old &&
        next &&
        typeof old === 'object' &&
        typeof next === 'object' &&
        !Array.isArray(old) &&
        !Array.isArray(next)
      )
        update(old as Record<string, unknown>, next as Record<string, unknown>, [...path, key]);
      else doc.setIn([...path, key], next);
    }
  };
  update(previous, target, []);
  return doc.toString({ indent: 2, lineWidth: 0 });
}
