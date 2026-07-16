import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import { parseMaterialData } from './authoring-materials';
import { entityIdSchema } from './authoring-common';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';
import { parseRoomData } from './authoring-rooms';

export const characterPreviewBackgroundValues = ['transparent', 'checker', 'dark', 'light'] as const;
export type CharacterPreviewBackground = (typeof characterPreviewBackgroundValues)[number];

export const characterAssetRefSchema = z.object({
  $ref: z.object({ collection: z.literal('assets'), id: z.string().min(1) }).strict(),
}).strict();

export const characterMaterialRefSchema = z.object({
  $ref: z.object({ collection: z.literal('materials'), id: z.string().min(1) }).strict(),
}).strict();

export const characterVector2Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();

export const characterPoseDataSchema = z.object({
  id: entityIdSchema,
  label: z.string().min(1, 'Pose label is required.'),
  sprite: characterAssetRefSchema.nullable().default(null),
  material: characterMaterialRefSchema.nullable().default(null),
  offset: characterVector2Schema.default({ x: 0, y: 0 }),
  scale: z.number().finite().positive().default(1),
  anchor: characterVector2Schema.default({ x: 0.5, y: 1 }),
}).strict();

export const characterExpressionDataSchema = z.object({
  id: entityIdSchema,
  label: z.string().min(1, 'Expression label is required.'),
  poseId: entityIdSchema.nullable().default(null),
  sprite: characterAssetRefSchema.nullable().default(null),
  material: characterMaterialRefSchema.nullable().default(null),
}).strict();

export const characterDialogueStyleSchema = z.object({
  name: z.string().default(''),
  nameColor: z.string().nullable().default(null),
  textColor: z.string().nullable().default(null),
  styleClass: z.string().default(''),
}).strict();

export const characterInitialWorldLocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('nowhere') }).strict(),
  z.object({ kind: z.literal('room-placement'), placement: z.object({ room: entityIdSchema, placement: entityIdSchema }).strict() }).strict(),
]);

export const characterDataSchema = z.object({
  kind: z.literal('character').default('character'),
  displayName: z.string().default(''),
  dialogue: characterDialogueStyleSchema.default({ name: '', nameColor: null, textColor: null, styleClass: '' }),
  defaults: z.object({
    poseId: entityIdSchema,
    expressionId: entityIdSchema,
  }).strict().default({ poseId: 'default', expressionId: 'neutral' }),
  poses: z.array(characterPoseDataSchema).default([]),
  expressions: z.array(characterExpressionDataSchema).default([]),
  initialWorldState: z.object({
    location: characterInitialWorldLocationSchema, enabled: z.boolean(), visible: z.boolean(),
  }).strict().default({ location: { kind: 'nowhere' }, enabled: true, visible: true }),
}).strict();

export type CharacterAssetRef = z.infer<typeof characterAssetRefSchema>;
export type CharacterMaterialRef = z.infer<typeof characterMaterialRefSchema>;
export type CharacterPoseData = z.infer<typeof characterPoseDataSchema>;
export type CharacterExpressionData = z.infer<typeof characterExpressionDataSchema>;
export type CharacterDialogueStyle = z.infer<typeof characterDialogueStyleSchema>;
export type CharacterData = z.infer<typeof characterDataSchema>;

export interface CharacterSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(path: string, message: string, severity: 'error' | 'warning' | 'info' = 'error'): CharacterSchemaDiagnostic {
  return { severity, path, message, category: 'authoring-characters' };
}

export function parseCharacterData(value: unknown): CharacterData | null {
  const parsed = characterDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultCharacterData(label = 'Character'): CharacterData {
  return characterDataSchema.parse({
    kind: 'character',
    displayName: label,
    dialogue: {
      name: label,
      nameColor: null,
      textColor: null,
      styleClass: '',
    },
    defaults: { poseId: 'default', expressionId: 'neutral' },
    poses: [{
      id: 'default',
      label: 'Default',
      sprite: null,
      material: null,
      offset: { x: 0, y: 0 },
      scale: 1,
      anchor: { x: 0.5, y: 1 },
    }],
    expressions: [{
      id: 'neutral',
      label: 'Neutral',
      poseId: null,
      sprite: null,
      material: null,
    }],
    initialWorldState: { location: { kind: 'nowhere' }, enabled: true, visible: true },
  });
}

export function isCharacterRecord(record: AuthoringRecordBase | undefined | null): record is AuthoringRecordBase & { data: CharacterData } {
  return !!record && parseCharacterData(record.data) !== null;
}

function refId(ref: CharacterAssetRef | CharacterMaterialRef | null | undefined): string | null {
  return ref?.$ref.id ?? null;
}

function validateUniqueIds(
  items: Array<{ id: string }>,
  path: string,
  label: string,
  diagnostics: CharacterSchemaDiagnostic[],
) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) diagnostics.push(diagnostic(`${path}/${index}/id`, `Duplicate ${label} ID '${item.id}'.`));
    seen.add(item.id);
  });
}

