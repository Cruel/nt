import { z } from 'zod';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const scalar = z.union([z.null(), z.boolean(), z.number().finite(), z.string()]);
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

const strictJsonObject = z.record(z.string(), z.json());
export const roomPreviewDocumentV2Schema = strict({
  schema: z.literal('noveltea.room-preview'),
  schemaVersion: z.literal(2),
  environment: focusedRoomPreviewEnvironmentSchema,
  room: focusedRoomIdentityAndVisitSchema,
  luaAdmission: focusedLuaAdmissionSchema,
  queryState: focusedRoomQueryStateSchema,
  shaderMaterials: strictJsonObject,
  world: strictJsonObject,
  layouts: z.array(strictJsonObject),
  ui: strictJsonObject,
  composition: strictJsonObject.nullable(),
});

export type RoomPreviewDocumentV2 = z.infer<typeof roomPreviewDocumentV2Schema>;
