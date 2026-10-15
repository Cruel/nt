import { z } from 'zod';
import {
  readNativeOperation,
  nativeOperationCatalog,
  type NativeOperationId,
  type NativeOperationRegistration,
} from '../../src/shared/project-schema/native-schema-operations';
import { generateCppTypes } from './types';

export type JsonSchema = Record<string, unknown>;
export type NativeOperation = NativeOperationRegistration & { value?: unknown };
export interface NativeNode {
  type: string;
  children: Record<string, string>;
  operations: NativeOperation[];
  steps: ({ operation: NativeOperation } | { validation: JsonSchema })[];
  discriminator?: string;
  values?: unknown[];
  validation?: JsonSchema;
}
export interface NativeContracts {
  schemas: Record<string, JsonSchema>;
  nodes: Record<string, NativeNode>;
  roots: Record<string, string>;
  operations: NativeOperationRegistration[];
  types: string;
}

const structuralChecks = new Set([
  'less_than',
  'greater_than',
  'multiple_of',
  'number_format',
  'min_length',
  'max_length',
  'length_equals',
  'string_format',
  'min_size',
  'max_size',
  'size_equals',
]);

export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, nested]) => [key, sort(nested)]),
      );
    return item;
  };
  return (
    JSON.stringify(sort(value), null, 2).replace(
      /[\u007f-\uffff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ) + '\n'
  );
}

function assertJsonDefault(value: unknown, path: string): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonDefault(entry, `${path}/${index}`));
    return;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, entry] of Object.entries(value)) assertJsonDefault(entry, `${path}/${key}`);
    return;
  }
  throw new Error(`Unsupported non-JSON default at ${path}`);
}

