import { z } from 'zod';
import { assetRefSchema, materialRefSchema, roomRefSchema } from './authoring-flow';
import { entityIdSchema } from './authoring-common';
import { parseAssetData } from './authoring-assets';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';
import { hotspotCommonShape, rectHotspotShapeSchema } from './authoring-hotspots';
import { featureDataSchema, interactableHotspotTargetSchema } from './authoring-features';
import { inventoryDefinitionSchema, inventoryReferenceSchema } from './authoring-inventories';
import { ownerLocalPropertiesSchema } from './authoring-properties';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const interactableAssetRefSchema = assetRefSchema;
export const interactableMaterialRefSchema = materialRefSchema;
export const interactableHotspotBehaviorSchema = strict({
  ...hotspotCommonShape,
  target: interactableHotspotTargetSchema,
});
export const interactableHotspotsSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('none') }),
  strict({ kind: z.literal('sprite-alpha'), hotspot: interactableHotspotBehaviorSchema }),
  strict({
    kind: z.literal('custom'),
    hotspots: z.array(
      strict({
        ...hotspotCommonShape,
        target: interactableHotspotTargetSchema,
        shape: rectHotspotShapeSchema,
      }),
    ),
  }),
]);
export const interactableLocationSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('unplaced') }),
  strict({ kind: z.literal('room'), room: roomRefSchema }),
  strict({ kind: z.literal('inventory'), inventory: inventoryReferenceSchema }),
]);
export const interactableDefinitionRefSchema = strict({
  $ref: strict({ collection: z.literal('interactables'), id: entityIdSchema }),
});
export const interactableInstanceRefSchema = strict({
  $ref: strict({ registry: z.literal('interactableInstances'), id: entityIdSchema }),
});
export const interactableInstanceDataSchema = strict({
  id: entityIdSchema,
  definition: interactableDefinitionRefSchema,
  editorLabel: z.string().min(1).optional(),
  location: interactableLocationSchema,
  enabled: z.boolean(),
  visible: z.boolean(),
  quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  traits: strict({
    add: z.array(entityIdSchema),
    remove: z.array(entityIdSchema),
  }),
  localProperties: ownerLocalPropertiesSchema,
});

export const interactableDataSchema = strict({
  kind: z.literal('interactable'),
  displayName: z.string(),
  stackable: z.boolean(),
  stackLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  presentation: strict({
    sprite: interactableAssetRefSchema.nullable(),
    material: interactableMaterialRefSchema.nullable(),
    hotspots: interactableHotspotsSchema,
  }),
  features: z.array(featureDataSchema),
  inventories: z.array(inventoryDefinitionSchema),
});
export type InteractableData = z.infer<typeof interactableDataSchema>;
export type InteractableInstanceData = z.infer<typeof interactableInstanceDataSchema>;
export type InteractableInstanceRef = z.infer<typeof interactableInstanceRefSchema>;
export type InteractableHotspots = z.infer<typeof interactableHotspotsSchema>;
export type InteractableFeatureData = z.infer<typeof featureDataSchema>;
export interface InteractableSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
  code?: string;
}
const diagnostic = (
  path: string,
  message: string,
  severity: InteractableSchemaDiagnostic['severity'] = 'error',
  code?: string,
): InteractableSchemaDiagnostic => ({
  path,
  message,
  severity,
  category: 'Interactables',
  ...(code ? { code } : {}),
});
export function parseInteractableData(value: unknown): InteractableData | null {
  const parsed = interactableDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function defaultInteractableData(label = 'Interactable'): InteractableData {
  return {
    kind: 'interactable',
    displayName: label,
    stackable: false,
    stackLimit: null,
    presentation: {
      sprite: null,
      material: null,
      hotspots: { kind: 'none' },
    },
    features: [],
    inventories: [],
  };
}
export function defaultInteractableInstanceData(
  id: string,
  definitionId: string,
  location: InteractableInstanceData['location'] = { kind: 'unplaced' },
): InteractableInstanceData {
  return {
    id,
    definition: { $ref: { collection: 'interactables', id: definitionId } },
    location,
    enabled: true,
    visible: true,
    quantity: 1,
    traits: { add: [], remove: [] },
    localProperties: [],
  };
}
export const interactableAssetRef = (id: string) => ({
  $ref: { collection: 'assets' as const, id },
});
export const interactableMaterialRef = (id: string) => ({
  $ref: { collection: 'materials' as const, id },
});
export function validateInteractableData(
  project: AuthoringProject,
  interactableId: string,
  record: AuthoringRecordBase,
): InteractableSchemaDiagnostic[] {
  const base = `/interactables/${interactableId}/data`;
  const parsed = interactableDataSchema.safeParse(record.data);
  if (!parsed.success)
    return parsed.error.issues.map((issue) =>
      diagnostic(`${base}/${issue.path.join('/')}`, issue.message),
    );
  const data = parsed.data;
  const diagnostics: InteractableSchemaDiagnostic[] = [];
  if (data.presentation.sprite) {
    const asset = project.assets[data.presentation.sprite.$ref.id];
    if (!asset)
      diagnostics.push(
        diagnostic(
          `${base}/presentation/sprite/$ref`,
          `Missing sprite asset '${data.presentation.sprite.$ref.id}'.`,
        ),
      );
    else if (parseAssetData(asset.data)?.kind !== 'image')
      diagnostics.push(
        diagnostic(
          `${base}/presentation/sprite/$ref`,
          'Interactable sprite must be an image.',
          'warning',
        ),
      );
  }
  if (data.presentation.material && !project.materials[data.presentation.material.$ref.id])
    diagnostics.push(
      diagnostic(
        `${base}/presentation/material/$ref`,
        `Missing material '${data.presentation.material.$ref.id}'.`,
      ),
    );
  return diagnostics;
}