function validateSpriteRef(
  project: AuthoringProject,
  ref: CharacterAssetRef | null,
  path: string,
  diagnostics: CharacterSchemaDiagnostic[],
) {
  const id = refId(ref);
  if (!id) return;
  const asset = project.assets[id];
  if (!asset) {
    diagnostics.push(diagnostic(`${path}/$ref`, `Missing sprite asset '${id}'.`));
    return;
  }
  const data = parseAssetData(asset.data);
  if (!data) diagnostics.push(diagnostic(`${path}/$ref`, `Asset '${id}' has invalid asset data.`, 'warning'));
  else if (data.kind !== 'image') diagnostics.push(diagnostic(`${path}/$ref`, `Sprite asset '${id}' is ${data.kind}, not image.`, 'warning'));
}

function validateMaterialRef(
  project: AuthoringProject,
  ref: CharacterMaterialRef | null,
  path: string,
  diagnostics: CharacterSchemaDiagnostic[],
) {
  const id = refId(ref);
  if (!id) return;
  const material = project.materials[id];
  if (!material) {
    diagnostics.push(diagnostic(`${path}/$ref`, `Missing material '${id}'.`));
    return;
  }
  if (!parseMaterialData(material.data)) diagnostics.push(diagnostic(`${path}/$ref`, `Material '${id}' has invalid material data.`, 'warning'));
}

export function validateCharacterData(
  project: AuthoringProject,
  characterId: string,
  record: AuthoringRecordBase,
): CharacterSchemaDiagnostic[] {
  const diagnostics: CharacterSchemaDiagnostic[] = [];
  const parsed = characterDataSchema.safeParse(record.data);
  const base = `/characters/${characterId}/data`;
  if (!parsed.success) {
    for (const issue of parsed.error.issues) diagnostics.push(diagnostic(`${base}/${issue.path.map(String).join('/')}`, issue.message));
    return diagnostics;
  }

  const data = parsed.data;

  if (data.poses.length === 0) diagnostics.push(diagnostic(`${base}/poses`, 'Character requires at least one pose.'));
  if (data.expressions.length === 0) diagnostics.push(diagnostic(`${base}/expressions`, 'Character requires at least one expression.'));
  validateUniqueIds(data.poses, `${base}/poses`, 'pose', diagnostics);
  validateUniqueIds(data.expressions, `${base}/expressions`, 'expression', diagnostics);

  const poses = new Set(data.poses.map((pose) => pose.id));
  const expressions = new Set(data.expressions.map((expression) => expression.id));

  if (!poses.has(data.defaults.poseId)) diagnostics.push(diagnostic(`${base}/defaults/poseId`, `Missing default pose '${data.defaults.poseId}'.`));
  if (!expressions.has(data.defaults.expressionId)) diagnostics.push(diagnostic(`${base}/defaults/expressionId`, `Missing default expression '${data.defaults.expressionId}'.`));

  data.poses.forEach((pose, index) => {
    validateSpriteRef(project, pose.sprite, `${base}/poses/${index}/sprite`, diagnostics);
    validateMaterialRef(project, pose.material, `${base}/poses/${index}/material`, diagnostics);
  });
  data.expressions.forEach((expression, index) => {
    if (expression.poseId && !poses.has(expression.poseId)) {
      diagnostics.push(diagnostic(`${base}/expressions/${index}/poseId`, `Expression pose '${expression.poseId}' does not exist.`, 'warning'));
    }
    validateSpriteRef(project, expression.sprite, `${base}/expressions/${index}/sprite`, diagnostics);
    validateMaterialRef(project, expression.material, `${base}/expressions/${index}/material`, diagnostics);
  });

  const selectedPose = data.poses.find((pose) => pose.id === data.defaults.poseId);
  const selectedExpression = data.expressions.find((expression) => expression.id === data.defaults.expressionId);
  if (selectedPose && selectedExpression && !selectedPose.sprite && !selectedExpression.sprite) {
    diagnostics.push(diagnostic(`${base}/preview`, 'Selected pose/expression has no sprite asset yet.', 'warning'));
  }
  const location = data.initialWorldState.location;
  if (location.kind === 'room-placement') {
    const room = project.rooms[location.placement.room];
    const roomData = room ? parseRoomData(room.data) : null;
    if (!room) diagnostics.push(diagnostic(`${base}/initialWorldState/location/placement/room`, `Missing room '${location.placement.room}'.`));
    else if (!roomData?.placements.some((placement) => placement.id === location.placement.placement)) diagnostics.push(diagnostic(`${base}/initialWorldState/location/placement/placement`, `Missing placement '${location.placement.placement}'.`));
  }

  return diagnostics;
}

export function characterAssetRef(assetId: string): CharacterAssetRef {
  return { $ref: { collection: 'assets', id: assetId } };
}

export function characterMaterialRef(materialId: string): CharacterMaterialRef {
  return { $ref: { collection: 'materials', id: materialId } };
}
