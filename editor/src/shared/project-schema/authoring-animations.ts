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

export const motionPlaybackPolicySchema = strict({
  repeat: z.enum(['once', 'loop']),
  rate: z.number().finite().positive(),
  clock: z.enum(['gameplay', 'unscaled-presentation']),
  initialMarker: entityIdSchema.nullable(),
  loopRange: strict({ start: entityIdSchema, end: entityIdSchema }).optional(),
}).refine((policy) => !policy.loopRange || policy.repeat === 'loop', {
  message: 'A loop range requires loop playback.',
  path: ['loopRange'],
});
export const animationMarkerSchema = strict({
  id: entityIdSchema,
  timeMs: z.number().int().nonnegative(),
});

export const spriteAnimationMotionSchema = strict({
  id: entityIdSchema,
  kind: z.literal('sprite-sequence'),
  frames: z.array(spriteAnimationFrameSchema),
  markers: z.array(animationMarkerSchema),
});

export const videoAnimationSourceRangeSchema = strict({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
}).refine((range) => range.endMs > range.startMs, {
  message: 'Video source range end must be after its start.',
  path: ['endMs'],
});

export const videoAnimationMotionSchema = strict({
  id: entityIdSchema,
  kind: z.literal('video'),
  video: assetRefSchema,
  sourceRange: videoAnimationSourceRangeSchema.optional(),
  markers: z.array(animationMarkerSchema),
});

export const animationMotionSchema = z.discriminatedUnion('kind', [
  spriteAnimationMotionSchema,
  videoAnimationMotionSchema,
]);