export function generateNativeContracts(
  sources: Readonly<Record<string, z.ZodType>>,
): NativeContracts {
  if (JSON.stringify(z.core.version) !== JSON.stringify({ major: 4, minor: 4, patch: 3 }))
    throw new Error(
      'Review the native schema visitor before changing the pinned Zod 4.4.3 contract.',
    );
  const nodes: NativeContracts['nodes'] = {};
  const roots: NativeContracts['roots'] = {};
  const schemas: NativeContracts['schemas'] = {};
  const operations = new Map<string, NativeOperationRegistration>();
  const seen = new Map<z.core.$ZodType, string>();

  function visit(schema: z.core.$ZodType, path: string): string {
    const prior = seen.get(schema);
    if (prior) return prior;
    const id = `n${seen.size}`;
    seen.set(schema, id);
    // The documented Zod Core visitor contract is used only for the semantic audit/graph.
    // Structural constraints are always exported by the public toJSONSchema API below.
    const def = (schema as z.core.$ZodTypes)._zod.def;
    const auditFormat = (definition: object) => {
      if (!('format' in definition)) return;
      if (typeof definition.format !== 'string' || !['regex', 'uuid'].includes(definition.format))
        throw new Error(`Unsupported string format at ${path}`);
      if (
        'pattern' in definition &&
        definition.pattern instanceof RegExp &&
        /[gimsvy]/.test(definition.pattern.flags)
      )
        throw new Error(`Unsupported regular-expression flags at ${path}`);
    };
    if (def.type === 'string') auditFormat(def);
    const node: NativeNode = { type: def.type, children: {}, operations: [], steps: [] };
    nodes[id] = node;
    const child = (key: string, value: z.core.$ZodType) => {
      node.children[key] = visit(value, `${path}/${key}`);
    };
    switch (def.type) {
      case 'object':
        for (const key of Object.keys(def.shape).sort()) child(key, def.shape[key]!);
        if (def.catchall && def.catchall._zod.def.type !== 'never')
          child('$catchall', def.catchall);
        break;
      case 'array':
        child('element', def.element);
        break;
      case 'union':
        def.options.forEach((option, index) => child(String(index), option));
        if ('discriminator' in def) node.discriminator = String(def.discriminator);
        break;
      case 'lazy':
        child('inner', (schema as z.ZodLazy).unwrap());
        break;
      case 'optional':
      case 'nullable':
        child('inner', def.innerType);
        break;
      case 'default': {
        const value = def.defaultValue;
        assertJsonDefault(value, path);
        if (value === undefined || canonicalJson(value) !== canonicalJson(def.defaultValue))
          throw new Error(`Unsupported dynamic default at ${path}`);
        const operation = { id: 'value.default', kind: 'overwrite' as const, value };
        node.operations.push(operation);
        operations.set(operation.id, { id: operation.id, kind: operation.kind });
        child('inner', def.innerType);
        break;
      }
      case 'record':
        child('key', def.keyType);
        child('value', def.valueType);
        break;
      case 'tuple':
        def.items.forEach((item, index) => child(String(index), item));
        if (def.rest) child('rest', def.rest);
        break;
      case 'pipe':
        child('in', def.in);
        child('out', def.out);
        break;
      case 'transform': {
        const registration = readNativeOperation(schema);
        if (!registration) throw new Error(`Unregistered transform at ${path}`);
        node.operations.push(registration);
        operations.set(registration.id, registration);
        break;
      }
      case 'literal':
        node.values = def.values;
        break;
      case 'enum':
        node.values = Object.values(def.entries);
        break;
      case 'string':
      case 'number':
      case 'boolean':
      case 'null':
      case 'never':
      case 'unknown':
      case 'any':
        break;
      default:
        throw new Error(`Unsupported Zod type '${def.type}' at ${path}`);
    }
    for (const check of def.checks ?? []) {
      if (def.type === 'string') auditFormat(check._zod.def);
      const registration = readNativeOperation(check);
      if (registration) {
        node.operations.push(registration);
        const previous = operations.get(registration.id);
        if (previous && previous.kind !== registration.kind)
          throw new Error(`Conflicting operation ${registration.id}`);
        operations.set(registration.id, registration);
        node.steps.push({ operation: registration });
      } else if (!structuralChecks.has(check._zod.def.check)) {
        throw new Error(`Unregistered ${check._zod.def.check} at ${path}`);
      } else if (
        def.type === 'string' &&
        ['min_length', 'max_length', 'length_equals'].includes(check._zod.def.check)
      ) {
        const validation = z.toJSONSchema(z.string().check(check as z.core.$ZodCheck<string>));
        const operation = {
          id: 'string.utf16-length',
          kind: 'refinement' as const,
          value: { minimum: validation.minLength ?? 0, maximum: validation.maxLength ?? null },
        };
        node.operations.push(operation);
        node.steps.push({ operation });
        operations.set(operation.id, { id: operation.id, kind: operation.kind });
      } else {
        const base =
          def.type === 'string'
            ? z.string()
            : def.type === 'number'
              ? z.number()
              : def.type === 'array'
                ? z.array(z.any())
                : null;
        if (!base)
          throw new Error(`Unsupported structural check ${check._zod.def.check} at ${path}`);
        node.steps.push({
          validation: z.toJSONSchema(
            (base as z.ZodType).check(check as z.core.$ZodCheck<unknown>),
            { io: 'input' },
          ),
        });
      }
    }
    if (
      [
        'string',
        'number',
        'boolean',
        'null',
        'literal',
        'enum',
        'never',
        'unknown',
        'any',
        'object',
        'array',
      ].includes(def.type)
    ) {
      let local: z.core.$ZodType = z.clone(schema, { ...def, checks: [] });
      if (def.type === 'object')
        local = z.clone(schema as z.ZodObject, {
          ...def,
          checks: [],
          shape: Object.fromEntries(Object.keys(def.shape).map((key) => [key, z.any().optional()])),
          catchall: def.catchall?._zod.def.type === 'never' ? z.never() : z.any(),
        });
      if (def.type === 'array')
        local = z.clone(schema as z.ZodArray, { ...def, checks: [], element: z.any() });
      node.validation = z.toJSONSchema(local, { io: 'input' });
    }
    if (def.type === 'record')
      node.validation = z.toJSONSchema(z.record(def.keyType as z.core.$ZodRecordKey, z.any()), {
        io: 'input',
        override: ({ jsonSchema }) => {
          if (jsonSchema.type === 'string') {
            delete jsonSchema.minLength;
            delete jsonSchema.maxLength;
          }
        },
      });
    return id;
  }

  for (const name of Object.keys(sources).sort()) roots[name] = visit(sources[name]!, name);
  for (const name of Object.keys(sources).sort()) {
    schemas[name] = z.toJSONSchema(sources[name]!, {
      io: 'input',
      reused: 'ref',
      unrepresentable: 'throw',
      override: ({ zodSchema, jsonSchema }) => {
        const id = seen.get(zodSchema);
        if (id) jsonSchema['x-native-node'] = id;
        if (
          jsonSchema.type === 'string' &&
          (jsonSchema.minLength !== undefined || jsonSchema.maxLength !== undefined)
        ) {
          jsonSchema['x-native-utf16-length'] = {
            minimum: jsonSchema.minLength ?? 0,
            maximum: jsonSchema.maxLength ?? null,
          };
          delete jsonSchema.minLength;
          delete jsonSchema.maxLength;
        }
        if (zodSchema instanceof z.ZodTuple) {
          jsonSchema.minItems = zodSchema.def.items.reduce(
            (count, item, index) => (z.safeParse(item, undefined).success ? count : index + 1),
            0,
          );
          if (!zodSchema.def.rest) {
            jsonSchema.maxItems = zodSchema.def.items.length;
            jsonSchema.items = false;
          }
        }
      },
    });
  }
  for (const { id, kind } of operations.values()) {
    if (nativeOperationCatalog[id as NativeOperationId] !== kind)
      throw new Error(`Unregistered native ${kind}: ${id}`);
  }
  return {
    schemas,
    nodes,
    roots,
    operations: [...operations.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    types: generateCppTypes(schemas),
  };
}
