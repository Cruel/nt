import { z } from 'zod';
import { withSchemaDocumentation } from './schema-documentation';
import { entityIdSchema } from './authoring-common';
import { animationRefSchema, assetRefSchema } from './authoring-flow';
import { parseAssetData } from './authoring-assets';
import type { AuthoringProject } from './authoring-project';
import type { ProjectValidationDiagnosticLike } from './project-validation';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const animationCanvasSchema = withSchemaDocumentation(
  strict({
    width: z.number().int().positive().max(10_000),
    height: z.number().int().positive().max(10_000),
  }),
  {
    name: 'AnimationCanvas',
    notes: [
      'The logical canvas is stable across every motion and frame. Source image dimensions do not change world placement.',
    ],
  },
);

export const spriteAnimationFrameSchema = strict({
  image: assetRefSchema,
  durationMs: z.number().int().positive(),
});

export const spriteAnimationMotionSchema = strict({
  id: entityIdSchema,
  kind: z.literal('sprite-sequence'),
  frames: z.array(spriteAnimationFrameSchema).min(1),
});

export const animationDataSchema = withSchemaDocumentation(
  strict({
    kind: z.literal('animation'),
    canvas: animationCanvasSchema,
    defaultMotionId: entityIdSchema,
    motions: z.array(spriteAnimationMotionSchema).min(1),
  }),
  {
    name: 'Animation',
    notes: [
      'Animation is immutable reusable raster presentation content. Playback phase belongs to presentation realization, not this resource.',
      'Motion IDs are scoped to the Animation. Every sprite frame names an Image Asset and has an explicit positive duration.',
    ],
  },
);

export const visualSchema = withSchemaDocumentation(
  z.discriminatedUnion('kind', [
    strict({ kind: z.literal('image'), image: assetRefSchema }),
    strict({
      kind: z.literal('animation'),
      animation: animationRefSchema,
      motionId: entityIdSchema.nullable().default(null),
    }),
  ]),
  {
    name: 'Visual',
    notes: [
      'A Visual is initially either a static Image Asset or a raster Animation. An Animation Visual with no motionId uses the Animation default motion.',
    ],
  },
);

export function validateAnimationData(
  project: AuthoringProject,
  animationId: string,
  data: z.infer<typeof animationDataSchema>,
): ProjectValidationDiagnosticLike[] {
  const diagnostics: ProjectValidationDiagnosticLike[] = [];
  const base = `/animations/${animationId}/data`;
  const motionIds = new Set<string>();
  data.motions.forEach((motion, motionIndex) => {
    if (motionIds.has(motion.id))
      diagnostics.push({
        severity: 'error',
        path: `${base}/motions/${motionIndex}/id`,
        message: `Duplicate Animation motion ID '${motion.id}'.`,
        category: 'Animations',
        code: 'animation.motion.duplicate-id',
      });
    motionIds.add(motion.id);
    motion.frames.forEach((frame, frameIndex) => {
      const assetId = frame.image.$ref.id;
      const asset = project.assets[assetId];
      const assetData = asset ? parseAssetData(asset.data) : null;
      const path = `${base}/motions/${motionIndex}/frames/${frameIndex}/image/$ref`;
      if (!asset)
        diagnostics.push({
          severity: 'error',
          path,
          message: `Missing Animation frame Asset '${assetId}'.`,
          category: 'Animations',
          code: 'animation.frame.asset-missing',
        });
      else if (assetData?.kind !== 'image')
        diagnostics.push({
          severity: 'error',
          path,
          message: `Animation frame Asset '${assetId}' must be an image.`,
          category: 'Animations',
          code: 'animation.frame.asset-kind',
        });
    });
  });
  if (!motionIds.has(data.defaultMotionId))
    diagnostics.push({
      severity: 'error',
      path: `${base}/defaultMotionId`,
      message: `Default Animation motion '${data.defaultMotionId}' does not exist.`,
      category: 'Animations',
      code: 'animation.default-motion.missing',
    });
  return diagnostics;
}

export type AnimationData = z.infer<typeof animationDataSchema>;
export type Visual = z.infer<typeof visualSchema>;
