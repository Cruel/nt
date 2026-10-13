import type { ZodType } from 'zod';
import { authoringRecordSchemas } from '../project-schema/authoring-records';
import { conditionSchema } from '../project-schema/authoring-flow';
import { defaultRoomData } from '../project-schema/authoring-rooms';
import { defaultMapData } from '../project-schema/authoring-maps';
import { decodeStructuredYaml, encodeStructuredYaml } from './structured-yaml-source';

type Family = 'rooms' | 'maps';
type Shape = Record<string, ZodType>;
type Dict = Record<string, unknown>;

const object = (value: unknown): value is Dict =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const room = defaultRoomData();
const map = defaultMapData();

// Source omissions are semantic defaults, not UI initialization guesses. Paths are relative
// to the record and '*' matches a single array element. These are deliberately conservative:
// geometry, identities, presentation choices and union discriminators remain explicit.
const defaults: Record<Family, Readonly<Record<string, unknown>>> = {
  rooms: {
    'data.background': room.background,
    'data.description': room.description,
    'data.presentationSpace.bounds': null,
    'data.presentationSpace.edgePolicy': 'contain',
    'data.presentationSpace.views': [],
    'data.presentationSpace.defaultView.zoom': 1,
    'data.presentationSpace.defaultView.rotationDegrees': 0,
    'data.anchors': [],
    'data.overlays': [],
    'data.placements': [],
    'data.cast': [],
    'data.props': [],
    'data.interactables': [],
    'data.environments': [],
    'data.scriptHooks': [],
    'data.exits': [],
    'data.features': [],
    'data.hotspots': [],
    'data.lifecycle': room.lifecycle,
    'data.fallbackInteractablePlacementId': null,
    'data.overlays.*.condition': { kind: 'always' },
    'data.overlays.*.visible': true,
    'data.overlays.*.order': 0,
    'data.cast.*.condition': { kind: 'always' },
    'data.cast.*.visible': true,
    'data.cast.*.order': 0,
    'data.cast.*.poseId': null,
    'data.cast.*.expressionId': null,
    'data.cast.*.idleId': null,
    'data.props.*.condition': { kind: 'always' },
    'data.props.*.asset': null,
    'data.props.*.materialApplication': null,
    'data.props.*.visible': true,
    'data.props.*.order': 0,
    'data.interactables.*.condition': { kind: 'always' },
    'data.interactables.*.visible': true,
    'data.interactables.*.order': 0,
    'data.environments.*.condition': { kind: 'always' },
    'data.environments.*.plane': 'world-content',
    'data.environments.*.order': 0,
    'data.environments.*.clock': 'gameplay',
    'data.environments.*.scrollPerSecond': { x: 0, y: 0 },
    'data.environments.*.opacity': 1,
    'data.environments.*.visible': true,
    'data.exits.*.condition': { kind: 'always' },
    'data.exits.*.onRejected': [],
  },
  maps: {
    'data.presentation': map.presentation,
    'data.locations': [],
    'data.connections': [],
    'data.locations.*.regions': [],
    'data.locations.*.label': null,
    'data.locations.*.icon': null,
    'data.locations.*.style': null,
    'data.locations.*.labelAnchor': null,
    'data.locations.*.connectionAnchor': null,
    'data.locations.*.visibility': { kind: 'always' },
    'data.locations.*.pickOrder': 0,
    'data.locations.*.logicalOrder': 0,
    'data.connections.*.label': null,
    'data.connections.*.icon': null,
    'data.connections.*.style': null,
    'data.connections.*.visibility': { kind: 'always' },
    'data.connections.*.logicalOrder': 0,
    'data.connections.*.path': [],
    'data.connections.*.hitRegions': [],
  },
};

/** Source omission values, indexed by normalized record path; '*' is one sequence item. */
export function roomMapYamlSourceDefaults(family: Family): Readonly<Record<string, unknown>> {
  return defaults[family];
}

function sourceDefault(family: Family, path: readonly string[]): unknown {
  const table = defaults[family];
  for (let length = path.length; length > 0; length -= 1) {
    const key = path.slice(0, length).join('.');
    if (!Object.hasOwn(table, key)) continue;
    let value = table[key];
    for (const segment of path.slice(length)) {
      if (!object(value) || !Object.hasOwn(value, segment)) return undefined;
      value = value[segment];
    }
    return value;
  }
  return undefined;
}

function definition(schema: ZodType): Dict {
  return schema._zod.def as unknown as Dict;
}

function unwrap(schema: ZodType): ZodType {
  for (;;) {
    const def = definition(schema);
    if (['optional', 'nullable', 'default', 'readonly', 'nonoptional'].includes(String(def.type))) {
      schema = def.innerType as ZodType;
    } else if (def.type === 'lazy') {
      schema = (def.getter as () => ZodType)();
    } else return schema;
  }
}

function variant(schema: ZodType, value: unknown): ZodType {
  const def = definition(schema);
  if (def.type !== 'union') return schema;
  const options = def.options as ZodType[];
  if (object(value) && typeof value.kind === 'string') {
    const match = options.find((option) => {
      const shape = definition(unwrap(option)).shape as Shape | undefined;
      return (
        shape?.kind &&
        definition(unwrap(shape.kind)).values instanceof Array &&
        (definition(unwrap(shape.kind)).values as unknown[]).includes(value.kind)
      );
    });
    if (match) return match;
  }
  // Non-discriminated unions (e.g. placement presentation) are selected only by
  // their validated contract, never by guessing a gameplay kind from property names.
  return options.find((option) => option.safeParse(value).success) ?? schema;
}

