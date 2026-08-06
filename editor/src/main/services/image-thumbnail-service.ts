import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type {
  CancelImageThumbnailPrewarmResult,
  ImageThumbnailErrorCode,
  ImageThumbnailPrewarmRequest,
  ImageThumbnailPrewarmResult,
  ImageThumbnailRequest,
  ImageThumbnailResult,
} from '../../shared/image-thumbnails';
import {
  createImageThumbnailDerivativeKey,
  imageThumbnailEncoderPolicy,
  imageThumbnailOutputDimensions,
  parseCancelImageThumbnailPrewarmRequest,
  parseImageThumbnailPrewarmRequest,
  parseImageThumbnailPrewarmSource,
  parseImageThumbnailRequest,
  resolveImageThumbnailProfile,
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
  cacheKey?: string;
  projectGeneration?: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
};

export type ImageThumbnailServiceInstrumentation = {
  onGenerationPipelineCountChanged?: (activePipelines: number) => void;
  onGenerationAdmitted?: (priority: Priority, cacheKey: string) => void;
};

export type ImageThumbnailServiceOptions = {
  generationTimeoutMs?: number;
  instrumentation?: ImageThumbnailServiceInstrumentation;
};

type PreparedHashlessRequest =
  | { ok: true; request: ImageThumbnailRequest }
  | { ok: false; result: ImageThumbnailResult };

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const MAX_INPUT_PIXELS = 268_402_689;
const GENERATION_TIMEOUT_MS = 30_000;
const PREWARM_ADMISSION_CONCURRENCY = 8;
const ORPHAN_TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
const CACHE_WRITE_ERROR_CODES = new Set(['EACCES', 'EDQUOT', 'ENOSPC', 'EPERM', 'EROFS']);

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

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function ensureCacheDirectory(
  parentPath: string,
  name: string,
  containmentRootRealPath: string,
): Promise<string> {
  const directoryPath = path.join(parentPath, name);
  try {
    await fs.mkdir(directoryPath);
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error;
  }
  const [entry, realPath] = await Promise.all([
    fs.lstat(directoryPath),
    fs.realpath(directoryPath),
  ]);
  if (!entry.isDirectory() || !isStrictlyContainedPath(containmentRootRealPath, realPath)) {
    throw new Error('cache_write_failed');
  }
  return realPath;
}

export class ImageThumbnailService {
  readonly cache: EditorCacheService;
  readonly imageCacheRoot: string;
  readonly #interactiveQueue: Task<unknown>[] = [];
  readonly #prewarmQueue: Task<unknown>[] = [];
  readonly #inFlight = new Map<string, Promise<ImageThumbnailResult>>();
  readonly #hashlessInFlight = new Map<string, Promise<ImageThumbnailResult>>();
  readonly #activeSettlements = new Map<number, Set<Promise<unknown>>>();
  readonly #prewarmSignatures = new Set<string>();
  readonly #generationTimeoutMs: number;
  readonly #instrumentation?: ImageThumbnailServiceInstrumentation;
  #prewarmAdmissionTail: Promise<void> = Promise.resolve();
  #activeProjectGeneration: string | null = null;
  #active = 0;
  #activeGenerationPipelines = 0;

  constructor(editorCacheRoot: string, options: ImageThumbnailServiceOptions = {}) {
    this.cache = new EditorCacheService(editorCacheRoot);
    this.imageCacheRoot = resolveImageThumbnailCacheRoot(editorCacheRoot);
    this.#generationTimeoutMs = options.generationTimeoutMs ?? GENERATION_TIMEOUT_MS;
    this.#instrumentation = options.instrumentation;
  }

  async removeObsoleteCacheVersions(): Promise<void> {
    await fs.rm(path.join(path.dirname(this.imageCacheRoot), 'image-v1'), {
      recursive: true,
      force: true,
    });
  }

