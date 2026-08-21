import { z } from 'zod';
import { assetRefSchema, materialRefSchema } from './authoring-flow';
import { parseAssetData } from './authoring-assets';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';
import {
  defaultHotspotBehavior,
  hotspotCommonShape,
  rectHotspotShapeSchema,
} from './authoring-hotspots';
import { featureDataSchema, interactableHotspotTargetSchema } from './authoring-features';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const interactableAssetRefSchema = assetRefSchema;
export const interactableMaterialRefSchema = materialRefSchema;
export const interactableHotspotBehaviorSchema = strict({
  ...hotspotCommonShape,
  target: interactableHotspotTargetSchema,
});
export const interactableHotspotsSchema = z.discriminatedUnion('kind', [
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
export const interactableDataSchema = strict({
  kind: z.literal('interactable'),
  displayName: z.string(),
  presentation: strict({
    sprite: interactableAssetRefSchema.nullable(),
    material: interactableMaterialRefSchema.nullable(),
    hotspots: interactableHotspotsSchema,
  }),
  features: z.array(featureDataSchema),
  initialState: strict({
    enabled: z.boolean(),
    visible: z.boolean(),
  }),
});
export type InteractableData = z.infer<typeof interactableDataSchema>;
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
    presentation: {
      sprite: null,
      material: null,
      hotspots: { kind: 'sprite-alpha', hotspot: defaultHotspotBehavior(label) },
    },
    features: [],
    initialState: { enabled: true, visible: true },
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
