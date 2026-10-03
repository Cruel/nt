import { z } from 'zod';
import { readSchemaDocumentation, type SchemaDocumentation } from './schema-documentation';
import { schemaReferenceJson } from './schema-reference-json';

export interface SchemaReferenceNode {
  readonly kind: 'value' | 'object' | 'array' | 'tuple' | 'union' | 'intersection' | 'reference';
  readonly type?: string;
  readonly fields?: readonly SchemaReferenceField[];
  readonly elements?: readonly SchemaReferenceNode[];
  readonly additional?: SchemaReferenceNode | boolean;
  readonly key?: SchemaReferenceNode;
  readonly constraints: readonly string[];
  readonly defaultValue?: unknown;
  readonly documentation?: SchemaDocumentation;
}

export interface SchemaReferenceField {
  readonly name: string;
  readonly required: boolean;
  readonly value: SchemaReferenceNode;
}

export interface SchemaReferenceModel {
  readonly name: string;
  readonly root: SchemaReferenceNode;
  readonly definitions: Readonly<Record<string, SchemaReferenceNode>>;
}

type JsonSchema = Record<string, unknown>;

const supportedKeywords = new Set([
  '$schema',
  '$id',
  '$defs',
  '$ref',
  'title',
  'description',
  'x-noveltea-documentation',
  'type',
  'const',
  'enum',
  'default',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'anyOf',
  'oneOf',
  'allOf',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);

function record(value: unknown): JsonSchema {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonSchema) : {};
}

function constraints(input: JsonSchema): string[] {
  const node = { ...input };
  if (node.type === 'integer') {
    if (typeof node.exclusiveMinimum === 'number') {
      node.minimum = Math.max(
        typeof node.minimum === 'number' ? node.minimum : -Infinity,
        Math.floor(node.exclusiveMinimum) + 1,
      );
      delete node.exclusiveMinimum;
    }
    if (typeof node.exclusiveMaximum === 'number') {
      node.maximum = Math.min(
        typeof node.maximum === 'number' ? node.maximum : Infinity,
        Math.ceil(node.exclusiveMaximum) - 1,
      );
      delete node.exclusiveMaximum;
    }
  }
  const labels: Record<string, string> = {
    minimum: '>=',
    maximum: '<=',
    exclusiveMinimum: '>',
    exclusiveMaximum: '<',
    multipleOf: 'multiple of',
    minLength: 'length >=',
    maxLength: 'length <=',
    minItems: 'items >=',
    maxItems: 'items <=',
    minProperties: 'keys >=',
    maxProperties: 'keys <=',
  };
  const result = Object.entries(labels).flatMap(([key, label]) =>
    typeof node[key] === 'number' ? [`${label} ${node[key]}`] : [],
  );
  if (typeof node.pattern === 'string') result.push(`pattern ${JSON.stringify(node.pattern)}`);
  if (typeof node.format === 'string') result.push(`format ${node.format}`);
  if (node.uniqueItems === true) result.push('unique items');
  return result;
}

export function normalizeSchemaReference(schema: z.ZodType, name: string): SchemaReferenceModel {
  const json = schemaReferenceJson(schema, 'ref');
  const definitions: Record<string, SchemaReferenceNode> = {};
  const references = new Map<string, string>([['#', name]]);
  const names = new Set([name]);
  function resolve(pointer: string): unknown {
    if (pointer === '#') return json;
    if (!pointer.startsWith('#/')) throw new Error(`Unsupported schema reference '${pointer}'.`);
    return pointer
      .slice(2)
      .split('/')
      .reduce<unknown>((value, key) => {
        const decoded = key.replaceAll('~1', '/').replaceAll('~0', '~');
        if (!Object.hasOwn(record(value), decoded))
          throw new Error(`Missing schema reference '${pointer}'.`);
        return record(value)[decoded];
      }, json);
  }
  function normalize(value: unknown, hint: string): SchemaReferenceNode {
    const node = record(value);
    for (const key of Object.keys(node)) {
      if (!supportedKeywords.has(key))
        throw new Error(
          `Unsupported schema keyword '${key}' in '${hint}'; extend the reference normalizer rather than dropping its meaning.`,
        );
    }
    const common = {
      constraints: constraints(node),
      ...(readSchemaDocumentation(node)
        ? { documentation: readSchemaDocumentation(node) }
        : typeof node.description === 'string'
          ? { documentation: { description: node.description } }
          : {}),
      ...(Object.hasOwn(node, 'default') ? { defaultValue: node.default } : {}),
    };
    if (typeof node.$ref === 'string') {
      const target = record(resolve(node.$ref));
      const { $ref: _reference, ...siblings } = node;
      if (typeof target.type === 'string' && !['object', 'array'].includes(target.type))
        return normalize({ ...target, ...siblings }, hint);
      let referenceName = references.get(node.$ref);
      if (!referenceName) {
        const base = typeof target.title === 'string' ? target.title : hint;
        const identifier =
          base
            .replace(/[^a-zA-Z0-9_$]+/g, ' ')
            .split(' ')
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join('') || 'Value';
        referenceName = identifier;
        for (let suffix = 2; names.has(referenceName); suffix++)
          referenceName = `${identifier}${suffix}`;
        names.add(referenceName);
        references.set(node.$ref, referenceName);
        definitions[referenceName] = normalize(target, referenceName);
      }
      return { ...common, kind: 'reference', type: referenceName };
    }
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      if (Array.isArray(node[key]))
        return {
          ...common,
          kind: key === 'allOf' ? 'intersection' : 'union',
          elements: node[key].map((branch, index) =>
            normalize(branch, `${hint}Variant${index + 1}`),
          ),
          constraints: [...common.constraints, ...(key === 'oneOf' ? ['exactly one variant'] : [])],
        };
    }
    if (node.type === 'object') {
      const key = node.propertyNames ? normalize(node.propertyNames, `${hint}Key`) : undefined;
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      return {
        ...common,
        kind: 'object',
        ...(key ? { key } : {}),
        fields: Object.entries(record(node.properties)).map(([key, nested]) => ({
          name: key,
          required: required.has(key),
          value: normalize(nested, key),
        })),
        additional:
          typeof node.additionalProperties === 'boolean'
            ? node.additionalProperties
            : normalize(node.additionalProperties, `${hint}Value`),
      };
    }
    if (node.type === 'array') {
      if (Array.isArray(node.prefixItems))
        return {
          ...common,
          kind: 'tuple',
          elements: node.prefixItems.map((item, index) =>
            normalize(item, `${hint}Item${index + 1}`),
          ),
          additional: node.items === false ? false : normalize(node.items, `${hint}Rest`),
        };
      return { ...common, kind: 'array', elements: [normalize(node.items, `${hint}Item`)] };
    }
    const type = Object.hasOwn(node, 'const')
      ? JSON.stringify(node.const)
      : Array.isArray(node.enum)
        ? node.enum.map((item) => JSON.stringify(item)).join(' | ')
        : Array.isArray(node.type)
          ? node.type.join(' | ')
          : typeof node.type === 'string'
            ? node.type
            : value === false
              ? 'never'
              : 'JSON value';
    return { ...common, kind: 'value', type };
  }
  const root = normalize(json, name);
  return { name, root, definitions };
}