  request(
    value: unknown,
    priority: Priority = 'interactive',
    projectGeneration?: string,
  ): Promise<ImageThumbnailResult> {
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
      const pending = this.#enqueue(
        priority,
        this.cache.epoch,
        () => this.#prepareHashlessRequest(request),
        projectGeneration,
      ).then((prepared) =>
        prepared.ok
          ? this.#requestCanonical(prepared.request, priority, projectGeneration)
          : prepared.result,
      );
      this.#hashlessInFlight.set(provisional, pending);
      void pending.finally(() => this.#hashlessInFlight.delete(provisional));
      return pending;
    }
    return this.#requestCanonical(request, priority, projectGeneration);
  }

  async prewarm(value: unknown): Promise<ImageThumbnailPrewarmResult> {
    if (this.cache.isClearing) {
      return { ok: false, message: 'Editor cache is clearing.' };
    }
    let request;
    try {
      request = parseImageThumbnailPrewarmRequest(value);
    } catch {
      return { ok: false, message: 'Invalid thumbnail prewarm request.' };
    }

    if (this.#activeProjectGeneration !== request.projectGeneration) {
      if (this.#activeProjectGeneration) this.#cancelPrewarmQueue(this.#activeProjectGeneration);
      this.#activeProjectGeneration = request.projectGeneration;
      this.#prewarmSignatures.clear();
    }

    const admission = this.#prewarmAdmissionTail.then(() => this.#admitPrewarm(request));
    this.#prewarmAdmissionTail = admission.then(
      () => undefined,
      () => undefined,
    );
    return admission;
  }

  async #admitPrewarm(request: ImageThumbnailPrewarmRequest): Promise<ImageThumbnailPrewarmResult> {
    let accepted = 0;
    let deduplicated = 0;
    let rejected = 0;
    let cursor = 0;
    const admit = async () => {
      while (cursor < request.sources.length) {
        if (this.cache.isClearing || this.#activeProjectGeneration !== request.projectGeneration) {
          rejected += request.sources.length - cursor;
          cursor = request.sources.length;
          return;
        }
        const sourceValue = request.sources[cursor++];
        let source;
        try {
          source = parseImageThumbnailPrewarmSource(sourceValue);
        } catch {
          rejected += 1;
          continue;
        }
        if (!source.contentHash) {
          rejected += 1;
          continue;
        }
        const signature = JSON.stringify([
          source.projectFilePath,
          source.projectRelativePath,
          source.contentHash,
          source.width,
          source.height,
          source.orientation,
          source.sampling ?? 'linear',
        ]);
        if (this.#prewarmSignatures.has(signature)) {
          deduplicated += 1;
          continue;
        }
        const thumbnailRequest: ImageThumbnailRequest = {
          source,
          variant: { kind: 'profile', profile: 'list' },
        };
        if (await this.#validateRequestSource(thumbnailRequest)) {
          rejected += 1;
          continue;
        }
        if (this.cache.isClearing || this.#activeProjectGeneration !== request.projectGeneration) {
          rejected += 1;
          continue;
        }
        const sourceKind =
          path.extname(source.projectRelativePath).toLowerCase() === '.svg' ? 'svg' : 'raster';
        const profile = resolveImageThumbnailProfile(
          source,
          thumbnailRequest.variant.profile,
          sourceKind,
        );
        const key = createImageThumbnailDerivativeKey(
          { ...source, contentHash: source.contentHash },
          profile.profile,
          {
            sharpVersion: sharp.versions.sharp,
            vipsVersion: sharp.versions.vips,
          },
        );
        if (await this.#cacheHit(thumbnailRequest, key)) {
          this.#prewarmSignatures.add(signature);
          deduplicated += 1;
          continue;
        }
        this.#prewarmSignatures.add(signature);
        accepted += 1;
        void this.request(thumbnailRequest, 'prewarm', request.projectGeneration);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(PREWARM_ADMISSION_CONCURRENCY, request.sources.length) },
        admit,
      ),
    );
    return { ok: true, accepted, deduplicated, rejected };
  }

  cancelPrewarm(value: unknown): CancelImageThumbnailPrewarmResult {
    let request;
    try {
      request = parseCancelImageThumbnailPrewarmRequest(value);
    } catch {
      return { ok: false, message: 'Invalid thumbnail prewarm cancellation request.' };
    }
    const canceled = this.#cancelPrewarmQueue(request.projectGeneration);
    if (this.#activeProjectGeneration === request.projectGeneration) {
      this.#activeProjectGeneration = null;
      this.#prewarmSignatures.clear();
    }
    return { ok: true, canceled };
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
        this.#prewarmSignatures.clear();
      },
    );
  }

  async #requestCanonical(
    request: ImageThumbnailRequest,
    priority: Priority,
    projectGeneration?: string,
  ): Promise<ImageThumbnailResult> {
    if (this.cache.isClearing) {
      return failure(this.cache.epoch, 'cache_cleared', 'Editor cache is clearing.');
    }
    const sourceFailure = await this.#validateRequestSource(request);
    if (sourceFailure) return sourceFailure;
    const sourceKind =
      path.extname(request.source.projectRelativePath).toLowerCase() === '.svg' ? 'svg' : 'raster';
    const profile = resolveImageThumbnailProfile(
      request.source,
      request.variant.profile,
      sourceKind,
    );
    const key = createImageThumbnailDerivativeKey(
      { ...request.source, contentHash: request.source.contentHash! },
      profile.profile,
      { sharpVersion: sharp.versions.sharp, vipsVersion: sharp.versions.vips },
    );
    const existing = this.#inFlight.get(key);
    if (existing) {
      if (priority === 'interactive') this.#promoteQueuedPrewarm(key);
      return existing;
    }
    const pending = this.#cacheHit(request, key).then(
      (hit) =>
        hit ??
        this.#enqueue(
          priority,
          this.cache.epoch,
          () => this.#generate(request, priority, key),
          projectGeneration,
          key,
        ),
    );
    this.#inFlight.set(key, pending);
    void pending.finally(() => this.#inFlight.delete(key));
    return pending;
  }

  #enqueue<T>(
    priority: Priority,
    epoch: number,
    run: () => Promise<T>,
    projectGeneration?: string,
    cacheKey?: string,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const task: Task<T> = { priority, epoch, cacheKey, projectGeneration, run, resolve };
      (priority === 'interactive' ? this.#interactiveQueue : this.#prewarmQueue).push(
        task as Task<unknown>,
      );
      this.#drain();
    });
  }

  #promoteQueuedPrewarm(cacheKey: string): void {
    const index = this.#prewarmQueue.findIndex((task) => task.cacheKey === cacheKey);
    if (index < 0) return;
    const [task] = this.#prewarmQueue.splice(index, 1);
    if (!task) return;
    task.priority = 'interactive';
    this.#interactiveQueue.push(task);
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
      if (task.cacheKey)
        this.#instrumentation?.onGenerationAdmitted?.(task.priority, task.cacheKey);
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

  #cancelPrewarmQueue(projectGeneration: string): number {
    let canceled = 0;
    for (let index = this.#prewarmQueue.length - 1; index >= 0; index -= 1) {
      const task = this.#prewarmQueue[index];
      if (task?.projectGeneration !== projectGeneration) continue;
      this.#prewarmQueue.splice(index, 1);
      task.resolve(failure(this.cache.epoch, 'cache_cleared', 'Thumbnail prewarm was canceled.'));
      canceled += 1;
    }
    return canceled;
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

  async #validateRequestSource(
    request: ImageThumbnailRequest,
  ): Promise<ImageThumbnailResult | null> {
    try {
      await this.#resolveSource(request);
      return null;
    } catch (error) {
      if (error instanceof Error && error.message === 'unsafe_source_path') {
        return failure(this.cache.epoch, 'unsafe_source_path', 'Unsafe thumbnail source path.');
      }
      if (errnoCode(error) === 'ENOENT' || errnoCode(error) === 'ENOTDIR') {
        return failure(this.cache.epoch, 'source_missing', 'Thumbnail source is missing.');
      }
      return failure(this.cache.epoch, 'source_missing', 'Thumbnail source is unavailable.');
    }
  }

  async #prepareHashlessRequest(request: ImageThumbnailRequest): Promise<PreparedHashlessRequest> {
    const epoch = this.cache.epoch;
    try {
      const sourcePath = await this.#resolveSource(request);
      const extension = path.extname(request.source.projectRelativePath).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        return {
          ok: false,
          result: failure(epoch, 'unsupported_image', 'Unsupported image format.'),
        };
      }
      const bytes = await fs.readFile(sourcePath);
      const sourceRevision = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
      return {
        ok: true,
        request: {
          ...request,
          source: { ...request.source, contentHash: sourceRevision },
        },
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'unsafe_source_path') {
        return {
          ok: false,
          result: failure(epoch, 'unsafe_source_path', 'Unsafe thumbnail source path.'),
        };
      }
      if (errnoCode(error) === 'ENOENT' || errnoCode(error) === 'ENOTDIR') {
        return {
          ok: false,
          result: failure(epoch, 'source_missing', 'Thumbnail source is missing.'),
        };
      }
      return {
        ok: false,
        result: failure(epoch, 'decode_failed', 'Image source could not be read.'),
      };
    }
  }

  async #cacheHit(
    request: ImageThumbnailRequest,
    key: string,
  ): Promise<ImageThumbnailResult | null> {
    try {
      await this.#resolveSource(request);
      const target = resolveImageThumbnailCachePath(this.imageCacheRoot, key);
      const [rootRealPath, targetRealPath, stat, targetEntry] = await Promise.all([
        fs.realpath(this.imageCacheRoot),
        fs.realpath(target),
        fs.stat(target),
        fs.lstat(target),
      ]);
      if (
        !stat.isFile() ||
        !targetEntry.isFile() ||
        !isStrictlyContainedPath(rootRealPath, targetRealPath)
      )
        return null;
      const sourceKind =
        path.extname(request.source.projectRelativePath).toLowerCase() === '.svg'
          ? 'svg'
          : 'raster';
      const profile = resolveImageThumbnailProfile(
        request.source,
        request.variant.profile,
        sourceKind,
      );
      const dimensions = imageThumbnailOutputDimensions(
        request.source,
        profile.profile,
        sourceKind,
      );
      return {
        ok: true,
        url: createImageThumbnailUrl(key, this.cache.epoch),
        cacheKey: key,
        sourceRevision: request.source.contentHash!,
        profile: profile.profile,
        width: dimensions.width,
        height: dimensions.height,
        cacheStatus: 'hit',
        sourceLimited: profile.sourceLimited,
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
    key: string,
  ): Promise<ImageThumbnailResult> {
    const epoch = this.cache.epoch;
    let tempPath: string | undefined;
    let stage: 'source' | 'decode' | 'encode' | 'cache' = 'source';
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
      const profile = resolveImageThumbnailProfile(
        canonicalRequest.source,
        canonicalRequest.variant.profile,
        sourceKind,
      );
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
                  (72 * Math.max(profile.width, profile.height)) /
                    Math.max(request.source.width, request.source.height),
                ),
              ),
            )
          : undefined;
      stage = 'decode';
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
        profile.profile,
        sourceKind,
      );
      stage = 'cache';
      await fs.mkdir(this.cache.root, { recursive: true });
      const [editorCacheRootEntry, editorCacheRootRealPath] = await Promise.all([
        fs.lstat(this.cache.root),
        fs.realpath(this.cache.root),
      ]);
      if (!editorCacheRootEntry.isDirectory()) {
        throw new Error('cache_write_failed');
      }
      const thumbnailsRootRealPath = await ensureCacheDirectory(
        editorCacheRootRealPath,
        'thumbnails',
        editorCacheRootRealPath,
      );
      const imageCacheRootRealPath = await ensureCacheDirectory(
        thumbnailsRootRealPath,
        'image-v2',
        editorCacheRootRealPath,
      );
      const cacheDirectoryRealPath = await ensureCacheDirectory(
        imageCacheRootRealPath,
        key.slice(0, 2),
        editorCacheRootRealPath,
      );
      await this.#removeCrashOrphanTempFiles(cacheDirectoryRealPath);
      const target = resolveImageThumbnailCachePath(imageCacheRootRealPath, key);
      tempPath = path.join(
        cacheDirectoryRealPath,
        `.${key}.${process.pid}.${crypto.randomUUID()}.tmp`,
      );
      stage = 'encode';
      let pipeline = sharp(bytes, {
        animated: false,
        pages: 1,
        page: 0,
        density,
        limitInputPixels: MAX_INPUT_PIXELS,
      })
        .rotate()
        .toColorspace('srgb')
        .resize(dimensions.width, dimensions.height, {
          fit: profile.fit,
          position: 'centre',
          withoutEnlargement: sourceKind === 'raster',
          kernel:
            request.source.sampling === 'nearest' ? sharp.kernel.nearest : sharp.kernel.lanczos3,
        });
      pipeline =
        imageThumbnailEncoderPolicy(request.source) === 'webp-lossless-effort-4-nearest-v1'
          ? pipeline.webp({ lossless: true, effort: 4 })
          : pipeline.webp({
              quality: 85,
              alphaQuality: 100,
              smartSubsample: true,
              effort: 4,
            });
      this.#activeGenerationPipelines += 1;
      this.#instrumentation?.onGenerationPipelineCountChanged?.(this.#activeGenerationPipelines);
      const pipelineSettlement = pipeline.toFile(tempPath).finally(() => {
        this.#activeGenerationPipelines -= 1;
        this.#instrumentation?.onGenerationPipelineCountChanged?.(this.#activeGenerationPipelines);
      });
      let timeout: NodeJS.Timeout | undefined;
      const timed = await Promise.race([
        pipelineSettlement.then(() => 'done' as const),
        new Promise<'timeout'>((resolve) => {
          timeout = setTimeout(() => resolve('timeout'), this.#generationTimeoutMs);
          timeout.unref();
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (timed === 'timeout') {
        pipeline.destroy();
        await pipelineSettlement.catch(() => undefined);
        return failure(epoch, 'generation_timeout', 'Thumbnail generation timed out.');
      }
      if (epoch !== this.cache.epoch || this.cache.isClearing) {
        return failure(this.cache.epoch, 'cache_cleared', 'Editor cache was cleared.');
      }
      stage = 'cache';
      let cacheStatus: 'hit' | 'generated' = 'generated';
      try {
        await fs.link(tempPath, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        cacheStatus = 'hit';
      }
      const [publishedRealPath, publishedStat, publishedEntry] = await Promise.all([
        fs.realpath(target),
        fs.stat(target),
        fs.lstat(target),
      ]);
      if (
        !publishedStat.isFile() ||
        !publishedEntry.isFile() ||
        !isStrictlyContainedPath(imageCacheRootRealPath, publishedRealPath)
      ) {
        throw new Error('cache_write_failed');
      }
      await fs.rm(tempPath, { force: true });
      tempPath = undefined;
      return {
        ok: true,
        url: createImageThumbnailUrl(key, epoch),
        cacheKey: key,
        sourceRevision,
        profile: profile.profile,
        width: dimensions.width,
        height: dimensions.height,
        cacheStatus,
        sourceLimited: profile.sourceLimited,
        cacheEpoch: epoch,
      };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'svg_external_resource')
        return failure(epoch, 'svg_external_resource', 'SVG contains an external resource.');
      if (code === 'unsafe_source_path')
        return failure(epoch, 'unsafe_source_path', 'Unsafe thumbnail source path.');
      if (
        code === 'cache_write_failed' ||
        stage === 'cache' ||
        (stage === 'encode' && CACHE_WRITE_ERROR_CODES.has(errnoCode(error) ?? ''))
      )
        return failure(epoch, 'cache_write_failed', 'Thumbnail cache write failed.');
      if (stage === 'source' && (errnoCode(error) === 'ENOENT' || errnoCode(error) === 'ENOTDIR'))
        return failure(epoch, 'source_missing', 'Thumbnail source is missing.');
      if (stage === 'encode') return failure(epoch, 'encode_failed', 'Thumbnail encoding failed.');
      return failure(
        epoch,
        'decode_failed',
        priority === 'prewarm' ? 'Thumbnail generation failed.' : 'Image could not be decoded.',
      );
    } finally {
      if (tempPath) await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  async #removeCrashOrphanTempFiles(cacheDirectoryRealPath: string): Promise<void> {
    const cutoff = Date.now() - ORPHAN_TEMP_FILE_MAX_AGE_MS;
    const entries = await fs.readdir(cacheDirectoryRealPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.startsWith('.') || !entry.name.endsWith('.tmp')) return;
        const candidate = path.join(cacheDirectoryRealPath, entry.name);
        const stat = await fs.stat(candidate).catch(() => null);
        if (!stat || stat.mtimeMs > cutoff) return;
        await fs.rm(candidate, { force: true }).catch(() => undefined);
      }),
    );
  }
}
