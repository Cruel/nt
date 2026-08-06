import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type {
  ImageThumbnailErrorCode,
  ImageThumbnailRequest,
  ImageThumbnailResult,
} from '../../shared/image-thumbnails';
import {
  createImageThumbnailDerivativeKey,
  imageThumbnailOutputDimensions,
  parseImageThumbnailRequest,
  selectImageThumbnailTier,
} from '../../shared/image-thumbnails';
import { isSafeProjectAssetPath } from '../../shared/project-schema/authoring-assets';
import { createImageThumbnailUrl } from '../image-thumbnail-protocol';
import { EditorCacheService } from './editor-cache-service';
import {
  isStrictlyContainedPath,
  resolveImageThumbnailCachePath,
  resolveImageThumbnailCacheRoot,
} from './image-thumbnail-cache-paths';

type Priority = 'interactive' | 'prewarm';
type Task<T> = {
  priority: Priority;
  epoch: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
};

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const MAX_INPUT_PIXELS = 268_402_689;
const GENERATION_TIMEOUT_MS = 30_000;

function failure(
  cacheEpoch: number,
  errorCode: ImageThumbnailErrorCode,
  message: string,
): ImageThumbnailResult {
  return {
    ok: false,
    errorCode,
    message,
    retryable: ['cache_cleared', 'generation_timeout', 'cache_write_failed'].includes(errorCode),
    cacheEpoch,
  };
}

function validateSvg(bytes: Buffer): void {
  const text = bytes.toString('utf8');
  const forbidden = [
    /<!DOCTYPE/i,
    /<!ENTITY/i,
    /<\?xml-stylesheet/i,
    /\bxml:base\s*=/i,
    /<script\b/i,
    /@import\b/i,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) throw new Error('svg_external_resource');
  const references = [
    ...text.matchAll(/(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi),
    ...text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi),
  ];
  if (references.some((match) => !(match[2] ?? '').trim().startsWith('#'))) {
    throw new Error('svg_external_resource');
  }
}

function detectedFormatMatches(extension: string, format?: string): boolean {
  if (!format) return false;
  if (extension === '.jpg' || extension === '.jpeg') return format === 'jpeg';
  return format === extension.slice(1);
}

export class ImageThumbnailService {
  readonly cache: EditorCacheService;
  readonly imageCacheRoot: string;
  readonly #interactiveQueue: Task<unknown>[] = [];
  readonly #prewarmQueue: Task<unknown>[] = [];
  readonly #inFlight = new Map<string, Promise<ImageThumbnailResult>>();
  readonly #hashlessInFlight = new Map<string, Promise<ImageThumbnailResult>>();
  readonly #activeSettlements = new Map<number, Set<Promise<unknown>>>();
  #active = 0;

  constructor(editorCacheRoot: string) {
    this.cache = new EditorCacheService(editorCacheRoot);
    this.imageCacheRoot = resolveImageThumbnailCacheRoot(editorCacheRoot);
  }

  request(value: unknown, priority: Priority = 'interactive'): Promise<ImageThumbnailResult> {
    if (this.cache.isClearing) {
      return Promise.resolve(
        failure(this.cache.epoch, 'cache_cleared', 'Editor cache is clearing.'),
      );
    }
    let request: ImageThumbnailRequest;
    try {
      request = parseImageThumbnailRequest(value);
    } catch {
      return Promise.resolve(
        failure(this.cache.epoch, 'invalid_request', 'Invalid thumbnail request.'),
      );
    }
    if (!request.source.contentHash) {
      const provisional = JSON.stringify([
        request.source.projectFilePath,
        request.source.projectRelativePath,
        request.source.width,
        request.source.height,
        request.source.orientation,
        request.variant,
      ]);
      const existing = this.#hashlessInFlight.get(provisional);
      if (existing) return existing;
      const pending = this.#enqueue(priority, this.cache.epoch, () =>
        this.#generate(request, priority),
      );
      this.#hashlessInFlight.set(provisional, pending);
      void pending.finally(() => this.#hashlessInFlight.delete(provisional));
      return pending;
    }
    return this.#requestCanonical(request, priority);
  }

  async clearEditorCache(): Promise<{ ok: boolean; message?: string; cacheEpoch: number }> {
    const oldEpoch = this.cache.epoch;
    this.#cancelQueued(oldEpoch);
    return this.cache.clear(
      async (epoch) => {
        const active = this.#activeSettlements.get(epoch);
        if (active) await Promise.allSettled(active);
      },
      () => {
        this.#inFlight.clear();
        this.#hashlessInFlight.clear();
      },
    );
  }

