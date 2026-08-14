import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createImageThumbnailProtocolHandler,
  createImageThumbnailUrl,
} from '../../main/image-thumbnail-protocol';
import { ImageThumbnailService } from '../../main/services/image-thumbnail-service';
import { createImageThumbnailDerivativeKey } from '../../shared/image-thumbnails';

const temporaryRoots: string[] = [];

async function fixtureProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noveltea-thumbnail-'));
  temporaryRoots.push(root);
  const projectFilePath = path.join(root, 'project.json');
  const assetDirectory = path.join(root, 'assets', 'images');
  await fs.mkdir(assetDirectory, { recursive: true });
  await fs.writeFile(projectFilePath, '{}');
  return { root, projectFilePath, assetDirectory, cacheRoot: path.join(root, 'cache') };
}

async function writeRaster(
  directory: string,
  name = 'source.png',
  alpha = 128,
): Promise<{ filePath: string; bytes: Buffer; hash: string }> {
  const bytes = await sharp({
    create: {
      width: 8,
      height: 4,
      channels: 4,
      background: { r: 12, g: 34, b: 56, alpha: alpha / 255 },
    },
  })
    .png()
    .toBuffer();
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, bytes);
  return {
    filePath,
    bytes,
    hash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
  };
}

function cachedPath(service: ImageThumbnailService, cacheKey: string): string {
  return path.join(service.imageCacheRoot, cacheKey.slice(0, 2), `${cacheKey}.webp`);
}

async function firstPixel(filePath: string): Promise<number[]> {
  return [...(await sharp(filePath).ensureAlpha().raw().toBuffer()).subarray(0, 4)];
}

