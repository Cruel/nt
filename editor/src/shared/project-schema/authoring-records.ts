import { z } from 'zod';
import { assetDataSchema } from './authoring-assets';
import { entityIdSchema } from './authoring-common';
import { characterDataSchema } from './authoring-characters';
import { interactableDataSchema } from './authoring-interactables';
import { dialogueDataSchema } from './authoring-dialogues';
import { layoutDataSchema } from './authoring-layouts';
import { materialDataSchema } from './authoring-materials';
import { propertyAssignmentsSchema } from './authoring-properties';
import { roomDataSchema } from './authoring-rooms';
import { sceneDataSchema } from './authoring-scenes';
import { shaderDataSchema } from './authoring-shaders';
import { testDataSchema } from './authoring-tests';
import { variableDataSchema } from './authoring-variables';

const recordIdentityShape = {
  id: entityIdSchema,
  label: z.string().min(1, 'Record label is required.'),
  description: z.string().optional(),
};

const propertyRecordShape = {
  extends: entityIdSchema.nullable().optional(),
  properties: propertyAssignmentsSchema.optional(),
};

function recordSchema<Data extends z.ZodType>(data: Data) {
  return z.object({ ...recordIdentityShape, data }).strict();
}

function propertyRecordSchema<Data extends z.ZodType>(data: Data) {
  return z.object({ ...recordIdentityShape, ...propertyRecordShape, data }).strict();
}

// Phase 3A wires every planned collection into the strict V2 project envelope.
// Remaining minimal payloads are temporary scaffolding for their later slices.
export const verbDataSchema = z.object({ kind: z.literal('verb').default('verb') }).strict();
export const interactionDataSchema = z.object({ kind: z.literal('interaction').default('interaction') }).strict();
export const mapDataSchema = z.object({ kind: z.literal('map').default('map') }).strict();
export const scriptModuleDataSchema = z.object({
  kind: z.literal('script-module').default('script-module'),
  source: z.string().default(''),
}).strict();

export const assetRecordSchema = recordSchema(assetDataSchema.strict());
export const variableRecordSchema = recordSchema(variableDataSchema.strict());
export const shaderRecordSchema = recordSchema(shaderDataSchema.strict());
export const materialRecordSchema = recordSchema(materialDataSchema.strict());
export const layoutRecordSchema = recordSchema(layoutDataSchema.strict());
export const characterRecordSchema = propertyRecordSchema(characterDataSchema.strict());
export const roomRecordSchema = propertyRecordSchema(roomDataSchema.strict());
export const interactableRecordSchema = propertyRecordSchema(interactableDataSchema);
export const verbRecordSchema = propertyRecordSchema(verbDataSchema);
export const interactionRecordSchema = propertyRecordSchema(interactionDataSchema);
export const dialogueRecordSchema = propertyRecordSchema(dialogueDataSchema.strict());
export const sceneRecordSchema = propertyRecordSchema(sceneDataSchema.strict());
export const mapRecordSchema = propertyRecordSchema(mapDataSchema);
export const scriptRecordSchema = recordSchema(scriptModuleDataSchema);
export const testRecordSchema = recordSchema(testDataSchema.strict());

export const authoringRecordSchemas = {
  assets: assetRecordSchema,
  variables: variableRecordSchema,
  shaders: shaderRecordSchema,
  materials: materialRecordSchema,
  layouts: layoutRecordSchema,
  characters: characterRecordSchema,
  rooms: roomRecordSchema,
  interactables: interactableRecordSchema,
  verbs: verbRecordSchema,
  interactions: interactionRecordSchema,
  dialogues: dialogueRecordSchema,
  scenes: sceneRecordSchema,
  maps: mapRecordSchema,
  scripts: scriptRecordSchema,
  tests: testRecordSchema,
} as const;

export const authoringCollectionSchemas = {
  assets: z.record(entityIdSchema, authoringRecordSchemas.assets),
  variables: z.record(entityIdSchema, authoringRecordSchemas.variables),
  shaders: z.record(entityIdSchema, authoringRecordSchemas.shaders),
  materials: z.record(entityIdSchema, authoringRecordSchemas.materials),
  layouts: z.record(entityIdSchema, authoringRecordSchemas.layouts),
  characters: z.record(entityIdSchema, authoringRecordSchemas.characters),
  rooms: z.record(entityIdSchema, authoringRecordSchemas.rooms),
  interactables: z.record(entityIdSchema, authoringRecordSchemas.interactables),
  verbs: z.record(entityIdSchema, authoringRecordSchemas.verbs),
  interactions: z.record(entityIdSchema, authoringRecordSchemas.interactions),
  dialogues: z.record(entityIdSchema, authoringRecordSchemas.dialogues),
  scenes: z.record(entityIdSchema, authoringRecordSchemas.scenes),
  maps: z.record(entityIdSchema, authoringRecordSchemas.maps),
  scripts: z.record(entityIdSchema, authoringRecordSchemas.scripts),
  tests: z.record(entityIdSchema, authoringRecordSchemas.tests),
} as const;

export type AssetAuthoringRecord = z.infer<typeof assetRecordSchema>;
export type VariableAuthoringRecord = z.infer<typeof variableRecordSchema>;
export type ShaderAuthoringRecord = z.infer<typeof shaderRecordSchema>;
export type MaterialAuthoringRecord = z.infer<typeof materialRecordSchema>;
export type LayoutAuthoringRecord = z.infer<typeof layoutRecordSchema>;
export type CharacterAuthoringRecord = z.infer<typeof characterRecordSchema>;
export type RoomAuthoringRecord = z.infer<typeof roomRecordSchema>;
export type InteractableAuthoringRecord = z.infer<typeof interactableRecordSchema>;
export type VerbAuthoringRecord = z.infer<typeof verbRecordSchema>;
export type InteractionAuthoringRecord = z.infer<typeof interactionRecordSchema>;
export type DialogueAuthoringRecord = z.infer<typeof dialogueRecordSchema>;
export type SceneAuthoringRecord = z.infer<typeof sceneRecordSchema>;
export type MapAuthoringRecord = z.infer<typeof mapRecordSchema>;
export type ScriptAuthoringRecord = z.infer<typeof scriptRecordSchema>;
export type TestAuthoringRecord = z.infer<typeof testRecordSchema>;

export type AuthoringRecord =
  | AssetAuthoringRecord
  | VariableAuthoringRecord
  | ShaderAuthoringRecord
  | MaterialAuthoringRecord
  | LayoutAuthoringRecord
  | CharacterAuthoringRecord
  | RoomAuthoringRecord
  | InteractableAuthoringRecord
  | VerbAuthoringRecord
  | InteractionAuthoringRecord
  | DialogueAuthoringRecord
  | SceneAuthoringRecord
  | MapAuthoringRecord
  | ScriptAuthoringRecord
  | TestAuthoringRecord;
