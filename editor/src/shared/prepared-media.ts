import { z } from 'zod';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const PREPARED_MEDIA_MANIFEST_PATH = 'assets/.prepared-media/manifest.json';
export const PREPARED_MEDIA_SCHEMA = 'noveltea.private.prepared-media';
export const OPAQUE_VIDEO_FRAME_RATE = 30;

export const opaqueVideoPreparationRequestSchema = strict({
  animationId: z.string().min(1),
  motionId: z.string().min(1),
  assetId: z.string().min(1),
  sourcePath: z.string().min(1),
  canvas: strict({
    width: z.number().int().positive().max(10_000),
    height: z.number().int().positive().max(10_000),
  }),
  sourceRange: strict({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
  })
    .refine((range) => range.endMs > range.startMs)
    .optional(),
});
export type OpaqueVideoPreparationRequest = z.infer<typeof opaqueVideoPreparationRequestSchema>;

export const opaqueVideoPreparationResultSchema = strict({
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  hadAudio: z.boolean(),
  frames: z
    .array(
      strict({
        sourcePath: z.string().min(1),
        projectRelativePath: z.string().min(1),
        contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
        byteSize: z.number().int().nonnegative(),
        durationMs: z.number().int().positive(),
      }),
    )
    .min(1),
});
export type OpaqueVideoPreparationResult = z.infer<typeof opaqueVideoPreparationResultSchema>;

export const preparedMediaManifestSchema = strict({
  schema: z.literal(PREPARED_MEDIA_SCHEMA),
  motions: z.array(
    strict({
      animationId: z.string().min(1),
      motionId: z.string().min(1),
      representation: z.literal('opaque-raster-frames'),
      contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
      frames: z
        .array(
          strict({
            path: z.string().min(1),
            durationMs: z.number().int().positive(),
          }),
        )
        .min(1),
    }),
  ),
});
export type PreparedMediaManifest = z.infer<typeof preparedMediaManifestSchema>;

export function preparedVideoFramePackagePath(
  animationId: string,
  motionId: string,
  contentHash: string,
  frameIndex: number,
): string {
  const segment = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/gu, '-');
  return `assets/.prepared-media/${segment(animationId)}/${segment(motionId)}/${contentHash.slice(0, 16)}/frame-${String(frameIndex).padStart(6, '0')}.png`;
}
