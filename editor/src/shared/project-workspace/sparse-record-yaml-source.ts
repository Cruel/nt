import type { ZodType } from 'zod';
import { authoringRecordSchemas } from '../project-schema/authoring-records';
import { conditionSchema } from '../project-schema/authoring-flow';
import { defaultRoomData } from '../project-schema/authoring-rooms';
import { defaultMapData } from '../project-schema/authoring-maps';
import { characterDataSchema } from '../project-schema/authoring-characters';
import { defaultInteractionProgram } from '../project-schema/authoring-interaction-programs';
import { defaultDialogueData } from '../project-schema/authoring-dialogues';
import { decodeStructuredYaml, encodeStructuredYaml } from './structured-yaml-source';

export type SparseRecordFamily =
  | 'rooms'
  | 'maps'
  | 'characters'
  | 'interactables'
  | 'verbs'
  | 'interactions'
  | 'dialogues'
  | 'scenes'
  | 'tests';
type Family = SparseRecordFamily;
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
  characters: {
    // Match the Character schema's defaults. The editor's starter Profile/Pose,
    // Expression and display-name placeholders are not source defaults.
    'data.displayName': '',
    'data.dialogue': characterDataSchema.parse({ inventories: [] }).dialogue,
    'data.defaults': characterDataSchema.parse({ inventories: [] }).defaults,
    'data.profiles': [],
    'data.expressions': [],
    'data.appearances': [],
    'data.gestures': [],
    'data.idles': [],
    'data.inventories': [],
    'data.initialWorldState': {
      location: { kind: 'unplaced' },
      enabled: true,
      visible: true,
    },
    'data.profiles.*.layers': [],
    'data.profiles.*.poses': [],
    'data.profiles.*.animationClips': [],
    'data.profiles.*.automaticAnimations': { blink: null, speaking: null },
    'data.profiles.*.automaticAnimations.blink': null,
    'data.profiles.*.automaticAnimations.speaking': null,
    'data.profiles.*.layers.*.role': null,
    'data.profiles.*.poses.*.layers': [],
    'data.profiles.*.poses.*.layers.*.visual': null,
    'data.profiles.*.poses.*.layers.*.materialApplication': null,
    'data.profiles.*.poses.*.layers.*.offset': { x: 0, y: 0 },
    'data.profiles.*.poses.*.layers.*.scale': 1,
    'data.profiles.*.poses.*.layers.*.anchor': { x: 0.5, y: 1 },
    'data.profiles.*.poses.*.layers.*.visible': true,
    'data.profiles.*.animationClips.*.frames.*.layers': [],
    'data.defaults.appearanceId': null,
    'data.defaults.idleId': null,
    'data.dialogue.name': '',
    'data.dialogue.nameColor': null,
    'data.dialogue.textColor': null,
    'data.dialogue.styleClass': '',
    'data.gestures.*.profiles': [],
    'data.gestures.*.profiles.*.cues': [],
    'data.gestures.*.profiles.*.cues.*.gain': 1,
    'data.gestures.*.profiles.*.cues.*.pan': 0,
    'data.appearances.*.profiles': [],
    'data.appearances.*.profiles.*.layers': [],
    'data.expressions.*.profiles': [],
    'data.expressions.*.profiles.*.layers': [],
    'data.initialWorldState.location': { kind: 'unplaced' },
    'data.initialWorldState.enabled': true,
    'data.initialWorldState.visible': true,
  },
  interactables: {
    // Definition gameplay policy (stackable/stackLimit) is NOT defaulted.
    // A lack of visual presentation, features or inventories is semantically inert.
    'data.presentation': {
      visual: null,
      materialApplication: null,
      hotspots: { kind: 'none' },
    },
    'data.presentation.visual': null,
    'data.presentation.materialApplication': null,
    'data.presentation.hotspots': { kind: 'none' },
    'data.features': [],
    'data.inventories': [],
    'data.features.*.traits': [],
    'data.features.*.localProperties': [],
    'data.features.*.defaultProperties': [],
    'data.features.*.inventories': [],
  },
  verbs: {
    'data.slots': [],
    'data.bindingOrder': [],
    'data.offers': [],
    'data.availability': { kind: 'always' },
    'data.defaultProgram': defaultInteractionProgram(),
    'data.defaultProgram.instructions': [],
    'data.defaultProgram.completion': { kind: 'return' },
    'data.defaultProgram.outcome': 'handled',
    'data.offers.*.rank': 0,
    'data.offers.*.primary': false,
  },
  interactions: {
    'data.rules': [],
    'data.rules.*.offer': null,
    'data.rules.*.guard': { kind: 'always' },
    'data.rules.*.priority': 0,
    'data.rules.*.program': defaultInteractionProgram(),
    'data.rules.*.program.instructions': [],
    'data.rules.*.program.completion': { kind: 'return' },
    'data.rules.*.program.outcome': 'handled',
    'data.rules.*.offer.rank': 0,
    'data.rules.*.offer.primary': false,
  },
  dialogues: {
    'data.displayName': '',
    'data.defaultSpeaker': null,
    'data.stageSlots': [],
    'data.mediaSlots': [],
    'data.settings': defaultDialogueData().settings,
    'data.settings.showDisabledChoices': true,
    'data.settings.logMode': 'everything',
    'data.edges': [],
    'data.completion': { kind: 'end' },
    'data.blocks.*.defaultSpeaker': null,
    'data.blocks.*.segments.*.speaker': null,
    'data.blocks.*.segments.*.cues': [],
    'data.blocks.*.segments.*.effects': [],
    'data.blocks.*.segments.*.showOnce': false,
    'data.blocks.*.segments.*.logged': true,
    'data.blocks.*.segments.*.autosaveSafePoint': false,
    'data.blocks.*.segments.*.mayYield': true,
    'data.blocks.*.segments.*.inputs': [],
    'data.blocks.*.segments.*.uiPolicy': 'conceal',
    'data.edges.*.effects': [],
    'data.edges.*.logged': true,
    'data.edges.*.autosaveSafePoint': false,
    'data.stageSlots.*.speakerSync': true,
    'data.stageSlots.*.initial': null,
    'data.mediaSlots.*.initial': null,
    'data.mediaSlots.*.visible': true,
    'data.blocks.*.segments.*.cues.*.waitForCompletion': false,
    'data.blocks.*.segments.*.cues.*.skippable': true,
  },
  scenes: {
    'data.displayName': '',
    'data.inputs': [],
    'data.outcomes': [],
    'data.events.*.enabled': true,
    'data.events.*.completionDependencies': [],
    'data.events.*.autosaveSafePoint': false,
    'data.events.*.inputs': [],
    'data.events.*.mayYield': true,
    'data.events.*.skippable': true,
    'data.events.*.waitForCompletion': false,
    'data.events.*.effects': [],
    'data.events.*.options.*.effects': [],
  },
  tests: {
    'data.displayName': '',
    'data.steps': [],
    'data.finalExpectations': [],
    'data.steps.*.enabled': true,
    'data.steps.*.expectations': [],
    // Inactive input payloads are retained in normalized data by Zod, but their
    // defaults are not meaningful commands or targets for the selected input.
    // Never infer a choice ID, selector, expectation operator or target.
    'data.steps.*.tick': { deltaSeconds: 0 },
    'data.steps.*.selectSubjects': { subjects: [] },
  },
};

