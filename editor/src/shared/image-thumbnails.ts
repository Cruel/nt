import { z } from 'zod';
import { sha256HexUtf8 } from './web-crypto';

export const IMAGE_THUMBNAIL_PROFILES = {
  list: { width: 96, height: 72, fit: 'cover' },
  wide: { width: 160, height: 96, fit: 'cover' },
  card: { width: 320, height: 320, fit: 'cover' },
} as const;

export const IMAGE_THUMBNAIL_MAX_PREWARM_BATCH_SIZE = 50_000;

export type ImageThumbnailProfile = keyof typeof IMAGE_THUMBNAIL_PROFILES;
export type ImageThumbnailOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type ImageThumbnailSampling = 'linear' | 'nearest';

export interface ImageThumbnailSource {
  projectSessionId: string;
  assetId: string;
  projectRelativePath: string;
  contentHash?: string;
  width: number;
  height: number;
  orientation: ImageThumbnailOrientation;
  sampling?: ImageThumbnailSampling;
}

export interface ImageThumbnailVariant {
  kind: 'profile';
  profile: ImageThumbnailProfile;
}

export interface ImageThumbnailRequest {
  source: ImageThumbnailSource;
  variant: ImageThumbnailVariant;
}

export type ImageThumbnailErrorCode =
  | 'invalid_request'
  | 'stale_project_session'
  | 'unauthorized_asset'
  | 'unsafe_source_path'
  | 'source_missing'
  | 'source_revision_mismatch'
  | 'source_metadata_invalid'
  | 'unsupported_image'
  | 'svg_external_resource'
  | 'decode_failed'
  | 'encode_failed'
  | 'generation_timeout'
  | 'cache_write_failed'
  | 'cache_cleared';

export type ImageThumbnailResult =
  | {
      ok: true;
      url: string;
      cacheKey: string;
      sourceRevision: string;
      profile: ImageThumbnailProfile;
      width: number;
      height: number;
      cacheStatus: 'hit' | 'generated';
      sourceLimited: boolean;
      cacheEpoch: number;
    }
  | {
      ok: false;
      errorCode: ImageThumbnailErrorCode;
      message: string;
      retryable: boolean;
      cacheEpoch: number;
    };

export interface ImageThumbnailPrewarmRequest {
  projectGeneration: string;
  sources: ImageThumbnailSource[];
}

export type ImageThumbnailPrewarmResult =
  | { ok: true; accepted: number; deduplicated: number; rejected: number }
  | { ok: false; message: string };

export interface CancelImageThumbnailPrewarmRequest {
  projectGeneration: string;
}

export type CancelImageThumbnailPrewarmResult =
  | { ok: true; canceled: number }
  | { ok: false; message: string };

export interface EditorCacheEpochEvent {
  cacheEpoch: number;
}

export type ClearEditorCacheResult =
  | { ok: true; cacheEpoch: number }
  | { ok: false; message: string; cacheEpoch: number };

const canonicalContentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const boundedPathSchema = z.string().min(1).max(32_768);
const boundedAssetIdSchema = z.string().min(1).max(256);

export const imageThumbnailSourceSchema = z
  .object({
    projectSessionId: z.string().uuid(),
    assetId: boundedAssetIdSchema,
    projectRelativePath: boundedPathSchema,
    contentHash: canonicalContentHashSchema.optional(),
    width: z.number().int().min(1).max(65_535),
    height: z.number().int().min(1).max(65_535),
    orientation: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
      z.literal(8),
    ]),
    sampling: z.enum(['linear', 'nearest']).optional(),
  })
  .strict();

export const imageThumbnailVariantSchema = z
  .object({ kind: z.literal('profile'), profile: z.enum(['list', 'wide', 'card']) })
  .strict();

export const imageThumbnailRequestSchema = z
  .object({ source: imageThumbnailSourceSchema, variant: imageThumbnailVariantSchema })
  .strict();

const projectGenerationSchema = z.string().min(1).max(512);

export const imageThumbnailPrewarmRequestSchema = z
  .object({
    projectGeneration: projectGenerationSchema,
    sources: z.array(z.unknown()).max(IMAGE_THUMBNAIL_MAX_PREWARM_BATCH_SIZE),
  })
  .strict();

export const cancelImageThumbnailPrewarmRequestSchema = z
  .object({ projectGeneration: projectGenerationSchema })
  .strict();

export const parseImageThumbnailRequest = (value: unknown): ImageThumbnailRequest =>
  imageThumbnailRequestSchema.parse(value) as ImageThumbnailRequest;

