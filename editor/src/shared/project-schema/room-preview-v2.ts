import { z } from 'zod';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const scalar = z.union([z.null(), z.boolean(), z.number().finite(), z.string()]);
const vector2 = strict({ x: z.number().finite(), y: z.number().finite() });
const normalizedRect = strict({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});
const ownerKind = z.enum([
  'room',
  'scene',
  'dialogue',
  'character',
  'interactable',
  'verb',
  'interaction',
  'map',
]);
const definitionCollection = z.enum([
  'rooms',
  'scenes',
  'dialogues',
  'characters',
  'interactables',
  'verbs',
  'interactions',
  'maps',
]);

const scaleRange = strict({
  enabled: z.boolean(),
  minimum: z.number().finite(),
  maximum: z.number().finite(),
});
export const focusedRoomPreviewEnvironmentSchema = strict({
  profile: strict({
    name: z.string(),
    nativeResolution: strict({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  }),
  project: strict({
    referenceResolution: strict({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    worldRasterPolicy: z.enum(['capped', 'native']),
    barColor: z.string(),
    accessibility: strict({ uiScale: scaleRange, textScale: scaleRange }),
  }),
});

export const focusedRoomIdentityAndVisitSchema = strict({
  roomId: z.string().min(1),
  recordLabel: z.string(),
  displayName: z.string(),
  visit: strict({ visitIndex: z.literal(1), sourceRoomId: z.null(), entryExitId: z.null() }),
});

const propertyIdentity = strict({
  ownerKind,
  ownerId: z.string().min(1),
  propertyId: z.string().min(1),
});
export const focusedLuaAdmissionSchema = strict({
  definitions: z.array(strict({ collection: definitionCollection, id: z.string().min(1) })),
  variableIds: z.array(z.string().min(1)),
  properties: z.array(propertyIdentity),
  interactableLocationIds: z.array(z.string().min(1)),
  compositionDraftCharacterIds: z.array(z.string().min(1)),
  compositionDraftInteractableIds: z.array(z.string().min(1)),
});

export const focusedRoomQueryStateSchema = strict({
  variables: z.array(
    strict({
      id: z.string().min(1),
      type: z.enum(['boolean', 'integer', 'number', 'string', 'enum']),
      value: scalar,
    }),
  ),
  properties: z.array(
    strict({
      ...propertyIdentity.shape,
      result: z.discriminatedUnion('kind', [
        strict({ kind: z.literal('value'), value: scalar }),
        strict({ kind: z.literal('missing') }),
      ]),
    }),
  ),
  definitions: z.array(
    strict({
      collection: definitionCollection,
      id: z.string().min(1),
      displayName: z.string().nullable(),
    }),
  ),
  interactableLocations: z.array(
    strict({
      interactableId: z.string().min(1),
      location: z.discriminatedUnion('kind', [
        strict({ kind: z.literal('inventory') }),
        strict({ kind: z.literal('nowhere') }),
        strict({
          kind: z.literal('room-placement'),
          roomId: z.string().min(1),
          placementId: z.string().min(1),
        }),
      ]),
    }),
  ),
});

export const focusedConditionSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('always') }),
  strict({
    kind: z.literal('variable-comparison'),
    variableId: z.string().min(1),
    operator: z.enum([
      'equal',
      'not-equal',
      'less',
      'less-equal',
      'greater',
      'greater-equal',
      'truthy',
      'falsy',
    ]),
    value: scalar.optional(),
  }),
  strict({ kind: z.literal('lua-predicate'), source: z.string() }),
]);

export const focusedTextSchema = strict({
  markup: z.enum(['plain', 'active-text']),
  source: z.discriminatedUnion('kind', [
    strict({ kind: z.literal('resolved'), text: z.string() }),
    strict({ kind: z.literal('lua-expression'), source: z.string() }),
  ]),
});

const focusedCharacterVisualSchema = strict({
  requestedPoseId: z.string().min(1),
  resolvedPoseId: z.string().min(1),
  expressionId: z.string().min(1),
  idleId: z.string().min(1).nullable(),
  pose: strict({
    spriteAssetId: z.string().min(1).nullable(),
    materialId: z.string().min(1).nullable(),
    offset: vector2,
    scale: z.number().finite(),
    anchor: vector2,
  }),
  expression: strict({
    spriteAssetId: z.string().min(1).nullable(),
    materialId: z.string().min(1).nullable(),
  }),
  idle: z
    .discriminatedUnion('kind', [
      strict({
        kind: z.enum(['bob', 'sway', 'pulse']),
        amplitude: z.number().finite(),
        periodMs: z.number().int().positive(),
        clock: z.enum(['gameplay', 'unscaled-presentation']),
      }),
    ])
    .nullable(),
});

