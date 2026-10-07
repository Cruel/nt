import { z } from 'zod';
import { withSchemaDocumentation } from './schema-documentation';
import instanceExample from './examples/interactable-instance.json';
import { assetRefSchema, materialRefSchema, roomRefSchema } from './authoring-flow';
import { entityIdSchema } from './authoring-common';
import { parseAssetData } from './authoring-assets';
import {
  animationDataSchema,
  animationMotionDurationMs,
  visualSchema,
  validateVisualData,
} from './authoring-animations';
import { resolveMaterialData } from './authoring-materials';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';
import { hotspotCommonShape, motionTrackedRectHotspotShapeSchema } from './authoring-hotspots';
import { featureDataSchema, interactableHotspotTargetSchema } from './authoring-features';
import { inventoryDefinitionSchema, inventoryReferenceSchema } from './authoring-inventories';
import { authoredPropertyValueSchema, ownerLocalPropertiesSchema } from './authoring-properties';
import { cursorTargetSchema } from './authoring-cursor-vocabulary';
import {
  emptyMaterialApplicationSpecialization,
  materialApplicationSchema,
  materialApplicationSpecializationSchema,
} from './authoring-material-applications';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const interactableAssetRefSchema = assetRefSchema;
export const interactableMaterialRefSchema = materialRefSchema;
export const interactableHotspotBehaviorSchema = strict({
  ...hotspotCommonShape,
  target: interactableHotspotTargetSchema,
});
export const interactableHotspotsSchema = withSchemaDocumentation(
  z.discriminatedUnion('kind', [
    strict({ kind: z.literal('none') }),
    strict({ kind: z.literal('visual-alpha'), hotspot: interactableHotspotBehaviorSchema }),
    strict({
      kind: z.literal('custom'),
      hotspots: z.array(
        strict({
          ...hotspotCommonShape,
          cursor: cursorTargetSchema.nullable().optional(),
          target: interactableHotspotTargetSchema,
          shape: motionTrackedRectHotspotShapeSchema,
        }),
      ),
    }),
  ]),
  {
    notes: [
      'visual-alpha samples the current Visual frame CPU alpha coverage. Custom rectangular Hotspot bounds are normalized to the complete Visual canvas.',
    ],
    constraints: [
      'visual-alpha and non-empty custom Hotspots require an image or raster Animation Visual.',
    ],
  },
);
export const interactableLocationSchema = withSchemaDocumentation(
  z.discriminatedUnion('kind', [
    strict({ kind: z.literal('unplaced') }),
    strict({ kind: z.literal('room'), room: roomRefSchema }),
    strict({ kind: z.literal('inventory'), inventory: inventoryReferenceSchema }),
  ]),
  {
    name: 'InteractableLocation',
    notes: [
      'Location is authoritative semantic membership. Room visual occurrences do not change it; Unplaced Instances still exist.',
    ],
    related: ['Room', 'Inventory', 'Interactable Instance'],
    examples: [
      { title: 'Unplaced', value: { kind: 'unplaced' } },
      {
        title: 'In a Room',
        value: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'hall' } } },
      },
    ],
  },
);
export const interactableDefinitionRefSchema = strict({
  $ref: strict({ collection: z.literal('interactables'), id: entityIdSchema }),
});
export const interactableInstanceRefSchema = strict({
  $ref: strict({ registry: z.literal('interactableInstances'), id: entityIdSchema }),
});
export const interactableFeatureOverrideSchema = strict({
  featureId: entityIdSchema,
  traits: strict({
    add: z.array(entityIdSchema),
    remove: z.array(entityIdSchema),
  }),
  properties: z.array(
    strict({
      propertyId: entityIdSchema,
      value: authoredPropertyValueSchema,
    }),
  ),
});
export const interactableInstanceDataSchema = withSchemaDocumentation(
  strict({
    id: entityIdSchema,
    definition: interactableDefinitionRefSchema,
    editorLabel: z.string().min(1).optional(),
    location: interactableLocationSchema,
    enabled: z.boolean(),
    visible: z.boolean(),
    quantity: withSchemaDocumentation(z.number().int().positive().max(Number.MAX_SAFE_INTEGER), {
      constraints: [
        'A declared non-stackable Instance must have quantity 1. A stackable Instance must not exceed its Definition stackLimit when non-null.',
      ],
    }),
    traits: strict({
      add: z.array(entityIdSchema),
      remove: z.array(entityIdSchema),
    }),
    localProperties: ownerLocalPropertiesSchema,
    materialApplication: materialApplicationSpecializationSchema,
    featureOverrides: z.array(interactableFeatureOverrideSchema),
  }),
  {
    name: 'InteractableInstance',
    description: 'One exact live identity, not an aggregate count of its Definition.',
    examples: [
      {
        title: 'Unplaced key Instance',
        source: 'editor/src/shared/project-schema/examples/interactable-instance.json',
        value: instanceExample,
      },
    ],
  },
);

