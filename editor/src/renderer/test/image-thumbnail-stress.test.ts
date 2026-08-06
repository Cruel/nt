import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vite-plus/test';
import { ImageThumbnailService } from '../../main/services/image-thumbnail-service';

const runStress = process.env.NOVELTEA_RUN_THUMBNAIL_STRESS === '1';
const roots: string[] = [];

async function hash(bytes: Buffer): Promise<string> {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

describe.runIf(runStress)('image thumbnail 500-image stress evidence', () => {
  afterAll(async () => {
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('materializes, opens, prewarms, and measures a representative project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noveltea-thumbnail-stress-'));
    roots.push(root);
    const imageRoot = path.join(root, 'assets', 'images');
    const cacheRoot = path.join(root, 'cache');
    const projectFilePath = path.join(root, 'project.json');
    await fs.mkdir(imageRoot, { recursive: true });

    const templates = await Promise.all([
      sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#345678' } })
        .png()
        .toBuffer(),
      sharp({ create: { width: 3840, height: 2160, channels: 3, background: '#456789' } })
        .jpeg({ quality: 85 })
        .toBuffer(),
      sharp({
        create: {
          width: 1024,
          height: 1024,
          channels: 4,
          background: { r: 80, g: 40, b: 120, alpha: 0.5 },
        },
      })
        .png()
        .toBuffer(),
      sharp({ create: { width: 4096, height: 256, channels: 3, background: '#6789ab' } })
        .webp({ lossless: true })
        .toBuffer(),
      sharp({ create: { width: 256, height: 4096, channels: 3, background: '#789abc' } })
        .png()
        .toBuffer(),
    ]);

    const assets: Record<string, unknown> = {};
    const sources: Array<{
      projectFilePath: string;
      projectRelativePath: string;
      contentHash: string;
      width: number;
      height: number;
      orientation: 1;
    }> = [];
    const dimensions = [
      [1920, 1080],
      [3840, 2160],
      [1024, 1024],
      [4096, 256],
      [256, 4096],
    ] as const;
    const extensions = ['png', 'jpg', 'png', 'webp', 'png'] as const;

    for (let index = 0; index < 500; index += 1) {
      const kind = index % 10 === 0 ? 'svg' : 'raster';
      const templateIndex = index % templates.length;
      const [width, height] = dimensions[templateIndex]!;
      const name = `stress-${String(index).padStart(3, '0')}.${kind === 'svg' ? 'svg' : extensions[templateIndex]}`;
      const bytes =
        kind === 'svg'
          ? Buffer.from(
              `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="rgb(${index % 255},40,80)"/></svg>`,
            )
          : Buffer.concat([templates[templateIndex]!, Buffer.from(`stress-${index}`)]);
      await fs.writeFile(path.join(imageRoot, name), bytes);
      const contentHash = await hash(bytes);
      const relative = `assets/images/${name}`;
      sources.push({
        projectFilePath,
        projectRelativePath: relative,
        contentHash,
        width,
        height,
        orientation: 1,
      });
      assets[`stress-${index}`] = {
        id: `stress-${index}`,
        label: `Stress ${index}`,
        data: {
          kind: 'image',
          source: { type: 'project-file', path: relative },
          aliases: [],
          contentHash,
          imageMetadata: { width, height, hasAlpha: templateIndex === 2, orientation: 1 },
        },
      };
    }
    await fs.writeFile(
      projectFilePath,
      JSON.stringify({ schema: 'noveltea.authoring.project', version: 2, assets }),
    );

    const coldStart = performance.now();
    JSON.parse(await fs.readFile(projectFilePath, 'utf8'));
    const coldOpenMs = performance.now() - coldStart;
    const postOpenRss = process.memoryUsage().rss;
    const warmStart = performance.now();
    JSON.parse(await fs.readFile(projectFilePath, 'utf8'));
    const warmOpenMs = performance.now() - warmStart;

    const service = new ImageThumbnailService(cacheRoot);
    const prewarmStart = performance.now();
    const admission = await service.prewarm({ projectGeneration: 'stress', sources });
    expect(admission.ok).toBe(true);
    const firstViewportStart = performance.now();
    await Promise.all(
      sources
        .slice(0, 20)
        .map((source) =>
          service.request({ source, variant: { kind: 'profile', profile: 'card' } }),
        ),
    );
    const firstVisibleThumbnailMs = performance.now() - firstViewportStart;
    const firstViewportRss = process.memoryUsage().rss;
    await Promise.all(
      sources.map((source) =>
        service.request({ source, variant: { kind: 'profile', profile: 'list' } }),
      ),
    );
    const prewarmCompletionMs = performance.now() - prewarmStart;
    const completedPrewarmRss = process.memoryUsage().rss;

    const warmService = new ImageThumbnailService(cacheRoot);
    const warmThumbnailStart = performance.now();
    await Promise.all(
      sources
        .slice(0, 20)
        .map((source) =>
          warmService.request({ source, variant: { kind: 'profile', profile: 'card' } }),
        ),
    );
    const warmFirstViewportMs = performance.now() - warmThumbnailStart;
    console.log(
      `IMAGE_THUMBNAIL_STRESS_EVIDENCE ${JSON.stringify({
        records: sources.length,
        coldOpenMs: Number(coldOpenMs.toFixed(2)),
        warmOpenMs: Number(warmOpenMs.toFixed(2)),
        prewarmCompletionMs: Number(prewarmCompletionMs.toFixed(2)),
        firstVisibleThumbnailMs: Number(firstVisibleThumbnailMs.toFixed(2)),
        warmFirstViewportMs: Number(warmFirstViewportMs.toFixed(2)),
        mainProcessRssMiB: {
          postOpen: Number((postOpenRss / 1024 / 1024).toFixed(2)),
          firstViewport: Number((firstViewportRss / 1024 / 1024).toFixed(2)),
          completedPrewarm: Number((completedPrewarmRss / 1024 / 1024).toFixed(2)),
        },
      })}`,
    );
    expect(sources).toHaveLength(500);
    expect(prewarmCompletionMs).toBeGreaterThan(firstVisibleThumbnailMs);
  }, 180_000);
});