  #requestCanonical(
    request: ImageThumbnailRequest,
    priority: Priority,
  ): Promise<ImageThumbnailResult> {
    const sourceKind =
      path.extname(request.source.projectRelativePath).toLowerCase() === '.svg' ? 'svg' : 'raster';
    const tier = selectImageThumbnailTier(request.source, request.variant, sourceKind);
    const key = createImageThumbnailDerivativeKey(
      { ...request.source, contentHash: request.source.contentHash! },
      tier.tierLongEdge as 192 | 384 | 1024,
      { sharpVersion: sharp.versions.sharp, vipsVersion: sharp.versions.vips },
    );
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    const pending = this.#cacheHit(request, key).then(
      (hit) =>
        hit ??
        this.#enqueue(priority, this.cache.epoch, () => this.#generate(request, priority, key)),
    );
    this.#inFlight.set(key, pending);
    void pending.finally(() => this.#inFlight.delete(key));
    return pending;
  }

  #enqueue<T>(priority: Priority, epoch: number, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve) => {
      const task: Task<T> = { priority, epoch, run, resolve };
      (priority === 'interactive' ? this.#interactiveQueue : this.#prewarmQueue).push(
        task as Task<unknown>,
      );
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < 2) {
      const task = this.#interactiveQueue.shift() ?? this.#prewarmQueue.shift();
      if (!task) return;
      if (task.epoch !== this.cache.epoch || this.cache.isClearing) {
        task.resolve(failure(this.cache.epoch, 'cache_cleared', 'Editor cache was cleared.'));
        continue;
      }
      this.#active += 1;
      const settlement = task
        .run()
        .then(task.resolve, () =>
          task.resolve(failure(this.cache.epoch, 'decode_failed', 'Thumbnail generation failed.')),
        );
      let activeForEpoch = this.#activeSettlements.get(task.epoch);
      if (!activeForEpoch) {
        activeForEpoch = new Set();
        this.#activeSettlements.set(task.epoch, activeForEpoch);
      }
      activeForEpoch.add(settlement);
      void settlement.finally(() => {
        this.#active -= 1;
        activeForEpoch!.delete(settlement);
        if (activeForEpoch!.size === 0) this.#activeSettlements.delete(task.epoch);
        this.#drain();
      });
    }
  }

  #cancelQueued(epoch: number): void {
    for (const queue of [this.#interactiveQueue, this.#prewarmQueue]) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index]?.epoch !== epoch) continue;
        const [task] = queue.splice(index, 1);
        task?.resolve(failure(this.cache.epoch + 1, 'cache_cleared', 'Editor cache was cleared.'));
      }
    }
  }

  async #resolveSource(request: ImageThumbnailRequest): Promise<string> {
    if (!isSafeProjectAssetPath(request.source.projectRelativePath))
      throw new Error('unsafe_source_path');
    const projectRoot = path.dirname(path.resolve(request.source.projectFilePath));
    const sourcePath = path.resolve(projectRoot, request.source.projectRelativePath);
    if (!isStrictlyContainedPath(projectRoot, sourcePath)) throw new Error('unsafe_source_path');
    const [rootRealPath, sourceRealPath, stat] = await Promise.all([
      fs.realpath(projectRoot),
      fs.realpath(sourcePath),
      fs.stat(sourcePath),
    ]);
    if (!stat.isFile() || !isStrictlyContainedPath(rootRealPath, sourceRealPath)) {
      throw new Error('unsafe_source_path');
    }
    return sourceRealPath;
  }

  async #cacheHit(
    request: ImageThumbnailRequest,
    key: string,
  ): Promise<ImageThumbnailResult | null> {
    try {
      await this.#resolveSource(request);
      const target = resolveImageThumbnailCachePath(this.imageCacheRoot, key);
      const [rootRealPath, targetRealPath, stat] = await Promise.all([
        fs.realpath(this.imageCacheRoot),
        fs.realpath(target),
        fs.stat(target),
      ]);
      if (!stat.isFile() || !isStrictlyContainedPath(rootRealPath, targetRealPath)) return null;
      const sourceKind =
        path.extname(request.source.projectRelativePath).toLowerCase() === '.svg'
          ? 'svg'
          : 'raster';
      const tier = selectImageThumbnailTier(request.source, request.variant, sourceKind);
      const dimensions = imageThumbnailOutputDimensions(
        request.source,
        tier.tierLongEdge,
        sourceKind,
      );
      return {
        ok: true,
        url: createImageThumbnailUrl(key, this.cache.epoch),
        cacheKey: key,
        sourceRevision: request.source.contentHash!,
        profile: tier.profile,
        width: dimensions.width,
        height: dimensions.height,
        cacheStatus: 'hit',
        sourceLimited: tier.sourceLimited,
        tierLimited: tier.tierLimited,
        cacheEpoch: this.cache.epoch,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        ['unsafe_source_path', 'source_missing'].includes(error.message)
      ) {
        return failure(
          this.cache.epoch,
          error.message as ImageThumbnailErrorCode,
          'Thumbnail source is unavailable.',
        );
      }
      return null;
    }
  }

  async #generate(
    request: ImageThumbnailRequest,
    priority: Priority,
    knownKey?: string,
  ): Promise<ImageThumbnailResult> {
    const epoch = this.cache.epoch;
    let tempPath: string | undefined;
    try {
      const sourcePath = await this.#resolveSource(request);
      const extension = path.extname(request.source.projectRelativePath).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(extension))
        return failure(epoch, 'unsupported_image', 'Unsupported image format.');
      const bytes = await fs.readFile(sourcePath);
      const sourceRevision = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
      if (request.source.contentHash && request.source.contentHash !== sourceRevision) {
        return failure(
          epoch,
          'source_revision_mismatch',
          'Image source revision changed; reimport the asset.',
        );
      }
      const canonicalRequest: ImageThumbnailRequest = {
        ...request,
        source: { ...request.source, contentHash: sourceRevision },
      };
      const sourceKind = extension === '.svg' ? 'svg' : 'raster';
      const tier = selectImageThumbnailTier(
        canonicalRequest.source,
        canonicalRequest.variant,
        sourceKind,
      );
      const key =
        knownKey ??
        createImageThumbnailDerivativeKey(
          canonicalRequest.source as typeof canonicalRequest.source & { contentHash: string },
          tier.tierLongEdge as 192 | 384 | 1024,
          { sharpVersion: sharp.versions.sharp, vipsVersion: sharp.versions.vips },
        );
      if (!knownKey) {
        const existing = this.#inFlight.get(key);
        if (existing) return existing;
      }
      const cached = await this.#cacheHit(canonicalRequest, key);
      if (cached) return cached;
      if (sourceKind === 'svg') validateSvg(bytes);
      const density =
        sourceKind === 'svg'
          ? Math.min(
              100_000,
              Math.max(
                1,
                Math.ceil(
                  (72 * tier.tierLongEdge) / Math.max(request.source.width, request.source.height),
                ),
              ),
            )
          : undefined;
      const metadata = await sharp(bytes, {
        animated: false,
        pages: 1,
        page: 0,
        limitInputPixels: MAX_INPUT_PIXELS,
      }).metadata();
      if (!detectedFormatMatches(extension, metadata.format)) {
        return failure(
          epoch,
          'source_metadata_invalid',
          'Image format does not match its filename.',
        );
      }
      const orientation = (metadata.orientation ?? 1) as number;
      if (
        metadata.width !== request.source.width ||
        metadata.height !== request.source.height ||
        orientation !== request.source.orientation
      ) {
        return failure(
          epoch,
          'source_metadata_invalid',
          'Image metadata does not match the project record.',
        );
      }
      const dimensions = imageThumbnailOutputDimensions(
        request.source,
        tier.tierLongEdge,
        sourceKind,
      );
      const target = resolveImageThumbnailCachePath(this.imageCacheRoot, key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      tempPath = path.join(
        path.dirname(target),
        `.${key}.${process.pid}.${crypto.randomUUID()}.tmp`,
      );
      const pipeline = sharp(bytes, {
        animated: false,
        pages: 1,
        page: 0,
        density,
        limitInputPixels: MAX_INPUT_PIXELS,
      })
        .rotate()
        .toColorspace('srgb')
        .resize(dimensions.width, dimensions.height, {
          fit: 'fill',
          withoutEnlargement: sourceKind === 'raster',
        })
        .webp({ lossless: true, effort: 4 })
        .toFile(tempPath);
      const timed = await Promise.race([
        pipeline.then(() => 'done' as const),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), GENERATION_TIMEOUT_MS),
        ),
      ]);
      if (timed === 'timeout') {
        void pipeline.finally(() => tempPath && fs.rm(tempPath, { force: true }));
        return failure(epoch, 'generation_timeout', 'Thumbnail generation timed out.');
      }
      if (epoch !== this.cache.epoch || this.cache.isClearing) {
        return failure(this.cache.epoch, 'cache_cleared', 'Editor cache was cleared.');
      }
      try {
        await fs.link(tempPath, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await fs.rm(tempPath, { force: true });
      tempPath = undefined;
      return {
        ok: true,
        url: createImageThumbnailUrl(key, epoch),
        cacheKey: key,
        sourceRevision,
        profile: tier.profile,
        width: dimensions.width,
        height: dimensions.height,
        cacheStatus: 'generated',
        sourceLimited: tier.sourceLimited,
        tierLimited: tier.tierLimited,
        cacheEpoch: epoch,
      };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'svg_external_resource')
        return failure(epoch, 'svg_external_resource', 'SVG contains an external resource.');
      if (code === 'unsafe_source_path')
        return failure(epoch, 'unsafe_source_path', 'Unsafe thumbnail source path.');
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return failure(epoch, 'source_missing', 'Thumbnail source is missing.');
      if ((error as NodeJS.ErrnoException).code === 'EACCES')
        return failure(epoch, 'cache_write_failed', 'Thumbnail cache write failed.');
      return failure(
        epoch,
        'decode_failed',
        priority === 'prewarm' ? 'Thumbnail generation failed.' : 'Image could not be decoded.',
      );
    } finally {
      if (tempPath) await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}