function renderNode(node: SchemaReferenceNode, depth = 0): string {
  const indent = '  '.repeat(depth);
  let text: string;
  switch (node.kind) {
    case 'object': {
      const lines = (node.fields ?? []).map(
        (field) =>
          `${indent}  ${JSON.stringify(field.name).match(/^"[a-zA-Z_$][\w$]*"$/) ? field.name : JSON.stringify(field.name)}${field.required ? '' : '?'}: ${renderNode(field.value, depth + 1)}`,
      );
      if (node.additional && typeof node.additional !== 'boolean')
        lines.push(
          `${indent}  [key: ${node.key ? renderNode(node.key, depth + 1) : 'string'}]: ${renderNode(node.additional, depth + 1)}`,
        );
      else if (node.additional === true) lines.push(`${indent}  [key: string]: JSON value`);
      text = `{${lines.length ? `\n${lines.join('\n')}\n${indent}` : ''}}${node.additional === false ? ' (no extra keys)' : ''}`;
      break;
    }
    case 'array': {
      const item = renderNode(node.elements![0]!, depth);
      text = /[ |]/.test(item) ? `(${item})[]` : `${item}[]`;
      break;
    }
    case 'tuple': {
      const items = node.elements!.map((item) => renderNode(item, depth));
      if (node.additional && typeof node.additional !== 'boolean')
        items.push(`...(${renderNode(node.additional, depth)})[]`);
      text = `[${items.join(', ')}]`;
      break;
    }
    case 'union':
    case 'intersection':
      text = node
        .elements!.map((element) => {
          const branch = renderNode(element, depth);
          return node.kind === 'intersection' && element.kind === 'union' ? `(${branch})` : branch;
        })
        .join(node.kind === 'union' ? ' | ' : ' & ');
      break;
    default:
      text = node.type!;
  }
  if (node.constraints.length) {
    if (node.kind === 'union' || node.kind === 'intersection') text = `(${text})`;
    text += ` ${node.constraints.join(' ')}`;
  }
  if (Object.hasOwn(node, 'defaultValue')) text += ` = ${JSON.stringify(node.defaultValue)}`;
  return text;
}

export function schemaDocumentationEntries(
  model: SchemaReferenceModel,
): readonly { path: string; documentation: SchemaDocumentation }[] {
  const entries: { path: string; documentation: SchemaDocumentation }[] = [];
  function visit(node: SchemaReferenceNode, path: string): void {
    if (node.documentation && Object.keys(node.documentation).some((key) => key !== 'name'))
      entries.push({ path, documentation: node.documentation });
    for (const field of node.fields ?? []) visit(field.value, `${path}.${field.name}`);
    for (const [index, element] of (node.elements ?? []).entries())
      visit(element, `${path}[${node.kind === 'array' ? 'item' : index + 1}]`);
    if (node.additional && typeof node.additional !== 'boolean')
      visit(node.additional, `${path}[key]`);
  }
  visit(model.root, model.name);
  for (const [name, node] of Object.entries(model.definitions)) visit(node, name);
  return entries;
}

export function renderSchemaNotation(model: SchemaReferenceModel): string {
  return Object.entries({ [model.name]: model.root, ...model.definitions })
    .map(([name, node]) => `${name} = ${renderNode(node)}`)
    .join('\n\n');
}
