import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import { entityIdSchema } from './authoring-common';
import {
  assetRefSchema,
  conditionSchema,
  effectSchema,
  inlineTextContent,
  layoutRefSchema,
  materialRefSchema,
  roomRefSchema,
  textContentSchema,
} from './authoring-flow';
import { parseLayoutData } from './authoring-layouts';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';
import { validateVariableRuntimeValue } from './authoring-variable-usage';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const roomBackgroundFitValues = ['cover', 'contain', 'stretch', 'center'] as const;
export const roomExitDirectionValues = ['northwest', 'north', 'northeast', 'west', 'east', 'southwest', 'south', 'southeast', 'custom'] as const;

export const roomAssetRefSchema = assetRefSchema;
export const roomMaterialRefSchema = materialRefSchema;
export const roomLayoutRefSchema = layoutRefSchema;
export const roomInteractableRefSchema = strict({ $ref: strict({ collection: z.literal('interactables'), id: entityIdSchema }) });
export const roomRoomRefSchema = roomRefSchema;
export const roomNormalizedRectSchema = strict({
  x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1),
});

export const roomBackgroundDataSchema = strict({
  asset: roomAssetRefSchema.nullable(), material: roomMaterialRefSchema.nullable(),
  fit: z.enum(roomBackgroundFitValues), color: z.string().nullable(),
});
export const roomOverlayDataSchema = strict({ id: entityIdSchema, layout: roomLayoutRefSchema, enabled: z.boolean() });
export const roomPlacementDataSchema = strict({
  id: entityIdSchema,
  interactable: roomInteractableRefSchema,
  bounds: roomNormalizedRectSchema,
  presentation: strict({ label: textContentSchema.nullable(), layout: roomLayoutRefSchema.nullable() }),
});
export const roomExitDataSchema = strict({
  id: entityIdSchema, label: z.string().min(1), direction: z.enum(roomExitDirectionValues),
  target: roomRoomRefSchema, condition: conditionSchema,
});
export const roomLifecycleDataSchema = strict({
  canEnter: conditionSchema, canLeave: conditionSchema,
  beforeEnter: z.array(effectSchema), afterEnter: z.array(effectSchema),
  beforeLeave: z.array(effectSchema), afterLeave: z.array(effectSchema),
});
export const roomDataSchema = strict({
  kind: z.literal('room'), displayName: z.string(), background: roomBackgroundDataSchema,
  description: textContentSchema, overlays: z.array(roomOverlayDataSchema),
  lifecycle: roomLifecycleDataSchema, exits: z.array(roomExitDataSchema), placements: z.array(roomPlacementDataSchema),
});

export type RoomAssetRef = z.infer<typeof roomAssetRefSchema>;
export type RoomMaterialRef = z.infer<typeof roomMaterialRefSchema>;
export type RoomLayoutRef = z.infer<typeof roomLayoutRefSchema>;
export type RoomInteractableRef = z.infer<typeof roomInteractableRefSchema>;
export type RoomRoomRef = z.infer<typeof roomRoomRefSchema>;
export type RoomNormalizedRect = z.infer<typeof roomNormalizedRectSchema>;
export type RoomOverlayData = z.infer<typeof roomOverlayDataSchema>;
export type RoomPlacementData = z.infer<typeof roomPlacementDataSchema>;
export type RoomExitData = z.infer<typeof roomExitDataSchema>;
export type RoomData = z.infer<typeof roomDataSchema>;

export interface RoomSchemaDiagnostic { severity: 'error' | 'warning' | 'info'; path: string; message: string; category?: string }
const diagnostic = (path: string, message: string, severity: RoomSchemaDiagnostic['severity'] = 'error'): RoomSchemaDiagnostic => ({ path, message, severity, category: 'authoring-rooms' });

export function parseRoomData(value: unknown): RoomData | null { const parsed = roomDataSchema.safeParse(value); return parsed.success ? parsed.data : null; }
export function defaultRoomData(label = 'Room'): RoomData {
  return {
    kind: 'room', displayName: label,
    background: { asset: null, material: null, fit: 'cover', color: null },
    description: inlineTextContent(), overlays: [], placements: [], exits: [],
    lifecycle: { canEnter: { kind: 'always' }, canLeave: { kind: 'always' }, beforeEnter: [], afterEnter: [], beforeLeave: [], afterLeave: [] },
  };
}
export function isRoomRecord(record: AuthoringRecordBase | undefined | null): record is AuthoringRecordBase & { data: RoomData } { return !!record && parseRoomData(record.data) !== null; }
export const roomAssetRef = (id: string): RoomAssetRef => ({ $ref: { collection: 'assets', id } });
export const roomMaterialRef = (id: string): RoomMaterialRef => ({ $ref: { collection: 'materials', id } });
export const roomLayoutRef = (id: string): RoomLayoutRef => ({ $ref: { collection: 'layouts', id } });
export const roomInteractableRef = (id: string): RoomInteractableRef => ({ $ref: { collection: 'interactables', id } });
export const roomRoomRef = (id: string): RoomRoomRef => ({ $ref: { collection: 'rooms', id } });

