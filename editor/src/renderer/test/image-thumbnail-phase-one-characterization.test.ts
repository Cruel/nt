import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { CreateRaw } from 'sharp';
import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { useProjectStore } from '@/project/project-store';

const APNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAgAAAAAAAAAAAAEACgAA6FTcAAAAABRJREFUeJxj/M/A8J+BgYGBiQEKAB8XAgJPlM6+AAAAGmZjVEwAAAABAAAAAgAAAAIAAAAAAAAAAAABAAoAAHMnNtQAAAAYZmRBVAAAAAJ4nGNkYPj/n4GBgYGJAQoAHRkCAunm7jEAAAAASUVORK5CYII=',
  'base64',
);

async function animatedFixture(format: 'gif' | 'webp') {
  const raw = Buffer.from([
    255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
    0, 0, 255, 255, 0, 0, 255, 255,
  ]);
  const image = sharp(raw, {
    raw: { width: 2, height: 4, channels: 4, pageHeight: 2 } as CreateRaw,
  });
  return format === 'gif'
    ? image.gif({ delay: [100, 100], loop: 0 }).toBuffer()
    : image.webp({ delay: [100, 100], loop: 0 }).toBuffer();
}

describe('image thumbnail Phase 1 characterization', () => {
  it('locks every current project asset URL consumer to an explicit disposition', () => {
    const consumers = new Map([
      ['src/renderer/editors/assets/AssetPreview.tsx', 'split compact migrate / detail retain'],
      ['src/renderer/editors/comfyui/ImageGenerationEditor.tsx', 'retain'],
      ['src/renderer/components/hotspots/HotspotAuthoringPanel.tsx', 'retain'],
      ['src/renderer/editors/rooms/RoomEditor.tsx', 'retain'],
    ]);
    const sourceRoot = path.resolve('src/renderer');
    const discovered: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (
          entry.isFile() &&
          /\.[cm]?[jt]sx?$/.test(entry.name) &&
          !absolute.includes(`${path.sep}test${path.sep}`)
        ) {
          if (fs.readFileSync(absolute, 'utf8').includes('.resolveProjectAssetUrl(')) {
            discovered.push(path.relative(path.resolve('.'), absolute));
          }
        }
      }
    };
    visit(sourceRoot);
    expect(discovered.sort()).toEqual([...consumers.keys()].sort());
    expect([...consumers.values()]).toEqual([
      'split compact migrate / detail retain',
      'retain',
      'retain',
      'retain',
    ]);
  });

  it('proves packaged Sharp can decode every required V1 input and page zero', async () => {
    const opaque = sharp({
      create: { width: 3, height: 2, channels: 3, background: '#123456' },
    });
    const transparent = sharp({
      create: { width: 3, height: 2, channels: 4, background: '#12345680' },
    });
    const fixtures = {
      png: await transparent.clone().png().toBuffer(),
      jpeg: await opaque.clone().jpeg().toBuffer(),
      transparentWebp: await transparent.clone().webp({ lossless: true }).toBuffer(),
      svg: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><rect width="3" height="2" fill="#123456"/></svg>',
      ),
      gif: await animatedFixture('gif'),
      apng: APNG,
      animatedWebp: await animatedFixture('webp'),
    };
    for (const [name, fixture] of Object.entries(fixtures)) {
      const metadata = await sharp(fixture, { animated: true }).metadata();
      expect(metadata.width, name).toBeGreaterThan(0);
      expect(metadata.height, name).toBeGreaterThan(0);
      const pageZero = await sharp(fixture, { page: 0, pages: 1 })
        .webp({ lossless: true })
        .toBuffer();
      expect((await sharp(pageZero).metadata()).format, name).toBe('webp');
    }
    expect((await sharp(fixtures.gif, { animated: true }).metadata()).pages).toBe(2);
    expect((await sharp(fixtures.apng, { animated: true }).metadata()).format).toBe('png');
    expect((await sharp(fixtures.animatedWebp, { animated: true }).metadata()).pages).toBe(2);
    const bmp = Buffer.from(
      'Qk1OAAAAAAAAADYAAAAoAAAAAwAAAAIAAAABABgAAAAAABgAAADEDgAAxA4AAAAAAAAAAAAAVjQSVjQSVjQSAAAAVjQSVjQSVjQSAAAA',
      'base64',
    );
    expect((sharp.format as unknown as Record<string, unknown>).bmp).toBeUndefined();
    await expect(sharp(bmp).metadata()).rejects.toThrow(/unsupported image format/i);
    await expect(sharp(Buffer.from('corrupt image')).metadata()).rejects.toThrow();
    await expect(
      sharp(path.resolve('missing-image-thumbnail-fixture.png')).metadata(),
    ).rejects.toThrow();
  });

  it('pins project publication and explicit content-hash revision ownership', () => {
    const project = createAuthoringProject();
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/logo.png' },
        aliases: [],
        extension: '.png',
        contentHash: `sha256:${'1'.repeat(64)}`,
        imageMetadata: { width: 3, height: 2, hasAlpha: true, orientation: 1 },
      },
    };
    useProjectStore.getState().clearProject();
    expect(
      useProjectStore.getState().loadProjectDocument({
        document: project,
        projectPath: '/project',
        projectFilePath: '/project/project.json',
      }),
    ).toBe(true);
    const loaded = useProjectStore.getState();
    expect(loaded.projectRevision).toBe(1);
    expect(loaded.lastMutationPublication?.changeSet.kind).toBe('load');
    expect(loaded.lastMutationPublication?.project.assets.logo?.data.contentHash).toBe(
      `sha256:${'1'.repeat(64)}`,
    );

    const auditSource = fs.readFileSync(
      path.resolve('src/main/services/project-asset-audit-service.ts'),
      'utf8',
    );
    expect(auditSource).not.toContain('record.data.contentHash =');
    const reimportSource = fs.readFileSync(
      path.resolve('src/main/services/asset-import-service.ts'),
      'utf8',
    );
    expect(reimportSource).toContain('export async function reimportAsset(');
    expect(reimportSource).toContain('contentHash,');
  });

  it('records pure tier-selection vectors for the next phase', () => {
    expect([
      { name: 'square-cover', source: [1000, 1000], required: [96, 96], fit: 'cover', tier: 192 },
      { name: 'portrait-cover', source: [500, 1000], required: [192, 96], fit: 'cover', tier: 384 },
      {
        name: 'panorama-contain',
        source: [2000, 500],
        required: [192, 96],
        fit: 'contain',
        tier: 192,
      },
      { name: 'low-resolution', source: [64, 32], required: [192, 96], fit: 'contain', tier: 192 },
      { name: 'high-dpr', source: [1000, 1000], required: [384, 384], fit: 'contain', tier: 384 },
    ]).toMatchSnapshot();
  });

  it('keeps rendered-preview thumbnail state outside the direct-image path', () => {
    const manager = fs.readFileSync(
      path.resolve('src/renderer/preview/preview-manager.ts'),
      'utf8',
    );
    const store = fs.readFileSync(
      path.resolve('src/renderer/preview/preview-manager-store.ts'),
      'utf8',
    );
    const rendererSources = fs
      .readdirSync(path.resolve('src/renderer'), { recursive: true })
      .filter(
        (entry): entry is string =>
          typeof entry === 'string' &&
          /\.[jt]sx?$/.test(entry) &&
          !entry.startsWith(`test${path.sep}`),
      )
      .map((entry) => fs.readFileSync(path.resolve('src/renderer', entry), 'utf8'))
      .join('\n');
    expect(manager).toContain('createThumbnailCacheKey');
    expect(store).toContain('requestThumbnail: (input) =>');
    expect(rendererSources).not.toContain('processThumbnailQueue');
    expect(rendererSources).not.toContain('renderThumbnailWorker');
  });
});
