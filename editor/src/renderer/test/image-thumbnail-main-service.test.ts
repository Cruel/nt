import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vite-plus/test';
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

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('main-process image thumbnail service', () => {
  it('generates one lossless WebP, preserves alpha, and returns a disk hit', async () => {
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
      variant: { kind: 'profile' as const, profile: 'compact' as const },
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
      variant: { kind: 'profile' as const, profile: 'compact' as const },
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
    expect(safe.ok && [safe.width, safe.height]).toEqual([384, 192]);
    const unsafe = await service.request(requestFor('unsafe.svg', unsafeSvg));
    expect(unsafe.ok || unsafe.errorCode).toBe('svg_external_resource');
    const bmp = await service.request(requestFor('legacy.bmp', Buffer.from('BMnot-supported')));
    expect(bmp.ok || bmp.errorCode).toBe('unsupported_image');
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
      variant: { kind: 'profile', profile: 'compact' },
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
      variant: { kind: 'profile' as const, profile: 'compact' as const },
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
    const key = createImageThumbnailDerivativeKey(request.source, 192, {
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
});

describe('thumbnail protocol', () => {
  it('serves only valid content-keyed WebP paths and rejects traversal', async () => {
    const fixture = await fixtureProject();
    const imageRoot = path.join(fixture.cacheRoot, 'thumbnails', 'image-v1');
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
          new Request('noveltea-thumbnail://cache/image-v1/ab/%2e%2e%2fsecret.webp?epoch=0'),
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
