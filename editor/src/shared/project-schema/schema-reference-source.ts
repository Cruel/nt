import type { z } from 'zod';
import {
  sparseRecordYamlSourceDefaults,
  type SparseRecordFamily,
} from '../project-workspace/sparse-record-yaml-source';
import { layoutDataSchema } from './authoring-layouts';
import { testExpectationTypeValues, testInputTypeValues } from './authoring-tests';
import {
  testSourceComparisonOperators,
  testSourceExpectationPayloads,
  testSourceStepPayloads,
  testSourceValueExpectations,
} from './test-source-intent';
import { schemaReferenceJson } from './schema-reference-json';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function pointer(root: JsonObject, ref: string): JsonObject | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const result = ref
    .slice(2)
    .split('/')
    .reduce<unknown>(
      (value, segment) =>
        object(value) ? value[segment.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined,
      root,
    );
  return object(result) ? result : undefined;
}

function referenceCollection(value: JsonObject, root: JsonObject): JsonObject | undefined {
  const resolved = typeof value.$ref === 'string' ? (pointer(root, value.$ref) ?? value) : value;
  const fields = object(resolved.properties) ? resolved.properties : undefined;
  const nested = fields?.$ref;
  const ref =
    object(nested) && typeof nested.$ref === 'string'
      ? (pointer(root, nested.$ref) ?? nested)
      : nested;
  if (!object(ref) || !object(ref.properties)) return undefined;
  const collection = ref.properties.collection;
  const id = ref.properties.id;
  if (!object(collection) || typeof collection.const !== 'string' || !object(id)) return undefined;
  // Only the collection-qualified reference has a bare source spelling. Registry
  // references and owner-qualified/polymorphic references remain structured.
  if (!fields || Object.keys(fields).some((key) => key !== '$ref')) return undefined;
  return id;
}

function conditionUnion(value: JsonObject): boolean {
  if (!Array.isArray(value.oneOf)) return false;
  const kinds = new Set(
    value.oneOf.flatMap((branch) => {
      const properties =
        object(branch) && object(branch.properties) ? branch.properties : undefined;
      const kind = properties?.kind;
      return object(kind) && typeof kind.const === 'string' ? [kind.const] : [];
    }),
  );
  return kinds.has('always') && kinds.has('all') && kinds.has('not');
}

/** Ref-aware access to Zod's shared $defs, without mutating normalized schemas. */
function sourceObject(root: JsonObject, value: unknown): JsonObject | undefined {
  if (!object(value)) return undefined;
  return typeof value.$ref === 'string' ? (pointer(root, value.$ref) ?? value) : value;
}