export const parseImageThumbnailPrewarmRequest = (value: unknown): ImageThumbnailPrewarmRequest => {
  const envelope = imageThumbnailPrewarmRequestSchema.parse(value);
  return envelope as ImageThumbnailPrewarmRequest;
};

export const parseCancelImageThumbnailPrewarmRequest = (
  value: unknown,
): CancelImageThumbnailPrewarmRequest =>
  cancelImageThumbnailPrewarmRequestSchema.parse(value) as CancelImageThumbnailPrewarmRequest;

export const parseImageThumbnailPrewarmSource = (value: unknown): ImageThumbnailSource =>
  imageThumbnailSourceSchema.parse(value) as ImageThumbnailSource;

export const isCanonicalImageThumbnailContentHash = (value: unknown): value is string =>
  canonicalContentHashSchema.safeParse(value).success;

export function normalizeImageThumbnailSourceDimensions(source: {
  width: number;
  height: number;
  orientation: ImageThumbnailOrientation;
}): { width: number; height: number } {
  return source.orientation >= 5
    ? { width: source.height, height: source.width }
    : { width: source.width, height: source.height };
}

export interface ResolvedImageThumbnailProfile {
  profile: ImageThumbnailProfile;
  width: number;
  height: number;
  fit: 'cover';
  sourceLimited: boolean;
}

export function resolveImageThumbnailProfile(
  source: Pick<ImageThumbnailSource, 'width' | 'height' | 'orientation'>,
  profile: ImageThumbnailProfile,
  sourceKind: 'raster' | 'svg',
): ResolvedImageThumbnailProfile {
  const target = IMAGE_THUMBNAIL_PROFILES[profile];
  const normalized = normalizeImageThumbnailSourceDimensions(source);
  return {
    profile,
    ...target,
    sourceLimited:
      sourceKind === 'raster' &&
      (normalized.width < target.width || normalized.height < target.height),
  };
}

export function imageThumbnailOutputDimensions(
  source: Pick<ImageThumbnailSource, 'width' | 'height' | 'orientation'>,
  profile: ImageThumbnailProfile,
  sourceKind: 'raster' | 'svg',
): { width: number; height: number } {
  const target = IMAGE_THUMBNAIL_PROFILES[profile];
  if (sourceKind === 'svg') return { width: target.width, height: target.height };
  const normalized = normalizeImageThumbnailSourceDimensions(source);
  return {
    width: Math.min(normalized.width, target.width),
    height: Math.min(normalized.height, target.height),
  };
}

export interface ImageThumbnailGeneratorIdentity {
  sharpVersion: string;
  vipsVersion: string;
}

export function imageThumbnailEncoderPolicy(source: {
  sampling?: ImageThumbnailSampling;
}): 'webp-lossless-effort-4-nearest-v1' | 'webp-quality-85-alpha-100-smart-effort-4-v1' {
  return source.sampling === 'nearest'
    ? 'webp-lossless-effort-4-nearest-v1'
    : 'webp-quality-85-alpha-100-smart-effort-4-v1';
}

export function serializeImageThumbnailDerivativeIdentity(
  source: Pick<
    ImageThumbnailSource,
    'contentHash' | 'width' | 'height' | 'orientation' | 'sampling'
  > & { contentHash: string },
  profile: ImageThumbnailProfile,
  versions: ImageThumbnailGeneratorIdentity,
): string {
  if (!isCanonicalImageThumbnailContentHash(source.contentHash)) {
    throw new TypeError('Image thumbnail content hash must use canonical SHA-256 spelling.');
  }
  const target = IMAGE_THUMBNAIL_PROFILES[profile];
  return JSON.stringify([
    'noveltea.editor.image-thumbnail',
    2,
    source.contentHash,
    source.width,
    source.height,
    source.orientation,
    source.sampling ?? 'linear',
    profile,
    target.width,
    target.height,
    target.fit,
    `sharp:${versions.sharpVersion}`,
    `vips:${versions.vipsVersion}`,
    'srgb-v1',
    imageThumbnailEncoderPolicy(source),
    'autorotate-v1',
    'first-frame-v1',
    'svg-self-contained-density-v2',
  ]);
}

export async function createImageThumbnailDerivativeKey(
  source: Parameters<typeof serializeImageThumbnailDerivativeIdentity>[0],
  profile: ImageThumbnailProfile,
  versions: ImageThumbnailGeneratorIdentity,
): Promise<string> {
  return sha256HexUtf8(serializeImageThumbnailDerivativeIdentity(source, profile, versions));
}
