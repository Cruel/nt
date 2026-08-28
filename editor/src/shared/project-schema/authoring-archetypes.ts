import { z } from 'zod';
import { parseJsonPointer } from '../json-pointer';
import { entityIdSchema } from './authoring-common';
import {
  characterDataSchema,
  defaultCharacterData,
  type CharacterData,
} from './authoring-characters';
import {
  defaultInteractableData,
  interactableDataSchema,
  type InteractableData,
} from './authoring-interactables';
import { defaultRoomData, roomDataSchema, type RoomData } from './authoring-rooms';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';
import { propertyAssignmentsSchema, type PropertyAssignments } from './authoring-properties';

export const gameplayInstanceKindValues = ['room', 'character', 'interactable'] as const;
export type GameplayInstanceKind = (typeof gameplayInstanceKindValues)[number];

export const archetypeRefSchema = z
  .object({
    $ref: z.object({ collection: z.literal('archetypes'), id: entityIdSchema }).strict(),
  })
  .strict();

export const archetypeDataSchema = z
  .object({
    kind: z.literal('archetype'),
    instanceKind: z.enum(gameplayInstanceKindValues),
    base: archetypeRefSchema.nullable().default(null),
    overrides: z.record(z.string(), z.json()).default({}),
  })
  .strict();

export type ArchetypeData = z.infer<typeof archetypeDataSchema>;
export type ArchetypeRef = z.infer<typeof archetypeRefSchema>;

export interface EffectiveGameplayInstanceConfiguration {
  traits: string[];
  properties: PropertyAssignments;
  data: RoomData | CharacterData | InteractableData;
}

export interface InheritableConfiguration {
  traits: string[];
  properties: PropertyAssignments;
  data: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function withoutCharacterState(data: CharacterData): Omit<CharacterData, 'initialWorldState'> {
  const { initialWorldState: _initialWorldState, ...configuration } = data;
  return configuration;
}

export function defaultArchetypeConfiguration(
  kind: GameplayInstanceKind,
): InheritableConfiguration {
  if (kind === 'room') return { traits: [], properties: {}, data: defaultRoomData('Room') };
  if (kind === 'character') {
    return {
      traits: [],
      properties: {},
      data: withoutCharacterState(defaultCharacterData('Character')),
    };
  }
  return {
    traits: [],
    properties: {},
    data: defaultInteractableData('Interactable'),
  };
}

function applyOverride(target: unknown, pointer: string, value: unknown): unknown {
  const segments = parseJsonPointer(pointer);
  if (segments.length === 0) return clone(value);
  const root = clone(target);
  let current: unknown = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (Array.isArray(current)) {
      const position = Number(segment);
      if (!Number.isInteger(position) || position < 0 || position >= current.length)
        throw new Error(`Invalid archetype override path '${pointer}'.`);
      current = current[position];
      continue;
    }
    if (!isObject(current)) throw new Error(`Invalid archetype override path '${pointer}'.`);
    if (!Object.prototype.hasOwnProperty.call(current, segment)) current[segment] = {};
    current = current[segment];
  }
  const leaf = segments.at(-1)!;
  if (Array.isArray(current)) {
    const position = Number(leaf);
    if (!Number.isInteger(position) || position < 0 || position >= current.length)
      throw new Error(`Invalid archetype override path '${pointer}'.`);
    current[position] = clone(value);
  } else if (isObject(current)) {
    current[leaf] = clone(value);
  } else {
    throw new Error(`Invalid archetype override path '${pointer}'.`);
  }
  return root;
}

export function isArchetypeOverridePathAllowed(
  kind: GameplayInstanceKind,
  pointer: string,
): boolean {
  let segments: string[];
  try {
    segments = parseJsonPointer(pointer);
  } catch {
    return false;
  }
  if (segments.length === 0) return false;
  if (!['traits', 'properties', 'data'].includes(segments[0]!)) return false;
  if (kind === 'character' && segments[0] === 'data' && segments[1] === 'initialWorldState')
    return false;
  return true;
}

function applyOverrides(
  configuration: InheritableConfiguration,
  overrides: Record<string, unknown>,
  kind: GameplayInstanceKind,
): InheritableConfiguration {
  let current: unknown = configuration;
  for (const [pointer, value] of Object.entries(overrides).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!isArchetypeOverridePathAllowed(kind, pointer))
      throw new Error(`Archetype override path '${pointer}' is not valid for ${kind}.`);
    current = applyOverride(current, pointer, value);
  }
  if (!isObject(current))
    throw new Error('Archetype overrides must resolve to a configuration object.');
  return current as unknown as InheritableConfiguration;
}

function parseConfiguration(kind: GameplayInstanceKind, configuration: InheritableConfiguration) {
  const traits = z.array(entityIdSchema).safeParse(configuration.traits);
  const properties = propertyAssignmentsSchema.safeParse(configuration.properties);
  if (!traits.success || !properties.success) return null;
  if (kind === 'room') {
    const data = roomDataSchema.safeParse(configuration.data);
    return data.success
      ? { traits: traits.data, properties: properties.data, data: data.data }
      : null;
  }
  if (kind === 'character') {
    if (!isObject(configuration.data)) return null;
    const base = defaultCharacterData('Character');
    const data = characterDataSchema.safeParse({
      ...configuration.data,
      initialWorldState: base.initialWorldState,
    });
    return data.success
      ? { traits: traits.data, properties: properties.data, data: withoutCharacterState(data.data) }
      : null;
  }
  const data = interactableDataSchema.safeParse(configuration.data);
  return data.success
    ? {
        traits: traits.data,
        properties: properties.data,
        data: data.data,
      }
    : null;
}