const requireFields = (fields: readonly string[]) => ({ required: [...fields] });
function authoredTestRequirements(root: JsonObject): void {
  const data = sourceObject(root, object(root.properties) ? root.properties.data : undefined);
  const fields = object(data?.properties) ? data.properties : undefined;
  const steps = sourceObject(root, fields?.steps);
  const step = sourceObject(root, steps?.items);
  const expectations = sourceObject(root, fields?.finalExpectations);
  const expectation = sourceObject(root, expectations?.items);
  if (!object(step) || !object(expectation))
    throw new Error('Generated Test source schema lost its authored Step/Expectation shapes.');

  step.required = [...new Set([...(Array.isArray(step.required) ? step.required : []), 'input'])];
  const input = object(step.properties) ? step.properties.input : undefined;
  if (object(input)) delete input.default;
  for (const { key, fields: required } of Object.values(testSourceStepPayloads)) {
    const payload = sourceObject(root, object(step.properties) ? step.properties[key] : undefined);
    if (!payload) continue;
    delete payload.default;
    if (!object(payload.properties)) continue;
    for (const name of required) {
      const field = sourceObject(root, payload.properties[name]);
      if (field) delete field.default;
    }
  }
  step.allOf = [
    ...(Array.isArray(step.allOf) ? step.allOf : []),
    {
      anyOf: testInputTypeValues.map((kind) => {
        const payload = testSourceStepPayloads[kind];
        return {
          properties: {
            input: { const: kind },
            ...(payload ? { [payload.key]: requireFields(payload.fields) } : {}),
          },
          required: payload ? ['input', payload.key] : ['input'],
          ...(kind === 'ui-click'
            ? {
                allOf: [
                  {
                    anyOf: [
                      { properties: { uiClick: requireFields(['documentId']) } },
                      { properties: { uiClick: requireFields(['mountInstanceId']) } },
                    ],
                  },
                ],
              }
            : {}),
        };
      }),
    },
  ];
  step['x-noveltea-source-intent'] =
    'An authored Step requires input. Active input payloads and their identifying fields are required; ui-click must specify a documentId or mountInstanceId.';

  expectation.allOf = [
    ...(Array.isArray(expectation.allOf) ? expectation.allOf : []),
    {
      anyOf: testExpectationTypeValues.map((type) => {
        const payload = testSourceExpectationPayloads[type];
        const needsValue = testSourceValueExpectations.includes(
          type as (typeof testSourceValueExpectations)[number],
        );
        const valueWhen = needsValue
          ? {
              anyOf: [
                { properties: { operator: { enum: ['present', 'absent'] } } },
                {
                  properties: {
                    operator: { enum: [...testSourceComparisonOperators] },
                    [payload.key]: requireFields(['value']),
                  },
                },
              ],
            }
          : {};
        const extra: JsonObject[] = [];
        if (type === 'property')
          extra.push({
            anyOf: [
              { properties: { property: { properties: { scope: { const: 'global' } } } } },
              { properties: { property: requireFields(['ownerId']) } },
            ],
          });
        if (type === 'ui-element')
          extra.push({
            anyOf: [
              { properties: { uiElement: requireFields(['documentId']) } },
              { properties: { uiElement: requireFields(['mountInstanceId']) } },
            ],
          });
        if (type === 'layout' || type === 'ui-element')
          extra.push({
            anyOf: [
              { properties: { operator: { enum: ['present', 'absent'] } } },
              {
                properties: {
                  [payload.key]: {
                    properties: {
                      field: { const: type === 'layout' ? 'mounted' : 'present' },
                    },
                  },
                },
              },
              { properties: { [payload.key]: requireFields(['value']) } },
            ],
          });
        if (type === 'location') {
          extra.push({
            anyOf: [
              {
                properties: { location: { properties: { locationKind: { enum: ['unplaced'] } } } },
              },
              {
                properties: {
                  location: {
                    properties: { locationKind: { const: 'room' } },
                    required: ['roomId'],
                  },
                },
              },
              {
                properties: {
                  location: {
                    properties: { locationKind: { const: 'inventory' } },
                    required: ['inventoryOwnerKind', 'inventoryId'],
                  },
                },
                allOf: [
                  {
                    anyOf: [
                      {
                        properties: {
                          location: { properties: { inventoryOwnerKind: { const: 'project' } } },
                        },
                      },
                      { properties: { location: requireFields(['inventoryOwnerId']) } },
                    ],
                  },
                ],
              },
            ],
          });
        }
        return {
          properties: { type: { const: type }, [payload.key]: requireFields(payload.fields) },
          required: ['type', 'operator', payload.key],
          ...(Object.keys(valueWhen).length || extra.length
            ? { allOf: [...(Object.keys(valueWhen).length ? [valueWhen] : []), ...extra] }
            : {}),
        };
      }),
    },
  ];
  expectation['x-noveltea-source-intent'] =
    'An authored Expectation requires type, operator, and the matching active payload with its identifying fields. Comparisons require explicit values; owner/location/UI addressing depends on the selected mode.';
  // The Step references this same Expectation schema; validate the shared identity.
  const nested = sourceObject(
    root,
    object(step.properties) ? step.properties.expectations : undefined,
  );
  const nestedExpectation = sourceObject(root, nested?.items);
  if (nestedExpectation !== expectation)
    throw new Error(
      'Generated Test Step expectations no longer share the final expectation schema.',
    );
  for (const { key, fields: required } of Object.values(testSourceExpectationPayloads)) {
    const payload = sourceObject(
      root,
      object(expectation.properties) ? expectation.properties[key] : undefined,
    );
    if (!payload) continue;
    delete payload.default;
    if (!object(payload.properties)) continue;
    for (const name of required) {
      const field = sourceObject(root, payload.properties[name]);
      if (field) delete field.default;
    }
  }
}

function authoredCharacterRequirements(root: JsonObject): void {
  const data = sourceObject(root, object(root.properties) ? root.properties.data : undefined);
  if (!data || !object(data.properties))
    throw new Error('Generated Character source schema lost its Character data shape.');
  data.required = [
    ...new Set([...(Array.isArray(data.required) ? data.required : []), 'defaults']),
  ];
  const defaults = sourceObject(root, data.properties.defaults);
  if (!defaults || !object(defaults.properties))
    throw new Error('Generated Character source schema lost its defaults shape.');
  delete defaults.default;
  defaults.required = [
    ...new Set([
      ...(Array.isArray(defaults.required) ? defaults.required : []),
      'profileId',
      'expressionId',
    ]),
  ];
}

