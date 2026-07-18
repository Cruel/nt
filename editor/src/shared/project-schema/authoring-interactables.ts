import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { assetRefSchema, materialRefSchema } from './authoring-flow';
import { parseAssetData } from './authoring-assets';
import { parseRoomData } from './authoring-rooms';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const interactableAssetRefSchema = assetRefSchema;
export const interactableMaterialRefSchema = materialRefSchema;
export const roomPlacementRefSchema = strict({ room: entityIdSchema, placement: entityIdSchema });
export const interactableInitialLocationSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inventory') }), strict({ kind: z.literal('nowhere') }), strict({ kind: z.literal('room-placement'), placement: roomPlacementRefSchema }),
]);
export const interactableDataSchema = strict({
  kind: z.literal('interactable'), displayName: z.string(),
  presentation: strict({ sprite: interactableAssetRefSchema.nullable(), material: interactableMaterialRefSchema.nullable() }),
  initialState: strict({ location: interactableInitialLocationSchema, enabled: z.boolean(), visible: z.boolean() }),
});
export type InteractableData = z.infer<typeof interactableDataSchema>;
export type InteractableInitialLocation = z.infer<typeof interactableInitialLocationSchema>;
export interface InteractableSchemaDiagnostic { severity: 'error' | 'warning' | 'info'; path: string; message: string; category?: string }
const diagnostic = (path: string, message: string, severity: InteractableSchemaDiagnostic['severity'] = 'error'): InteractableSchemaDiagnostic => ({ path, message, severity, category: 'Interactables' });
export function parseInteractableData(value: unknown): InteractableData | null { const parsed = interactableDataSchema.safeParse(value); return parsed.success ? parsed.data : null; }
export function defaultInteractableData(label = 'Interactable'): InteractableData { return { kind: 'interactable', displayName: label, presentation: { sprite: null, material: null }, initialState: { location: { kind: 'nowhere' }, enabled: true, visible: true } }; }
export const interactableAssetRef = (id: string) => ({ $ref: { collection: 'assets' as const, id } });
export const interactableMaterialRef = (id: string) => ({ $ref: { collection: 'materials' as const, id } });
export function validateInteractableData(project: AuthoringProject, interactableId: string, record: AuthoringRecordBase): InteractableSchemaDiagnostic[] {
  const base = `/interactables/${interactableId}/data`; const parsed = interactableDataSchema.safeParse(record.data);
  if (!parsed.success) return parsed.error.issues.map((issue) => diagnostic(`${base}/${issue.path.join('/')}`, issue.message));
  const data = parsed.data; const diagnostics: InteractableSchemaDiagnostic[] = [];
  if (data.presentation.sprite) { const asset = project.assets[data.presentation.sprite.$ref.id]; if (!asset) diagnostics.push(diagnostic(`${base}/presentation/sprite/$ref`, `Missing sprite asset '${data.presentation.sprite.$ref.id}'.`)); else if (parseAssetData(asset.data)?.kind !== 'image') diagnostics.push(diagnostic(`${base}/presentation/sprite/$ref`, 'Interactable sprite must be an image.', 'warning')); }
  if (data.presentation.material && !project.materials[data.presentation.material.$ref.id]) diagnostics.push(diagnostic(`${base}/presentation/material/$ref`, `Missing material '${data.presentation.material.$ref.id}'.`));
  const location = data.initialState.location;
  if (location.kind === 'room-placement') {
    const room = project.rooms[location.placement.room];
    const roomData = room ? parseRoomData(room.data) : null;
    const placement = roomData?.placements.find((candidate) => candidate.id === location.placement.placement);
    if (!room) diagnostics.push(diagnostic(`${base}/initialState/location/placement/room`, `Missing room '${location.placement.room}'.`));
    else if (!placement) diagnostics.push(diagnostic(`${base}/initialState/location/placement/placement`, `Missing placement '${location.placement.placement}'.`));
  }
  return diagnostics;
}