async function runPublicationWorker(workerPath: string, target: string, marker: string) {
  return new Promise<{ status: string; bytes: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, target, marker], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(stderr || `worker exited ${code}`));
      resolve(JSON.parse(stdout) as { status: string; bytes: string });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('main-process image thumbnail service', () => {
  it('generates one lossy-alpha WebP and returns a disk hit', async () => {
    const fixture = await fixtureProject();
    const source = await writeRaster(fixture.assetDirectory);
    const service = new ImageThumbnailService(fixture.cacheRoot);
    const request = {
      source: {
        projectFilePath: fixture.projectFilePath,
        projectRelativePath: 'assets/images/source.png',
        contentHash: source.hash,
        width: 8,
        height: 4,
        orientation: 1 as const,
      },
      variant: { kind: 'profile' as const, profile: 'list' as const },
    };

    const [first, concurrent] = await Promise.all([
      service.request(request),
      service.request(request),
    ]);
    expect(first.ok).toBe(true);
    expect(concurrent).toEqual(first);
    if (!first.ok) return;
    expect(first.cacheStatus).toBe('generated');
    expect(first.width).toBe(8);
    expect(first.height).toBe(4);
    const cachedPath = path.join(
      service.imageCacheRoot,
      first.cacheKey.slice(0, 2),
      `${first.cacheKey}.webp`,
    );
    const metadata = await sharp(cachedPath).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.space).toBe('srgb');
    expect(metadata.hasAlpha).toBe(true);
    const pixel = await sharp(cachedPath).ensureAlpha().raw().toBuffer();
    expect(pixel[3]).toBeGreaterThan(120);
    expect(pixel[3]).toBeLessThan(136);

    const second = await service.request(request);
    expect(second.ok && second.cacheStatus).toBe('hit');
  });

  it('makes photographic card thumbnails smaller than their JPEG source', async () => {
    const fixture = await fixtureProject();
    const width = 340;
    const height = 576;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        pixels[offset] = (x * 7 + y * 3 + ((x * y) % 97)) % 256;
        pixels[offset + 1] = (x * 2 + y * 11) % 256;
        pixels[offset + 2] = (x * 13 + y * 5) % 256;
      }
    }
    const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 80 })
      .toBuffer();
    await fs.writeFile(path.join(fixture.assetDirectory, 'photo.jpg'), bytes);
    const service = new ImageThumbnailService(fixture.cacheRoot);
    const result = await service.request({
      source: {
        projectFilePath: fixture.projectFilePath,
        projectRelativePath: 'assets/images/photo.jpg',
        contentHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
        width,
        height,
        orientation: 1,
      },
      variant: { kind: 'profile', profile: 'card' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const thumbnail = await fs.readFile(cachedPath(service, result.cacheKey));
    expect([result.width, result.height]).toEqual([320, 320]);
    expect(thumbnail.byteLength).toBeLessThan(bytes.byteLength);
  });

  it('keeps nearest-neighbor assets lossless', async () => {
    const fixture = await fixtureProject();
    const width = 96;
    const height = 72;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const light = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
        pixels[offset] = light ? 255 : 0;
        pixels[offset + 1] = light ? 32 : 224;
        pixels[offset + 2] = light ? 64 : 16;
        pixels[offset + 3] = light ? 255 : 128;
      }
    }
    const bytes = await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    await fs.writeFile(path.join(fixture.assetDirectory, 'pixel.png'), bytes);
    const service = new ImageThumbnailService(fixture.cacheRoot);
    const result = await service.request({
      source: {
        projectFilePath: fixture.projectFilePath,
        projectRelativePath: 'assets/images/pixel.png',
        contentHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
        width,
        height,
        orientation: 1,
        sampling: 'nearest',
      },
      variant: { kind: 'profile', profile: 'list' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = await sharp(cachedPath(service, result.cacheKey)).ensureAlpha().raw().toBuffer();
    expect(output).toEqual(pixels);
  });

  it('removes only the retired image-v1 cache subtree', async () => {
    const fixture = await fixtureProject();
    const service = new ImageThumbnailService(fixture.cacheRoot);
    const v1 = path.join(fixture.cacheRoot, 'thumbnails', 'image-v1');
    const v2 = service.imageCacheRoot;
    await fs.mkdir(v1, { recursive: true });
    await fs.mkdir(v2, { recursive: true });
    await fs.writeFile(path.join(v1, 'retired.webp'), 'old');
    await fs.writeFile(path.join(v2, 'current.webp'), 'current');

    await service.removeObsoleteCacheVersions();

    await expect(fs.stat(v1)).rejects.toThrow();
    await expect(fs.readFile(path.join(v2, 'current.webp'), 'utf8')).resolves.toBe('current');
  });

  it('deduplicates hashless requests and rejects revision or metadata mismatch without publication', async () => {
    const fixture = await fixtureProject();
    const source = await writeRaster(fixture.assetDirectory);
    const service = new ImageThumbnailService(fixture.cacheRoot);
    const base = {
      source: {
        projectFilePath: fixture.projectFilePath,
        projectRelativePath: 'assets/images/source.png',
        width: 8,
        height: 4,
        orientation: 1 as const,
      },
      variant: { kind: 'profile' as const, profile: 'list' as const },
    };
    const [left, right] = await Promise.all([service.request(base), service.request(base)]);
    expect(left).toEqual(right);
    expect(left.ok && left.sourceRevision).toBe(source.hash);

    const cardRequest = {
      ...base,
      variant: { kind: 'profile' as const, profile: 'card' as const },
    };
    const [hashless, canonical] = await Promise.all([
      service.request(cardRequest),
      service.request({
        ...cardRequest,
        source: { ...cardRequest.source, contentHash: source.hash },
      }),
    ]);
    expect(hashless).toEqual(canonical);
    expect(hashless.ok && hashless.cacheStatus).toBe('generated');

    const revisionMismatch = await service.request({
      ...base,
      source: { ...base.source, contentHash: `sha256:${'0'.repeat(64)}` },
    });
    expect(revisionMismatch.ok || revisionMismatch.errorCode).toBe('source_revision_mismatch');
    const metadataMismatch = await service.request({
      ...base,
      source: { ...base.source, contentHash: source.hash, width: 7 },
    });
    expect(metadataMismatch.ok || metadataMismatch.errorCode).toBe('source_metadata_invalid');
  });

  it('rasterizes self-contained SVG and fails closed for external resources and BMP', async () => {
    const fixture = await fixtureProject();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><rect width="4" height="2" fill="#f00"/></svg>',
    );
    await fs.writeFile(path.join(fixture.assetDirectory, 'safe.svg'), svg);
    const unsafeSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><image href="file:///tmp/secret.png"/></svg>',
    );
    await fs.writeFile(path.join(fixture.assetDirectory, 'unsafe.svg'), unsafeSvg);
    await fs.writeFile(
      path.join(fixture.assetDirectory, 'legacy.bmp'),
      Buffer.from('BMnot-supported'),
    );
    const service = new ImageThumbnailService(fixture.cacheRoot);
    const requestFor = (name: string, bytes: Buffer) => ({
      source: {
        projectFilePath: fixture.projectFilePath,
        projectRelativePath: `assets/images/${name}`,
        contentHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
        width: 4,
        height: 2,
        orientation: 1 as const,
      },
      variant: { kind: 'profile' as const, profile: 'card' as const },
    });
    const safe = await service.request(requestFor('safe.svg', svg));
    expect(safe.ok && [safe.width, safe.height]).toEqual([320, 320]);
    const unsafe = await service.request(requestFor('unsafe.svg', unsafeSvg));
    expect(unsafe.ok || unsafe.errorCode).toBe('svg_external_resource');
    const bmp = await service.request(requestFor('legacy.bmp', Buffer.from('BMnot-supported')));
    expect(bmp.ok || bmp.errorCode).toBe('unsupported_image');
  });

  it('publishes the production first frame for GIF, APNG-under-png, and animated WebP', async () => {
    const fixture = await fixtureProject();
    const frameWidth = 2;
    const frameHeight = 2;
    const frames = Buffer.alloc(frameWidth * frameHeight * 4 * 2);
    for (let pixel = 0; pixel < frameWidth * frameHeight; pixel += 1) {
      frames[pixel * 4] = 255;
      frames[pixel * 4 + 3] = 255;
    }
    for (let pixel = frameWidth * frameHeight; pixel < frameWidth * frameHeight * 2; pixel += 1) {
      frames[pixel * 4 + 1] = 255;
      frames[pixel * 4 + 3] = 255;
    }
    const gif = await sharp(frames, {
      raw: { width: frameWidth, height: frameHeight * 2, channels: 4, pageHeight: frameHeight },
    })
      .gif({ delay: [100, 100], loop: 0 })
      .toBuffer();
    const webp = await sharp(frames, {
      raw: { width: frameWidth, height: frameHeight * 2, channels: 4, pageHeight: frameHeight },
    })
      .webp({ delay: [100, 100], loop: 0 })
      .toBuffer();
    const apng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAACGFjVEwAAAAGAAAAAAYNNbAAAAAaZmNUTAAAAAAAAAACAAAAAgAAAAAAAAAAAAEAGQAA9jTBKQAAABBJREFUeJxj+MfACEQMEAoAH+YD/ZCXc2YAAAAaZmNUTAAAAAEAAAABAAAAAQAAAAAAAAAAAAEAGQAA32zHLQAAABBmZEFUAAAAAnicY/jHwAgAAv8BAJGYHZAAAAAaZmNUTAAAAAMAAAABAAAAAQAAAAAAAAAAAAEAGQAAMvoUxAAAABBmZEFUAAAABHicY/jHwAgAAv8BADF9wk0AAAAaZmNUTAAAAAUAAAACAAAAAgAAAAAAAAAAAAEAGQAAbRuKbgAAABNmZEFUAAAABnicY2D4zwBCEAoAG/ID/Xb2qxwAAAAaZmNUTAAAAAcAAAABAAAAAQAAAAAAAAAAAAEAGQAAMqa1VwAAABBmZEFUAAAACHicY2D4zwAAAgIBACFgyEYAAAAaZmNUTAAAAAkAAAABAAAAAQAAAAAAAAAAAAEAGQAA39WECwAAABBmZEFUAAAACnicY2D4zwAAAgIBAEE8fQ0AAAAASUVORK5CYII=',
      'base64',
    );
    const cases = [
      ['animated.gif', gif],
      ['animated.png', apng],
      ['animated.webp', webp],
    ] as const;
    const service = new ImageThumbnailService(fixture.cacheRoot);
    for (const [name, bytes] of cases) {
      await fs.writeFile(path.join(fixture.assetDirectory, name), bytes);
      const result = await service.request({
        source: {
          projectFilePath: fixture.projectFilePath,
          projectRelativePath: `assets/images/${name}`,
          contentHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
          width: 2,
          height: 2,
          orientation: 1,
        },
        variant: { kind: 'profile', profile: 'list' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const pixel = await firstPixel(cachedPath(service, result.cacheKey));
      expect(pixel[0]).toBeGreaterThan(200);
      expect(pixel[1]).toBeLessThan(40);
      expect(
        (await sharp(cachedPath(service, result.cacheKey), { animated: true }).metadata()).pages,
      ).toBeUndefined();
    }
  });

  it('honors every EXIF orientation combination', async () => {
    const fixture = await fixtureProject();
    const raw = Buffer.from([
      255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255,
    ]);
    const service = new ImageThumbnailService(fixture.cacheRoot);
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      const bytes = await sharp(raw, { raw: { width: 3, height: 2, channels: 3 } })
        .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
        .withMetadata({ orientation })
        .toBuffer();
      const name = `orientation-${orientation}.jpg`;
      await fs.writeFile(path.join(fixture.assetDirectory, name), bytes);
      const result = await service.request({
        source: {
          projectFilePath: fixture.projectFilePath,
          projectRelativePath: `assets/images/${name}`,
          contentHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
          width: 3,
          height: 2,
          orientation: orientation as 1,
        },
        variant: { kind: 'profile', profile: 'list' },
      });
      expect(result.ok, `orientation ${orientation}`).toBe(true);
      if (!result.ok) continue;
      expect([result.width, result.height]).toEqual(orientation >= 5 ? [2, 3] : [3, 2]);
    }
  });

  it('rasterizes viewBox-only SVG at list, wide, and card profiles', async () => {
    const fixture = await fixtureProject();
    const bytes = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 2"><rect width="4" height="2" fill="#0f0"/></svg>',
    );
    await fs.writeFile(path.join(fixture.assetDirectory, 'viewbox.svg'), bytes);
    const service = new ImageThumbnailService(fixture.cacheRoot);
    for (const [profile, expected] of [
      ['list', [96, 72]],
      ['wide', [160, 96]],
      ['card', [320, 320]],
    ] as const) {
      const result = await service.request({
        source: {
          projectFilePath: fixture.projectFilePath,
          projectRelativePath: 'assets/images/viewbox.svg',
          contentHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
          width: 4,
          height: 2,
          orientation: 1,
        },
        variant: { kind: 'profile', profile },
      });
      expect(result.ok && [result.width, result.height]).toEqual(expected);
    }
  });

  it('advances cache epoch, joins concurrent clears, and removes published files', async () => {
    const fixture = await fixtureProject();
    const source = await writeRaster(fixture.assetDirectory);
    const service = new ImageThumbnailService(fixture.cacheRoot);
    const generated = await service.request({
      source: {
        projectFilePath: fixture.projectFilePath,
        projectRelativePath: 'assets/images/source.png',
        contentHash: source.hash,
        width: 8,
        height: 4,
        orientation: 1,
      },
      variant: { kind: 'profile', profile: 'list' },
    });
    expect(generated.ok).toBe(true);
    const [first, second] = await Promise.all([
      service.clearEditorCache(),
      service.clearEditorCache(),
    ]);
    expect(first).toEqual(second);
    expect(first).toEqual({ ok: true, cacheEpoch: 1 });
    await expect(fs.stat(service.imageCacheRoot)).rejects.toThrow();
  });

  it('admits list-profile prewarm work incrementally and rejects hashless or missing sources', async () => {
    const fixture = await fixtureProject();
    const source = await writeRaster(fixture.assetDirectory);
    const service = new ImageThumbnailService(fixture.cacheRoot);
    const validSource = {
      projectFilePath: fixture.projectFilePath,
      projectRelativePath: 'assets/images/source.png',
      contentHash: source.hash,
      width: 8,
      height: 4,
      orientation: 1 as const,
    };

    const first = await service.prewarm({
      projectGeneration: 'generation-a',
      sources: [
        validSource,
        { ...validSource, contentHash: undefined },
        { ...validSource, projectRelativePath: 'assets/images/missing.png' },
      ],
    });
    expect(first).toEqual({ ok: true, accepted: 1, deduplicated: 0, rejected: 2 });

    const second = await service.prewarm({
      projectGeneration: 'generation-a',
      sources: [validSource],
    });
    expect(second).toEqual({ ok: true, accepted: 0, deduplicated: 1, rejected: 0 });

    const canceled = service.cancelPrewarm({ projectGeneration: 'generation-a' });
    expect(canceled.ok).toBe(true);
    await service.request({
      source: validSource,
      variant: { kind: 'profile', profile: 'list' },
    });
  });

  it('does not admit new prewarm batches while the editor cache is clearing', async () => {
    const fixture = await fixtureProject();
    const source = await writeRaster(fixture.assetDirectory);
    const service = new ImageThumbnailService(fixture.cacheRoot);
    let release!: () => void;
    const clearing = service.cache.clear(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      () => undefined,
    );

    const result = await service.prewarm({
      projectGeneration: 'generation-a',
      sources: [
        {
          projectFilePath: fixture.projectFilePath,
          projectRelativePath: 'assets/images/source.png',
          contentHash: source.hash,
          width: 8,
          height: 4,
          orientation: 1,
        },
      ],
    });
    expect(result).toEqual({ ok: false, message: 'Editor cache is clearing.' });
    release();
    await clearing;
  });

  it('keeps filesystem admission bounded across concurrent prewarm batches', async () => {
    const fixture = await fixtureProject();
    const generated = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        writeRaster(fixture.assetDirectory, `source-${index}.png`),
      ),
    );
    const service = new ImageThumbnailService(fixture.cacheRoot);
    const sources = generated.map((source, index) => ({
      projectFilePath: fixture.projectFilePath,
      projectRelativePath: `assets/images/source-${index}.png`,
      contentHash: source.hash,
      width: 8,
      height: 4,
      orientation: 1 as const,
    }));
    const sourcePaths = new Set(generated.map((source) => source.filePath));
    const originalStat = fs.stat.bind(fs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let activeSourceStats = 0;
    let maximumSourceStats = 0;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (filePath) => {
      if (!sourcePaths.has(String(filePath))) return originalStat(filePath);
      activeSourceStats += 1;
      maximumSourceStats = Math.max(maximumSourceStats, activeSourceStats);
      await gate;
      try {
        return await originalStat(filePath);
      } finally {
        activeSourceStats -= 1;
      }
    });

    const first = service.prewarm({
      projectGeneration: 'generation-a',
      sources: sources.slice(0, 8),
    });
    const second = service.prewarm({
      projectGeneration: 'generation-a',
      sources: sources.slice(8),
    });
    while (activeSourceStats < 8) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(maximumSourceStats).toBe(8);
    release();

    expect(await first).toEqual({ ok: true, accepted: 8, deduplicated: 0, rejected: 0 });
    expect(await second).toEqual({ ok: true, accepted: 8, deduplicated: 0, rejected: 0 });
    statSpy.mockRestore();
    await Promise.all(
      sources.map((source) =>
        service.request({
          source,
          variant: { kind: 'profile', profile: 'list' },
        }),
      ),
    );
  });

  it('publishes immutably across service instances and rejects cache-directory escapes', async () => {
    const fixture = await fixtureProject();
    const source = await writeRaster(fixture.assetDirectory);
    const request = {
      source: {
        projectFilePath: fixture.projectFilePath,
        projectRelativePath: 'assets/images/source.png',
        contentHash: source.hash,
        width: 8,
        height: 4,
        orientation: 1 as const,
      },
      variant: { kind: 'profile' as const, profile: 'list' as const },
    };
    const firstService = new ImageThumbnailService(fixture.cacheRoot);
    const secondService = new ImageThumbnailService(fixture.cacheRoot);
    const [first, second] = await Promise.all([
      firstService.request(request),
      secondService.request(request),
    ]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect([first.cacheStatus, second.cacheStatus].sort()).toEqual(['generated', 'hit']);
    expect(first.cacheKey).toBe(second.cacheKey);

    await fs.rm(fixture.cacheRoot, { recursive: true, force: true });
    const escapedService = new ImageThumbnailService(fixture.cacheRoot);
    const key = await createImageThumbnailDerivativeKey(request.source, 'list', {
      sharpVersion: sharp.versions.sharp,
      vipsVersion: sharp.versions.vips,
    });
    const outside = path.join(fixture.root, 'outside-cache');
    await fs.mkdir(escapedService.imageCacheRoot, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(
      outside,
      path.join(escapedService.imageCacheRoot, key.slice(0, 2)),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const escaped = await escapedService.request(request);
    expect(escaped.ok || escaped.errorCode).toBe('cache_write_failed');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('publishes one immutable winner from two actual Node processes', async () => {
    const fixture = await fixtureProject();
    const target = path.join(fixture.root, 'cross-process.webp');
    const worker = path.resolve('scripts/image-thumbnail-publication-worker.mjs');
    const [left, right] = await Promise.all([
      runPublicationWorker(worker, target, 'left'),
      runPublicationWorker(worker, target, 'right'),
    ]);
    expect([left.status, right.status].sort()).toEqual(['generated', 'hit']);
    const published = await fs.readFile(target, 'utf8');
    expect(['left', 'right']).toContain(published);
    expect(left.bytes).toBe(published);
    expect(right.bytes).toBe(published);
  });

  it('promotes a queued prewarm derivative and never owns more than two Sharp pipelines', async () => {
    const fixture = await fixtureProject();
    const generated = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        sharp({
          create: {
            width: 2048,
            height: 2048,
            channels: 4,
            background: { r: index * 20, g: 30, b: 40, alpha: 1 },
          },
        })
          .png()
          .toBuffer()
          .then(async (bytes) => {
            const name = `large-${index}.png`;
            await fs.writeFile(path.join(fixture.assetDirectory, name), bytes);
            return {
              projectFilePath: fixture.projectFilePath,
              projectRelativePath: `assets/images/${name}`,
              contentHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
              width: 2048,
              height: 2048,
              orientation: 1 as const,
            };
          }),
      ),
    );
    const admitted: Array<{ priority: string; key: string }> = [];
    let maximumPipelines = 0;
    const originalReadFile = fs.readFile.bind(fs);
    let releaseFirstTwo!: () => void;
    const firstTwoGate = new Promise<void>((resolve) => {
      releaseFirstTwo = resolve;
    });
    const blockedPaths = new Set(
      generated.slice(0, 2).map((source) => path.join(fixture.root, source.projectRelativePath)),
    );
    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, options) => {
      if (typeof filePath === 'string' && blockedPaths.has(filePath)) await firstTwoGate;
      return originalReadFile(filePath, options as never);
    });
    const service = new ImageThumbnailService(fixture.cacheRoot, {
      instrumentation: {
        onGenerationAdmitted: (priority, key) => admitted.push({ priority, key }),
        onGenerationPipelineCountChanged: (count) => {
          maximumPipelines = Math.max(maximumPipelines, count);
        },
      },
    });
    await service.prewarm({ projectGeneration: 'generation-a', sources: generated });
    while (admitted.length < 2) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const promoted = service.request({
      source: generated[3]!,
      variant: { kind: 'profile', profile: 'list' },
    });
    releaseFirstTwo();
    await Promise.all(
      generated.map((source) =>
        service.request({ source, variant: { kind: 'profile', profile: 'list' } }),
      ),
    );
    expect((await promoted).ok).toBe(true);
    expect(maximumPipelines).toBeLessThanOrEqual(2);
    const promotedKey = await createImageThumbnailDerivativeKey(generated[3]!, 'list', {
      sharpVersion: sharp.versions.sharp,
      vipsVersion: sharp.versions.vips,
    });
    expect(admitted.find((entry) => entry.key === promotedKey)?.priority).toBe('interactive');
    readFileSpy.mockRestore();
  });

  it('destroys a timed-out Sharp pipeline before releasing its scheduler ownership', async () => {
    const fixture = await fixtureProject();
    const bytes = await sharp({
      create: { width: 4096, height: 4096, channels: 4, background: '#123456' },
    })
      .png()
      .toBuffer();
    await fs.writeFile(path.join(fixture.assetDirectory, 'timeout.png'), bytes);
    const counts: number[] = [];
    const service = new ImageThumbnailService(fixture.cacheRoot, {
      generationTimeoutMs: 1,
      instrumentation: { onGenerationPipelineCountChanged: (count) => counts.push(count) },
    });
    const result = await service.request({
      source: {
        projectFilePath: fixture.projectFilePath,
        projectRelativePath: 'assets/images/timeout.png',
        contentHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
        width: 4096,
        height: 4096,
        orientation: 1,
      },
      variant: { kind: 'profile', profile: 'card' },
    });
    expect(result.ok || result.errorCode).toBe('generation_timeout');
    expect(counts.at(-1)).toBe(0);
    expect(Math.max(...counts)).toBeLessThanOrEqual(1);
  });

  it('accepts in-root source links, rejects escaping links, and reuses renamed content', async () => {
    const fixture = await fixtureProject();
    const source = await writeRaster(fixture.assetDirectory, 'original.png');
    await fs.symlink(source.filePath, path.join(fixture.assetDirectory, 'linked.png'));
    const outside = path.join(fixture.root, '..', `outside-${crypto.randomUUID()}.png`);
    await fs.writeFile(outside, source.bytes);
    temporaryRoots.push(outside);
    await fs.symlink(outside, path.join(fixture.assetDirectory, 'escaped.png'));
    const service = new ImageThumbnailService(fixture.cacheRoot);
    const requestFor = (name: string) => ({
      source: {
        projectFilePath: fixture.projectFilePath,
        projectRelativePath: `assets/images/${name}`,
        contentHash: source.hash,
        width: 8,
        height: 4,
        orientation: 1 as const,
      },
      variant: { kind: 'profile' as const, profile: 'list' as const },
    });
    const linked = await service.request(requestFor('linked.png'));
    expect(linked.ok).toBe(true);
    const escaped = await service.request(requestFor('escaped.png'));
    expect(escaped.ok || escaped.errorCode).toBe('unsafe_source_path');
    await fs.rename(source.filePath, path.join(fixture.assetDirectory, 'renamed.png'));
    const renamed = await service.request(requestFor('renamed.png'));
    expect(renamed.ok && linked.ok && renamed.cacheKey).toBe(linked.ok && linked.cacheKey);
    expect(renamed.ok && renamed.cacheStatus).toBe('hit');
  });

  it('keeps the old derivative until explicit reimport publishes a new revision', async () => {
    const fixture = await fixtureProject();
    const first = await writeRaster(fixture.assetDirectory, 'reimport.png', 255);
    const service = new ImageThumbnailService(fixture.cacheRoot);
    const requestFor = (hash: string) => ({
      source: {
        projectFilePath: fixture.projectFilePath,
        projectRelativePath: 'assets/images/reimport.png',
        contentHash: hash,
        width: 8,
        height: 4,
        orientation: 1 as const,
      },
      variant: { kind: 'profile' as const, profile: 'list' as const },
    });
    const oldResult = await service.request(requestFor(first.hash));
    expect(oldResult.ok).toBe(true);
    const replacement = await writeRaster(fixture.assetDirectory, 'reimport.png', 64);
    const stale = await service.request(requestFor(first.hash));
    expect(stale.ok && oldResult.ok && stale.cacheKey).toBe(oldResult.ok && oldResult.cacheKey);
    const current = await service.request(requestFor(replacement.hash));
    expect(current.ok).toBe(true);
    if (!oldResult.ok || !current.ok) return;
    expect(current.cacheKey).not.toBe(oldResult.cacheKey);
    await expect(fs.stat(cachedPath(service, oldResult.cacheKey))).resolves.toBeDefined();
    await expect(fs.stat(cachedPath(service, current.cacheKey))).resolves.toBeDefined();
  });

  it('rejects extreme raster dimensions before publication', async () => {
    const fixture = await fixtureProject();
    const bytes = await sharp({
      create: { width: 1, height: 1, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    // Rewrite IHDR dimensions beyond the production 268,402,689-pixel decompression boundary.
    bytes.writeUInt32BE(20_000, 16);
    bytes.writeUInt32BE(20_000, 20);
    await fs.writeFile(path.join(fixture.assetDirectory, 'extreme.png'), bytes);
    const service = new ImageThumbnailService(fixture.cacheRoot);
    const result = await service.request({
      source: {
        projectFilePath: fixture.projectFilePath,
        projectRelativePath: 'assets/images/extreme.png',
        contentHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
        width: 20_000,
        height: 20_000,
        orientation: 1,
      },
      variant: { kind: 'profile', profile: 'list' },
    });
    expect(result.ok || result.errorCode).toBe('decode_failed');
    await expect(fs.stat(service.imageCacheRoot)).rejects.toThrow();
  });

  it('cancels queued work and waits for active work when clearing', async () => {
    const fixture = await fixtureProject();
    const base = await sharp({
      create: { width: 4096, height: 4096, channels: 4, background: '#234567' },
    })
      .png()
      .toBuffer();
    const sources = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const bytes = Buffer.concat([base, Buffer.from(`clear-${index}`)]);
        const name = `clear-${index}.png`;
        await fs.writeFile(path.join(fixture.assetDirectory, name), bytes);
        return {
          projectFilePath: fixture.projectFilePath,
          projectRelativePath: `assets/images/${name}`,
          contentHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
          width: 4096,
          height: 4096,
          orientation: 1 as const,
        };
      }),
    );
    let admitted = 0;
    const service = new ImageThumbnailService(fixture.cacheRoot, {
      instrumentation: { onGenerationAdmitted: () => (admitted += 1) },
    });
    const prewarm = await service.prewarm({ projectGeneration: 'clear-backlog', sources });
    expect(prewarm.ok && prewarm.accepted).toBe(12);
    const clearing = service.clearEditorCache();
    expect(await clearing).toEqual({ ok: true, cacheEpoch: 1 });
    expect(admitted).toBeLessThan(12);
    await expect(fs.stat(service.imageCacheRoot)).rejects.toThrow();
  }, 30_000);

  it('removes old crash-orphan temp files and advances the epoch after failed deletion', async () => {
    const fixture = await fixtureProject();
    const source = await writeRaster(fixture.assetDirectory);
    const service = new ImageThumbnailService(fixture.cacheRoot);
    const request = {
      source: {
        projectFilePath: fixture.projectFilePath,
        projectRelativePath: 'assets/images/source.png',
        contentHash: source.hash,
        width: 8,
        height: 4,
        orientation: 1 as const,
      },
      variant: { kind: 'profile' as const, profile: 'list' as const },
    };
    const key = await createImageThumbnailDerivativeKey(request.source, 'list', {
      sharpVersion: sharp.versions.sharp,
      vipsVersion: sharp.versions.vips,
    });
    const directory = path.join(service.imageCacheRoot, key.slice(0, 2));
    await fs.mkdir(directory, { recursive: true });
    const orphan = path.join(directory, `.${key}.999.orphan.tmp`);
    await fs.writeFile(orphan, 'orphan');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(orphan, old, old);
    expect((await service.request(request)).ok).toBe(true);
    await expect(fs.stat(orphan)).rejects.toThrow();

    const epochs: number[] = [];
    service.cache.onEpochChanged((epoch) => epochs.push(epoch));
    const originalRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === fixture.cacheRoot) throw new Error('forced deletion failure');
      return originalRm(target, options);
    });
    const cleared = await service.clearEditorCache();
    rmSpy.mockRestore();
    expect(cleared).toEqual({ ok: false, message: 'forced deletion failure', cacheEpoch: 1 });
    expect(epochs).toEqual([1]);
  });
});