export interface SourceReferenceOptions {
  readonly family?: SparseRecordFamily | 'layouts';
  readonly sharedType?: boolean;
}

/**
 * Project the same Zod input contract through the workspace YAML codec's source
 * omissions and reference spelling. This is documentation, never an admission
 * path; the workspace codec and normalized Zod validators remain authoritative.
 */
export function sourceSchemaReferenceJson(
  schema: z.ZodType,
  options: SourceReferenceOptions = {},
): JsonObject {
  const root = schemaReferenceJson(schema, 'ref') as JsonObject;
  const family = options.family;
  const defaults =
    family === 'layouts'
      ? Object.fromEntries(
          Object.entries(layoutDataSchema.parse({}))
            .filter(([key]) => !['rml', 'rcss', 'lua'].includes(key))
            .map(([key, value]) => [`data.${key}`, value]),
        )
      : family
        ? (sparseRecordYamlSourceDefaults(family) ?? {})
        : {};
  const defaultAt = (path: readonly string[]): { present: boolean; value?: unknown } => {
    for (let length = path.length; length > 0; length--) {
      const prefix = path.slice(0, length).join('.');
      if (!Object.hasOwn(defaults, prefix)) continue;
      let value: unknown = defaults[prefix];
      for (const segment of path.slice(length)) {
        if (!object(value) || !Object.hasOwn(value, segment)) return { present: false };
        value = value[segment];
      }
      return { present: true, value };
    }
    return { present: false };
  };
  const hasChildren = (path: readonly string[]): boolean => {
    const prefix = `${path.join('.')}.`;
    return Object.keys(defaults).some((key) => key.startsWith(prefix));
  };
  const sourceDefault = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sourceDefault);
    if (!object(value)) return value;
    if (Object.keys(value).length === 1 && value.kind === 'always') return 'always';
    if (
      Object.keys(value).length === 1 &&
      object(value.$ref) &&
      typeof value.$ref.collection === 'string' &&
      typeof value.$ref.id === 'string'
    )
      return value.$ref.id;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, sourceDefault(child)]),
    );
  };

  function visit(value: unknown, path: string[], active = new Set<string>()): unknown {
    if (!object(value)) return value;
    if ((family || options.sharedType) && referenceCollection(value, root)) {
      const id = referenceCollection(value, root)!;
      return visit(id, path, active);
    }
    if (typeof value.$ref === 'string' && hasChildren(path) && !active.has(value.$ref)) {
      const target = pointer(root, value.$ref);
      if (target) {
        const { $ref: _ref, ...siblings } = value;
        return visit({ ...target, ...siblings }, path, new Set([...active, value.$ref]));
      }
    }
    const result = { ...value };
    if (object(value.properties)) {
      const properties: JsonObject = {};
      const required = new Set(Array.isArray(value.required) ? value.required : []);
      for (const [key, field] of Object.entries(value.properties)) {
        if (family && path.join('.') === 'data' && key === 'kind' && family !== 'assets') {
          required.delete(key);
          continue;
        }
        const childPath = [...path, key];
        let child = visit(field, childPath, active);
        const fallback = defaultAt(childPath);
        if (fallback.present) {
          required.delete(key);
          if (object(child)) child = { ...child, default: sourceDefault(fallback.value) };
        }
        properties[key] = child;
      }
      result.properties = properties;
      if (Array.isArray(value.required)) result.required = [...required];
    }
    for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const)
      if (Array.isArray(value[key]))
        result[key] = value[key].map((item) => visit(item, path, active));
    if (object(value.items)) result.items = visit(value.items, [...path, '*'], active);
    if (object(value.additionalProperties))
      result.additionalProperties = visit(value.additionalProperties, [...path, '*'], active);
    if (object(value.$defs))
      result.$defs = Object.fromEntries(
        Object.entries(value.$defs).map(([key, item]) => [key, visit(item, [], new Set())]),
      );
    if ((family || options.sharedType) && conditionUnion(value)) {
      // The source reader also accepts the scalar spelling of the always variant.
      result.anyOf = [{ const: 'always', type: 'string' }, { oneOf: result.oneOf }];
      delete result.oneOf;
    }
    return result;
  }
  const result = visit(root, []) as JsonObject;
  if (family === 'tests') authoredTestRequirements(result);
  if (family === 'characters') authoredCharacterRequirements(result);
  return result;
}