function typedReference(schema: ZodType): string | undefined {
  const shape = definition(schema).shape as Shape | undefined;
  if (definition(schema).type !== 'object' || !shape?.$ref) return undefined;
  const refShape = definition(unwrap(shape.$ref)).shape as Shape | undefined;
  if (!refShape?.collection) return undefined;
  const literals = definition(unwrap(refShape.collection)).values;
  return Array.isArray(literals) && typeof literals[0] === 'string' ? literals[0] : undefined;
}

function convert(
  family: Family,
  schemaInput: ZodType,
  value: unknown,
  path: string[],
  direction: 'read' | 'write',
  previous?: unknown,
  previousEffective?: unknown,
): unknown {
  const fallback = sourceDefault(family, path);
  if (direction === 'read' && value === undefined) return structuredClone(fallback);
  if (direction === 'write') {
    if (previous !== undefined && same(value, previousEffective)) return previous;
    // A default value does not make a union's identity optional. Only data.kind,
    // which is statically fixed by the record family, is omitted.
    if (path.at(-1) !== 'kind' && fallback !== undefined && same(value, fallback)) return undefined;
  }
  if (value === null || value === undefined) return value;
  let schema = unwrap(schemaInput);
  if (schemaInput === conditionSchema || schema === conditionSchema) {
    if (direction === 'read' && value === 'always') return { kind: 'always' };
    if (direction === 'write' && same(value, { kind: 'always' })) return 'always';
  }
  if (direction === 'read' && value === 'always' && path.at(-1) === 'condition')
    return { kind: 'always' };
  if (direction === 'write' && same(value, { kind: 'always' })) return 'always';
  const selected = variant(schema, value);
  if (selected === schema && definition(schema).type === 'union') {
    const matches = (definition(schema).options as ZodType[]).flatMap((option) => {
      const candidate = convert(family, option, value, path, direction);
      return option.safeParse(candidate).success ? [candidate] : [];
    });
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Ambiguous YAML union variant at ${path.join('/')}.`);
    return value;
  }
  schema = unwrap(selected);
  const reference = typedReference(schema);
  if (reference) {
    if (direction === 'read') {
      if (typeof value !== 'string')
        throw new Error(`Expected a bare ${reference} reference at ${path.join('/')}.`);
      return { $ref: { collection: reference, id: value } };
    }
    const ref = (value as { $ref?: { collection?: string; id?: string } })?.$ref;
    if (ref?.collection !== reference || typeof ref.id !== 'string')
      throw new Error(`Invalid normalized ${reference} reference at ${path.join('/')}.`);
    return ref.id;
  }
  const def = definition(schema);
  if (def.type === 'array' && Array.isArray(value)) {
    const element = def.element as ZodType;
    const prior = Array.isArray(previous) ? previous : [];
    const priorEffective = Array.isArray(previousEffective) ? previousEffective : [];
    return value.map((entry, index) => {
      const identity = (item: unknown) =>
        object(item) && typeof item.id === 'string' ? item.id : undefined;
      const id = identity(entry);
      const formerIndex = id ? priorEffective.findIndex((item) => identity(item) === id) : index;
      return convert(
        family,
        element,
        entry,
        [...path, '*'],
        direction,
        formerIndex >= 0 ? prior[formerIndex] : undefined,
        formerIndex >= 0 ? priorEffective[formerIndex] : undefined,
      );
    });
  }
  if (def.type !== 'object' || !object(value)) return value;
  const shape = def.shape as Shape;
  if (direction === 'read' && path.join('.') === 'data' && Object.hasOwn(value, 'kind'))
    throw new Error('Redundant data.kind is not supported in Room/Map YAML.');
  const result: Dict = {};
  for (const [key, childSchema] of Object.entries(shape)) {
    if (path.join('.') === 'data' && key === 'kind') {
      if (direction === 'read') result.kind = family === 'rooms' ? 'room' : 'map';
      continue;
    }
    const child = convert(
      family,
      childSchema,
      value[key],
      [...path, key],
      direction,
      object(previous) ? previous[key] : undefined,
      object(previousEffective) ? previousEffective[key] : undefined,
    );
    if (child !== undefined) result[key] = child;
  }
  // Let the strict normalized Zod schema diagnose unknown keys, rather than losing them.
  for (const [key, child] of Object.entries(value)) if (!(key in shape)) result[key] = child;
  return result;
}

export function decodeRoomMapYaml(family: Family, text: string): unknown {
  const schema = authoringRecordSchemas[family];
  const source = decodeStructuredYaml(text);
  // Admission belongs to the workspace projection so Zod errors retain their
  // normalized owner pointers, rather than becoming an opaque source-read error.
  return convert(family, schema, source, [], 'read');
}

export function encodeRoomMapYaml(family: Family, value: unknown, previousText?: string): string {
  const schema = authoringRecordSchemas[family];
  const normalized = schema.parse(value);
  const previousSource =
    previousText === undefined ? undefined : decodeStructuredYaml(previousText);
  const previousEffective =
    previousText === undefined ? undefined : schema.parse(decodeRoomMapYaml(family, previousText));
  const source = convert(
    family,
    schema,
    normalized,
    [],
    'write',
    previousSource,
    previousEffective,
  );
  return encodeStructuredYaml(source, previousText);
}
