import { z } from 'zod';
import { sha256HexUtf8 } from './sha256';

export const IMAGE_THUMBNAIL_PROFILES = {
  compact: 192,
  card: 384,
  large: 1024,
} as const;

export const IMAGE_THUMBNAIL_MAX_PREWARM_BATCH_SIZE = 50_000;

export type ImageThumbnailProfile = keyof typeof IMAGE_THUMBNAIL_PROFILES;
export type ImageThumbnailFit = 'cover' | 'contain';
export type ImageThumbnailOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface ImageThumbnailSource {
  projectFilePath: string;
  projectRelativePath: string;
  contentHash?: string;
  width: number;
  height: number;
  orientation: ImageThumbnailOrientation;
}

export type ImageThumbnailVariant =
  | { kind: 'profile'; profile: ImageThumbnailProfile }
  | { kind: 'minimum-size'; widthPx: number; heightPx: number; fit: ImageThumbnailFit };

export interface ImageThumbnailRequest {
  source: ImageThumbnailSource;
  variant: ImageThumbnailVariant;
}

export type ImageThumbnailErrorCode =
  | 'invalid_request'
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
      tierLimited: boolean;
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

export const imageThumbnailSourceSchema = z
  .object({
    projectFilePath: boundedPathSchema,
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
  })
  .strict();

export const imageThumbnailVariantSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile'), profile: z.enum(['compact', 'card', 'large']) }).strict(),
  z
    .object({
      kind: z.literal('minimum-size'),
      widthPx: z.number().int().min(1).max(8192),
      heightPx: z.number().int().min(1).max(8192),
      fit: z.enum(['cover', 'contain']),
    })
    .strict(),
]);

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

export interface ImageThumbnailTierSelection {
  profile: ImageThumbnailProfile;
  tierLongEdge: number;
  normalizedSourceWidth: number;
  normalizedSourceHeight: number;
  requiredLongEdge: number;
  sourceLimited: boolean;
  tierLimited: boolean;
}

export function normalizeImageThumbnailSourceDimensions(source: {
  width: number;
  height: number;
  orientation: ImageThumbnailOrientation;
}): { width: number; height: number } {
  return source.orientation >= 5
    ? { width: source.height, height: source.width }
    : { width: source.width, height: source.height };
}

function profileForRequiredLongEdge(requiredLongEdge: number): ImageThumbnailProfile {
  if (requiredLongEdge <= IMAGE_THUMBNAIL_PROFILES.compact) return 'compact';
  if (requiredLongEdge <= IMAGE_THUMBNAIL_PROFILES.card) return 'card';
  return 'large';
}

export function selectImageThumbnailTier(
  source: Pick<ImageThumbnailSource, 'width' | 'height' | 'orientation'>,
  variant: ImageThumbnailVariant,
  sourceKind: 'raster' | 'svg',
): ImageThumbnailTierSelection {
  const normalized = normalizeImageThumbnailSourceDimensions(source);
  const sourceLongEdge = Math.max(normalized.width, normalized.height);
  if (variant.kind === 'profile') {
    const tierLongEdge = IMAGE_THUMBNAIL_PROFILES[variant.profile];
    return {
      profile: variant.profile,
      tierLongEdge,
      normalizedSourceWidth: normalized.width,
      normalizedSourceHeight: normalized.height,
      requiredLongEdge: tierLongEdge,
      sourceLimited: sourceKind === 'raster' && sourceLongEdge < tierLongEdge,
      tierLimited: false,
    };
  }

  const scale =
    variant.fit === 'cover'
      ? Math.max(variant.widthPx / normalized.width, variant.heightPx / normalized.height)
      : Math.min(variant.widthPx / normalized.width, variant.heightPx / normalized.height);
  const requiredLongEdge = Math.ceil(sourceLongEdge * scale);
  const profile = profileForRequiredLongEdge(requiredLongEdge);
  const tierLongEdge = IMAGE_THUMBNAIL_PROFILES[profile];
  return {
    profile,
    tierLongEdge,
    normalizedSourceWidth: normalized.width,
    normalizedSourceHeight: normalized.height,
    requiredLongEdge,
    sourceLimited: sourceKind === 'raster' && sourceLongEdge < requiredLongEdge,
    tierLimited: requiredLongEdge > IMAGE_THUMBNAIL_PROFILES.large,
  };
}

export function imageThumbnailOutputDimensions(
  source: Pick<ImageThumbnailSource, 'width' | 'height' | 'orientation'>,
  tierLongEdge: number,
  sourceKind: 'raster' | 'svg',
): { width: number; height: number } {
  const normalized = normalizeImageThumbnailSourceDimensions(source);
  const sourceLongEdge = Math.max(normalized.width, normalized.height);
  if (sourceKind === 'raster' && sourceLongEdge <= tierLongEdge) return normalized;
  const scale = tierLongEdge / sourceLongEdge;
  return {
    width: Math.max(1, Math.round(normalized.width * scale)),
    height: Math.max(1, Math.round(normalized.height * scale)),
  };
}

export const clampImageThumbnailDevicePixelRatio = (devicePixelRatio: number): number =>
  Math.min(4, Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1));

export function imageThumbnailPhysicalSlot(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): { widthPx: number; heightPx: number } {
  const dpr = clampImageThumbnailDevicePixelRatio(devicePixelRatio);
  return { widthPx: Math.ceil(cssWidth * dpr), heightPx: Math.ceil(cssHeight * dpr) };
}

export interface ImageThumbnailGeneratorIdentity {
  sharpVersion: string;
  vipsVersion: string;
}

export function serializeImageThumbnailDerivativeIdentity(
  source: Pick<ImageThumbnailSource, 'contentHash' | 'width' | 'height' | 'orientation'> & {
    contentHash: string;
  },
  tierLongEdge: 192 | 384 | 1024,
  versions: ImageThumbnailGeneratorIdentity,
): string {
  if (!isCanonicalImageThumbnailContentHash(source.contentHash)) {
    throw new TypeError('Image thumbnail content hash must use canonical SHA-256 spelling.');
  }
  return JSON.stringify([
    'noveltea.editor.image-thumbnail',
    1,
    source.contentHash,
    source.width,
    source.height,
    source.orientation,
    tierLongEdge,
    `sharp:${versions.sharpVersion}`,
    `vips:${versions.vipsVersion}`,
    'srgb-v1',
    'webp-lossless-effort-4',
    'autorotate-v1',
    'first-frame-v1',
    'svg-self-contained-density-v1',
  ]);
}

export function createImageThumbnailDerivativeKey(
  source: Parameters<typeof serializeImageThumbnailDerivativeIdentity>[0],
  tierLongEdge: 192 | 384 | 1024,
  versions: ImageThumbnailGeneratorIdentity,
): string {
  return sha256HexUtf8(serializeImageThumbnailDerivativeIdentity(source, tierLongEdge, versions));
}