export function parseArchetypeData(value: unknown): ArchetypeData | null {
  const parsed = archetypeDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultArchetypeData(instanceKind: GameplayInstanceKind = 'room'): ArchetypeData {
  return { kind: 'archetype', instanceKind, base: null, overrides: {} };
}

export function gameplayInstanceKindForCollection(collection: string): GameplayInstanceKind | null {
  return collection === 'rooms'
    ? 'room'
    : collection === 'characters'
      ? 'character'
      : collection === 'interactables'
        ? 'interactable'
        : null;
}

export function resolveArchetypeConfiguration(
  project: AuthoringProject,
  archetypeId: string,
): InheritableConfiguration | null {
  const visiting = new Set<string>();
  const resolved = new Map<string, InheritableConfiguration>();
  const visit = (id: string): InheritableConfiguration | null => {
    const cached = resolved.get(id);
    if (cached) return clone(cached);
    if (visiting.has(id)) return null;
    const record = project.archetypes[id];
    const data = parseArchetypeData(record?.data);
    if (!data) return null;
    visiting.add(id);
    let base = defaultArchetypeConfiguration(data.instanceKind);
    if (data.base) {
      const parentRecord = project.archetypes[data.base.$ref.id];
      const parentData = parseArchetypeData(parentRecord?.data);
      if (!parentData || parentData.instanceKind !== data.instanceKind) return null;
      const parent = visit(data.base.$ref.id);
      if (!parent) return null;
      base = parent;
    }
    let effective: InheritableConfiguration;
    try {
      effective = applyOverrides(base, data.overrides, data.instanceKind);
    } catch {
      return null;
    }
    const parsed = parseConfiguration(data.instanceKind, effective);
    if (!parsed) return null;
    const normalized = parsed as InheritableConfiguration;
    visiting.delete(id);
    resolved.set(id, clone(normalized));
    return normalized;
  };
  return visit(archetypeId);
}

function rawInheritableConfiguration(
  kind: GameplayInstanceKind,
  record: AuthoringRecordBase,
): InheritableConfiguration | null {
  if (kind === 'room') {
    const parsed = roomDataSchema.safeParse(record.data);
    return parsed.success
      ? {
          traits: [...(record.traits ?? [])],
          properties: { ...record.properties },
          data: parsed.data,
        }
      : null;
  }
  if (kind === 'character') {
    const parsed = characterDataSchema.safeParse(record.data);
    return parsed.success
      ? {
          traits: [...(record.traits ?? [])],
          properties: { ...record.properties },
          data: withoutCharacterState(parsed.data),
        }
      : null;
  }
  const parsed = interactableDataSchema.safeParse(record.data);
  return parsed.success
    ? {
        traits: [...(record.traits ?? [])],
        properties: { ...record.properties },
        data: parsed.data,
      }
    : null;
}

export function resolveGameplayInstanceRecord(
  project: AuthoringProject,
  kind: GameplayInstanceKind,
  record: AuthoringRecordBase,
): AuthoringRecordBase | null {
  const raw = rawInheritableConfiguration(kind, record);
  if (!raw) return null;
  const archetypeId = record.archetype?.$ref.id;
  if (!archetypeId) return clone(record);
  const archetypeRecord = project.archetypes[archetypeId];
  const archetypeData = parseArchetypeData(archetypeRecord?.data);
  if (!archetypeData || archetypeData.instanceKind !== kind) return null;
  const base = resolveArchetypeConfiguration(project, archetypeId);
  if (!base) return null;
  let effective: InheritableConfiguration;
  try {
    effective = applyOverrides(base, record.archetypeOverrides ?? {}, kind);
  } catch {
    return null;
  }
  const parsed = parseConfiguration(kind, effective);
  if (!parsed) return null;
  let data: unknown = parsed.data;
  if (kind === 'character') {
    const local = characterDataSchema.parse(record.data);
    data = { ...(parsed.data as object), initialWorldState: local.initialWorldState };
  }
  return {
    ...record,
    traits: [...parsed.traits],
    properties: { ...parsed.properties },
    data,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectOverrides(
  base: unknown,
  next: unknown,
  pointer: string,
  output: Record<string, unknown>,
) {
  if (sameJson(base, next)) return;
  if (Array.isArray(base) || Array.isArray(next) || !isObject(base) || !isObject(next)) {
    output[pointer] = clone(next);
    return;
  }
  const keys = [...new Set([...Object.keys(base), ...Object.keys(next)])].sort();
  for (const key of keys) {
    const childPointer = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      output[pointer] = clone(next);
      return;
    }
    collectOverrides(base[key], next[key], childPointer, output);
  }
}

export function deriveArchetypeOverrides(
  base: InheritableConfiguration,
  next: InheritableConfiguration,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  collectOverrides(base, next, '', overrides);
  if (Object.prototype.hasOwnProperty.call(overrides, '')) {
    const root = overrides[''];
    delete overrides[''];
    if (isObject(root))
      for (const [key, value] of Object.entries(root)) overrides[`/${key}`] = value;
  }
  return overrides;
}

export function inheritableConfigurationFromRecord(
  kind: GameplayInstanceKind,
  record: AuthoringRecordBase,
): InheritableConfiguration | null {
  return rawInheritableConfiguration(kind, record);
}