export const interactableDataSchema = strict({
  kind: z.literal('interactable'),
  displayName: z.string(),
  stackable: withSchemaDocumentation(z.boolean(), {
    notes: [
      'When false, aggregate creation of quantity N creates N distinct quantity-one Instances rather than rejecting the creation.',
    ],
    constraints: ['Stackable Definitions cannot own identity-bearing Features or Inventories.'],
    lifecycle: [
      'Changing stackability does not rewrite authored Instances; incompatible quantities remain blocking validation diagnostics.',
    ],
  }),
  stackLimit: withSchemaDocumentation(
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    {
      constraints: [
        'Must be null when stackable is false. Null means the portable safe-integer ceiling when stackable is true.',
      ],
    },
  ),
  presentation: strict({
    visual: visualSchema.nullable(),
    materialApplication: materialApplicationSchema.nullable(),
    cursor: cursorTargetSchema.nullable().optional(),
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
      visual: null,
      materialApplication: null,
      cursor: null,
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
    materialApplication: emptyMaterialApplicationSpecialization(),
    featureOverrides: [],
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
  if (data.presentation.visual)
    diagnostics.push(
      ...validateVisualData(project, data.presentation.visual, `${base}/presentation/visual`),
    );
  if (data.presentation.materialApplication) {
    const materialId = data.presentation.materialApplication.material.$ref.id;
    if (!project.materials[materialId])
      diagnostics.push(
        diagnostic(
          `${base}/presentation/materialApplication/material/$ref`,
          `Missing material '${materialId}'.`,
        ),
      );
    else {
      const resolved = resolveMaterialData(project, materialId).data;
      if (resolved && resolved.role !== 'engine-2d')
        diagnostics.push(
          diagnostic(
            `${base}/presentation/materialApplication/material/$ref`,
            `Interactable Material must use the engine-2d role, not '${resolved.role}'.`,
          ),
        );
    }
    for (const [name, texture] of Object.entries(data.presentation.materialApplication.textures)) {
      const asset = project.assets[texture.source.$ref.id];
      if (!asset)
        diagnostics.push(
          diagnostic(
            `${base}/presentation/materialApplication/textures/${name}/source/$ref`,
            `Missing texture asset '${texture.source.$ref.id}'.`,
          ),
        );
      else if (parseAssetData(asset.data)?.kind !== 'image')
        diagnostics.push(
          diagnostic(
            `${base}/presentation/materialApplication/textures/${name}/source/$ref`,
            `Material texture override '${name}' must reference an image asset.`,
          ),
        );
    }
  }
  const namedCursorIds = new Set(project.settings.cursors.named.map((cursor) => cursor.id));
  const validateCursor = (
    cursor: { kind: string; id?: string } | null | undefined,
    path: string,
  ) => {
    if (cursor?.kind === 'named' && cursor.id && !namedCursorIds.has(cursor.id))
      diagnostics.push(
        diagnostic(path, `Hotspot cursor references missing named cursor '${cursor.id}'.`),
      );
  };
  validateCursor(data.presentation.cursor, `${base}/presentation/cursor`);
  if (data.presentation.hotspots.kind === 'custom')
    data.presentation.hotspots.hotspots.forEach((hotspot, index) => {
      validateCursor(hotspot.cursor, `${base}/presentation/hotspots/hotspots/${index}/cursor`);
      const tracks = hotspot.shape.motionTracks ?? [];
      if (tracks.length === 0) return;
      const visual = data.presentation.visual;
      const animation =
        visual?.kind === 'animation'
          ? animationDataSchema.safeParse(project.animations[visual.animation.$ref.id]?.data)
          : null;
      if (!animation?.success) {
        diagnostics.push(
          diagnostic(
            `${base}/presentation/hotspots/hotspots/${index}/shape/motionTracks`,
            'Motion-keyed Hotspot geometry requires an Animation Visual.',
          ),
        );
        return;
      }
      const seen = new Set<string>();
      tracks.forEach((track, trackIndex) => {
        const trackPath = `${base}/presentation/hotspots/hotspots/${index}/shape/motionTracks/${trackIndex}`;
        if (seen.has(track.motionId))
          diagnostics.push(
            diagnostic(
              `${trackPath}/motionId`,
              `Duplicate Hotspot motion track '${track.motionId}'.`,
            ),
          );
        seen.add(track.motionId);
        const motion = animation.data.motions.find((candidate) => candidate.id === track.motionId);
        if (!motion) {
          diagnostics.push(
            diagnostic(
              `${trackPath}/motionId`,
              `Hotspot motion track references missing motion '${track.motionId}'.`,
            ),
          );
          return;
        }
        const duration = animationMotionDurationMs(motion);
        track.keyframes.forEach((keyframe, keyframeIndex) => {
          if (duration !== null && keyframe.timeMs > duration)
            diagnostics.push(
              diagnostic(
                `${trackPath}/keyframes/${keyframeIndex}/timeMs`,
                `Hotspot motion keyframe exceeds motion duration (${duration} ms).`,
              ),
            );
        });
      });
    });
  return diagnostics;
}