describe('thumbnail protocol', () => {
  it('serves only valid content-keyed WebP paths and rejects traversal', async () => {
    const fixture = await fixtureProject();
    const imageRoot = path.join(fixture.cacheRoot, 'thumbnails', 'image-v2');
    const key = 'ab'.padEnd(64, '1');
    const target = path.join(imageRoot, 'ab', `${key}.webp`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
        .webp()
        .toBuffer(),
    );
    const handler = createImageThumbnailProtocolHandler(imageRoot);
    const response = await handler(new Request(createImageThumbnailUrl(key, 2)));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const head = await handler(new Request(createImageThumbnailUrl(key, 2), { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(
      (
        await handler(
          new Request('noveltea-thumbnail://cache/image-v2/ab/%2e%2e%2fsecret.webp?epoch=0'),
        )
      ).status,
    ).toBe(400);
    expect((await handler(new Request(`${createImageThumbnailUrl(key, 2)}&extra=1`))).status).toBe(
      400,
    );
    expect(
      (await handler(new Request(createImageThumbnailUrl(key, 2), { method: 'POST' }))).status,
    ).toBe(405);

    const linkedKey = 'cd'.padEnd(64, '2');
    const linkedTarget = path.join(imageRoot, 'cd', `${linkedKey}.webp`);
    await fs.mkdir(path.dirname(linkedTarget), { recursive: true });
    await fs.symlink(target, linkedTarget, process.platform === 'win32' ? 'file' : undefined);
    expect((await handler(new Request(createImageThumbnailUrl(linkedKey, 2)))).status).toBe(404);
  });
});