/** Source omission values, indexed by normalized record path; '*' is one sequence item. */
export function sparseRecordYamlSourceDefaults(family: Family): Readonly<Record<string, unknown>> {
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

function conditionType(schema: ZodType): boolean {
  for (;;) {
    if (schema === conditionSchema) return true;
    const def = definition(schema);
    if (['optional', 'nullable', 'default', 'readonly', 'nonoptional'].includes(String(def.type)))
      schema = def.innerType as ZodType;
    else return false;
  }
}

function variant(schema: ZodType, value: unknown): ZodType {
  const def = definition(schema);
  if (def.type !== 'union') return schema;
  const options = def.options as ZodType[];
  if (object(value)) {
    // Zod unions may discriminate on 'kind', 'ownerKind', or another literal
    // field. Choose that variant before transforming its typed references;
    // source YAML bare IDs would otherwise fail safeParse against the normalized
    // alternative and leave opaque $ref wrappers unconverted.
    const matches = options.filter((option) => {
      const candidate = unwrap(option);
      if (definition(candidate).type !== 'object') return false;
      const shape = definition(candidate).shape as Shape;
      return Object.entries(shape).some(([key, field]) => {
        const literals = definition(unwrap(field)).values;
        return (
          Object.hasOwn(value, key) && Array.isArray(literals) && literals.includes(value[key])
        );
      });
    });
    if (matches.length === 1) return matches[0]!;
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
  if (conditionType(schemaInput)) {
    if (direction === 'read' && value === 'always') return { kind: 'always' };
    if (direction === 'write' && same(value, { kind: 'always' })) return 'always';
  }
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
    throw new Error(`Redundant data.kind is not supported in ${family} YAML.`);
  const result: Dict = {};
  for (const [key, childSchema] of Object.entries(shape)) {
    if (path.join('.') === 'data' && key === 'kind') {
      if (direction === 'read')
        result.kind = {
          rooms: 'room',
          maps: 'map',
          characters: 'character',
          interactables: 'interactable',
          verbs: 'verb',
          interactions: 'interaction',
          dialogues: 'dialogue',
          scenes: 'scene',
          tests: 'test',
        }[family];
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

export function decodeSparseRecordYaml(family: Family, text: string): unknown {
  const schema = authoringRecordSchemas[family];
  const source = decodeStructuredYaml(text);
  // Admission belongs to the workspace projection so Zod errors retain their
  // normalized owner pointers, rather than becoming an opaque source-read error.
  return convert(family, schema, source, [], 'read');
}

export function encodeSparseRecordYaml(
  family: Family,
  value: unknown,
  previousText?: string,
): string {
  const schema = authoringRecordSchemas[family];
  const normalized = schema.parse(value);
  const previousSource =
    previousText === undefined ? undefined : decodeStructuredYaml(previousText);
  const previousEffective =
    previousText === undefined
      ? undefined
      : schema.parse(decodeSparseRecordYaml(family, previousText));
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