export const animationDataSchema = withSchemaDocumentation(
  strict({
    kind: z.literal('animation'),
    canvas: animationCanvasSchema,
    defaultMotionId: entityIdSchema,
    motions: z.array(animationMotionSchema).min(1),
  }),
  {
    name: 'Animation',
    notes: [
      'Animation is immutable reusable raster presentation content. Playback phase belongs to presentation realization, not this resource.',
      'Motion IDs are scoped to the Animation. Sprite frames name Image Assets with explicit positive durations; video motions name semantic Video Assets and may select an in/out source range.',
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
      playback: motionPlaybackPolicySchema.nullable(),
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
  const emptyDraft = data.motions.every(
    (motion) => motion.kind === 'sprite-sequence' && motion.frames.length === 0,
  );
  if (emptyDraft)
    diagnostics.push({
      severity: 'warning',
      path: `/animations/${animationId}/data/motions`,
      category: 'Animations',
      code: 'animation.empty',
      message: 'Add image frames before using this Animation.',
    });
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
    if (!emptyDraft && motion.kind === 'sprite-sequence' && !motion.frames.length)
      diagnostics.push({
        severity: 'error',
        path: `${base}/motions/${motionIndex}/frames`,
        category: 'Animations',
        message: 'Animation motions require at least one frame.',
      });
    const duration = animationMotionDurationMs(motion);
    const markers = new Set(['start', 'end']);
    motion.markers.forEach((marker, index) => {
      if (markers.has(marker.id) || (duration !== null && marker.timeMs > duration))
        diagnostics.push({
          severity: 'error',
          path: `${base}/motions/${motionIndex}/markers/${index}`,
          message: 'Animation marker must be unique, non-reserved, and within the motion.',
          category: 'Animations',
        });
      markers.add(marker.id);
    });
    if (motion.kind === 'sprite-sequence') {
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
    } else {
      const assetId = motion.video.$ref.id;
      const asset = project.assets[assetId];
      const assetData = asset ? parseAssetData(asset.data) : null;
      const path = `${base}/motions/${motionIndex}/video/$ref`;
      if (!asset)
        diagnostics.push({
          severity: 'error',
          path,
          message: `Missing Animation video Asset '${assetId}'.`,
          category: 'Animations',
          code: 'animation.video.asset-missing',
        });
      else if (assetData?.kind !== 'video')
        diagnostics.push({
          severity: 'error',
          path,
          message: `Animation video Asset '${assetId}' must be a video.`,
          category: 'Animations',
          code: 'animation.video.asset-kind',
        });
    }
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

export function animationMarkerTime(
  motion: z.infer<typeof animationMotionSchema>,
  id: string,
): number | null {
  if (id === 'start') return 0;
  if (id === 'end') return animationMotionDurationMs(motion);
  return motion.markers.find((marker) => marker.id === id)?.timeMs ?? null;
}

export function animationMotionDurationMs(
  motion: z.infer<typeof animationMotionSchema>,
): number | null {
  if (motion.kind === 'sprite-sequence')
    return motion.frames.reduce((sum, frame) => sum + frame.durationMs, 0);
  return motion.sourceRange ? motion.sourceRange.endMs - motion.sourceRange.startMs : null;
}

export type AnimationData = z.infer<typeof animationDataSchema>;
export type Visual = z.infer<typeof visualSchema>;

export function visualImageAssetId(
  project: AuthoringProject,
  visual: Visual | null,
): string | null {
  if (!visual) return null;
  if (visual.kind === 'image') return visual.image.$ref.id;
  const parsed = animationDataSchema.safeParse(project.animations[visual.animation.$ref.id]?.data);
  if (!parsed.success) return null;
  const motionId = visual.motionId ?? parsed.data.defaultMotionId;
  const motion = parsed.data.motions.find((motion) => motion.id === motionId);
  return motion?.kind === 'sprite-sequence' ? (motion.frames[0]?.image.$ref.id ?? null) : null;
}

export function validateVisualData(
  project: AuthoringProject,
  visual: Visual,
  path: string,
): (ProjectValidationDiagnosticLike & { path: string })[] {
  if (visual.kind === 'animation' && visual.playback && path.includes('/animationClips/'))
    return [
      {
        severity: 'error',
        path: `${path}/playback`,
        category: 'Animations',
        message:
          'Character clip Visuals use choreography timing; explicit reusable playback policy is not admitted here.',
      },
    ];
  if (visual.kind === 'image') {
    const asset = project.assets[visual.image.$ref.id];
    return asset && parseAssetData(asset.data)?.kind === 'image'
      ? []
      : [
          {
            severity: 'error',
            path: `${path}/image/$ref`,
            category: 'Interactables',
            message: `Visual must reference a valid Image Asset '${visual.image.$ref.id}'.`,
          },
        ];
  }
  const parsed = animationDataSchema.safeParse(project.animations[visual.animation.$ref.id]?.data);
  if (!parsed.success)
    return [
      {
        severity: 'error',
        path: `${path}/animation/$ref`,
        category: 'Interactables',
        message: `Missing or invalid Animation '${visual.animation.$ref.id}'.`,
      },
    ];
  const motionId = visual.motionId ?? parsed.data.defaultMotionId;
  const motion = parsed.data.motions.find((motion) => motion.id === motionId);
  if (motion?.kind === 'sprite-sequence' && !motion.frames.length)
    return [
      {
        severity: 'error',
        path: `${path}/motionId`,
        category: 'Animations',
        message: 'An empty Animation motion cannot be used as a Visual.',
      },
    ];
  const range = visual.playback?.loopRange;
  if (motion && range) {
    const start = animationMarkerTime(motion, range.start);
    const end = animationMarkerTime(motion, range.end);
    const unresolvedPreparedEnd =
      motion.kind === 'video' && !motion.sourceRange && range.end === 'end' && end === null;
    if (start === null || (!unresolvedPreparedEnd && (end === null || start >= end)))
      return [
        {
          severity: 'error',
          path: `${path}/playback/loopRange`,
          category: 'Animations',
          message: 'Loop markers must exist and delimit a positive forward range.',
        },
      ];
  }
  const marker = visual.playback?.initialMarker;
  if (
    motion &&
    marker &&
    marker !== 'start' &&
    marker !== 'end' &&
    !motion.markers.some((entry) => entry.id === marker)
  )
    return [
      {
        severity: 'error',
        path: `${path}/playback/initialMarker`,
        category: 'Animations',
        message: `Unknown Animation marker '${marker}'.`,
      },
    ];
  return motion
    ? []
    : [
        {
          severity: 'error',
          path: `${path}/motionId`,
          category: 'Interactables',
          message: `Unknown Animation motion '${motionId}'.`,
        },
      ];
}