function uniqueIds(items: readonly { id: string }[], path: string, label: string, diagnostics: RoomSchemaDiagnostic[]) {
  const seen = new Set<string>();
  items.forEach((item, index) => { if (seen.has(item.id)) diagnostics.push(diagnostic(`${path}/${index}/id`, `Duplicate ${label} ID '${item.id}'.`)); seen.add(item.id); });
}
function validateCondition(project: AuthoringProject, condition: z.infer<typeof conditionSchema>, path: string, diagnostics: RoomSchemaDiagnostic[]) {
  if (condition.kind !== 'variable-comparison') return;
  const variableId = condition.variable.$ref.id;
  if (condition.value === undefined) {
    if (!project.variables[variableId]) diagnostics.push(diagnostic(`${path}/variable/$ref`, `Missing variable '${variableId}'.`));
    return;
  }
  const result = validateVariableRuntimeValue(project, variableId, condition.value);
  if (!result.ok) diagnostics.push(diagnostic(result.kind === 'missing' ? `${path}/variable/$ref` : `${path}/value`, result.message));
}
function validateEffects(project: AuthoringProject, effects: readonly z.infer<typeof effectSchema>[], path: string, diagnostics: RoomSchemaDiagnostic[]) {
  effects.forEach((effect, index) => {
    if (effect.kind !== 'set-variable') return;
    const result = validateVariableRuntimeValue(project, effect.variable.$ref.id, effect.value);
    if (!result.ok) diagnostics.push(diagnostic(result.kind === 'missing' ? `${path}/${index}/variable/$ref` : `${path}/${index}/value`, result.message));
  });
}
export function validateRoomData(project: AuthoringProject, roomId: string, record: AuthoringRecordBase): RoomSchemaDiagnostic[] {
  const base = `/rooms/${roomId}/data`; const parsed = roomDataSchema.safeParse(record.data);
  if (!parsed.success) return parsed.error.issues.map((issue) => diagnostic(`${base}/${issue.path.join('/')}`, issue.message));
  const data = parsed.data; const diagnostics: RoomSchemaDiagnostic[] = [];
  if (!data.description.source || (data.description.source.kind === 'inline' && !data.description.source.text.trim())) diagnostics.push(diagnostic(`${base}/description`, 'Room description is empty.', 'warning'));
  if (data.background.asset) { const asset = project.assets[data.background.asset.$ref.id]; if (!asset) diagnostics.push(diagnostic(`${base}/background/asset/$ref`, `Missing background asset '${data.background.asset.$ref.id}'.`)); else if (parseAssetData(asset.data)?.kind !== 'image') diagnostics.push(diagnostic(`${base}/background/asset/$ref`, 'Room background asset must be an image.', 'warning')); }
  if (data.background.material && !project.materials[data.background.material.$ref.id]) diagnostics.push(diagnostic(`${base}/background/material/$ref`, `Missing material '${data.background.material.$ref.id}'.`));
  uniqueIds(data.overlays, `${base}/overlays`, 'overlay', diagnostics); uniqueIds(data.exits, `${base}/exits`, 'exit', diagnostics); uniqueIds(data.placements, `${base}/placements`, 'placement', diagnostics);
  data.overlays.forEach((overlay, index) => { const layout = project.layouts[overlay.layout.$ref.id]; if (!layout) diagnostics.push(diagnostic(`${base}/overlays/${index}/layout/$ref`, `Missing layout '${overlay.layout.$ref.id}'.`)); else if (!parseLayoutData(layout.data)) diagnostics.push(diagnostic(`${base}/overlays/${index}/layout/$ref`, `Layout '${overlay.layout.$ref.id}' is invalid.`, 'warning')); });
  data.exits.forEach((exit, index) => { if (!project.rooms[exit.target.$ref.id]) diagnostics.push(diagnostic(`${base}/exits/${index}/target/$ref`, `Missing target room '${exit.target.$ref.id}'.`)); else if (exit.target.$ref.id === roomId) diagnostics.push(diagnostic(`${base}/exits/${index}/target/$ref`, 'Exit targets the current room.', 'warning')); validateCondition(project, exit.condition, `${base}/exits/${index}/condition`, diagnostics); });
  data.placements.forEach((placement, index) => { if (!project.interactables[placement.interactable.$ref.id]) diagnostics.push(diagnostic(`${base}/placements/${index}/interactable/$ref`, `Missing interactable '${placement.interactable.$ref.id}'.`)); if (placement.presentation.layout && !project.layouts[placement.presentation.layout.$ref.id]) diagnostics.push(diagnostic(`${base}/placements/${index}/presentation/layout/$ref`, `Missing layout '${placement.presentation.layout.$ref.id}'.`)); });
  validateCondition(project, data.lifecycle.canEnter, `${base}/lifecycle/canEnter`, diagnostics); validateCondition(project, data.lifecycle.canLeave, `${base}/lifecycle/canLeave`, diagnostics);
  (['beforeEnter', 'afterEnter', 'beforeLeave', 'afterLeave'] as const).forEach((hook) => validateEffects(project, data.lifecycle[hook], `${base}/lifecycle/${hook}`, diagnostics));
  return diagnostics;
}