export const focusedRoomWorldDefinitionSchema = strict({
  background: strict({
    assetId: z.string().min(1).nullable(),
    materialId: z.string().min(1).nullable(),
    fit: z.enum(['cover', 'contain', 'stretch', 'center']),
    color: z.string().nullable(),
  }),
  placements: z.array(
    strict({
      id: z.string().min(1),
      bounds: normalizedRect,
      order: z.number().int(),
      label: focusedTextSchema.nullable(),
      layoutId: z.string().min(1).nullable(),
    }),
  ),
  persistentCharacters: z.array(
    strict({
      characterId: z.string().min(1),
      placementId: z.string().min(1),
      enabled: z.boolean(),
      visible: z.boolean(),
      order: z.literal(0),
      visual: focusedCharacterVisualSchema,
    }),
  ),
  cast: z.array(
    strict({
      entryId: z.string().min(1),
      characterId: z.string().min(1),
      condition: focusedConditionSchema,
      placementId: z.string().min(1),
      visible: z.boolean(),
      order: z.number().int(),
      visual: focusedCharacterVisualSchema,
    }),
  ),
  interactables: z.array(
    strict({
      interactableId: z.string().min(1),
      placementId: z.string().min(1),
      spriteAssetId: z.string().min(1).nullable(),
      materialId: z.string().min(1).nullable(),
      enabled: z.boolean(),
      visible: z.boolean(),
      order: z.number().int(),
    }),
  ),
  props: z.array(
    strict({
      propId: z.string().min(1),
      condition: focusedConditionSchema,
      placementId: z.string().min(1),
      assetId: z.string().min(1).nullable(),
      materialId: z.string().min(1).nullable(),
      visible: z.boolean(),
      order: z.number().int(),
    }),
  ),
  environments: z.array(
    strict({
      environmentId: z.string().min(1),
      condition: focusedConditionSchema,
      assetId: z.string().min(1).nullable(),
      materialId: z.string().min(1),
      bounds: normalizedRect,
      plane: z.enum(['world-background', 'world-content', 'world-overlay']),
      order: z.number().int(),
      clock: z.enum(['gameplay', 'unscaled-presentation']),
      scrollPerSecond: vector2,
      opacity: z.number().finite(),
      visible: z.boolean(),
    }),
  ),
  overlays: z.array(
    strict({
      overlayId: z.string().min(1),
      condition: focusedConditionSchema,
      layoutId: z.string().min(1),
      visible: z.boolean(),
      order: z.number().int(),
    }),
  ),
});

export const focusedLayoutSourceComponentSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inline'), text: z.string() }),
  strict({ kind: z.literal('asset'), logicalPath: z.string().min(1) }),
]);

export const focusedRoomLayoutDefinitionSchema = strict({
  instanceId: z.string().min(1),
  layoutId: z.string().min(1).nullable(),
  mount: z.discriminatedUnion('kind', [
    strict({ kind: z.literal('game-hud') }),
    strict({
      kind: z.literal('room-overlay'),
      overlayId: z.string().min(1),
      order: z.number().int(),
      visible: z.boolean(),
    }),
  ]),
  source: z.discriminatedUnion('kind', [
    strict({ kind: z.literal('builtin-game-hud') }),
    strict({
      kind: z.literal('authored'),
      layoutKind: z.enum(['document', 'fragment']),
      templateId: z.literal('layout-fragment-host-v1').nullable(),
      sourceUrl: z.string().min(1),
      defaultParent: z.string().nullable(),
      scopedStyles: z.boolean(),
      scriptNamespace: z.string().nullable(),
      rml: focusedLayoutSourceComponentSchema,
      rcss: focusedLayoutSourceComponentSchema,
      lua: focusedLayoutSourceComponentSchema,
    }),
  ]),
  scriptEnabled: z.boolean(),
  containsDedicatedLuaSource: z.boolean(),
  containsExecutableRmlLua: z.boolean(),
  scalePolicy: strict({ ui: z.enum(['inherit', 'ignore']), text: z.enum(['inherit', 'ignore']) }),
});

export const focusedRoomUiDefinitionSchema = strict({
  description: focusedTextSchema,
  exits: z.array(
    strict({
      exitId: z.string().min(1),
      label: z.string().min(1),
      direction: z.enum([
        'northwest',
        'north',
        'northeast',
        'west',
        'east',
        'southwest',
        'south',
        'southeast',
        'custom',
      ]),
      targetRoomId: z.string().min(1),
      condition: focusedConditionSchema,
    }),
  ),
});

export const focusedRoomCompositionDefinitionSchema = strict({
  scriptId: z.string().min(1),
  source: focusedLayoutSourceComponentSchema,
});

export const focusedShaderMaterialProjectSchema = strict({
  schema: z.literal('noveltea.shader-materials.v1'),
  shaders: z.record(z.string(), z.unknown()),
  materials: z.record(z.string(), z.unknown()),
});

export const roomPreviewDocumentV2Schema = strict({
  schema: z.literal('noveltea.room-preview'),
  schemaVersion: z.literal(2),
  environment: focusedRoomPreviewEnvironmentSchema,
  room: focusedRoomIdentityAndVisitSchema,
  luaAdmission: focusedLuaAdmissionSchema,
  queryState: focusedRoomQueryStateSchema,
  shaderMaterials: focusedShaderMaterialProjectSchema,
  world: focusedRoomWorldDefinitionSchema,
  layouts: z.array(focusedRoomLayoutDefinitionSchema),
  ui: focusedRoomUiDefinitionSchema,
  composition: focusedRoomCompositionDefinitionSchema.nullable(),
});

export type RoomPreviewDocumentV2 = z.infer<typeof roomPreviewDocumentV2Schema>;
