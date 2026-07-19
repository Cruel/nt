import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { generateAppIcons } from '../../main/services/icon-generation-service';

const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);

async function fixture(options: { width?: number; height?: number; inset?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-icons-'));
  roots.push(root);
  const width = options.width ?? 1024;
  const height = options.height ?? 1024;
  const inset = options.inset ?? 0;
  const source = path.join(root, 'source.png');
  await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}"><rect x="${inset}" y="${inset}" width="${width - inset * 2}" height="${height - inset * 2}" fill="#7c3aed"/></svg>`,
        ),
      },
    ])
    .png()
    .toFile(source);
  return { root, source, staging: path.join(root, 'stage') };
}

describe('icon generation service', () => {
  it('generates the complete platform icon manifest from a 1024 square source', async () => {
    const { source, staging } = await fixture({ inset: 200 });
    const result = await generateAppIcons({
      sourcePath: source,
      stagingRoot: staging,
      backgroundColor: '#112233',
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: 'web', kind: 'favicon' }),
        expect.objectContaining({ platform: 'android', kind: 'legacy' }),
        expect.objectContaining({ platform: 'android', kind: 'adaptive-xml' }),
        expect.objectContaining({ platform: 'windows', kind: 'ico' }),
        expect.objectContaining({ platform: 'macos', kind: 'icns' }),
      ]),
    );
    expect(fs.readFileSync(path.join(staging, 'windows/app.ico')).subarray(0, 4)).toEqual(
      Buffer.from([0, 0, 1, 0]),
    );
    expect(
      fs.readFileSync(path.join(staging, 'macos/AppIcon.icns')).subarray(0, 4).toString(),
    ).toBe('icns');
    expect(
      fs.readFileSync(path.join(staging, 'android/res/mipmap-anydpi-v26/ic_launcher.xml'), 'utf8'),
    ).toContain('<adaptive-icon');
  });

  it('reports source quality and mask-safe-area diagnostics', async () => {
    const { source, staging } = await fixture({ width: 640, height: 480 });
    const result = await generateAppIcons({
      sourcePath: source,
      stagingRoot: staging,
      platforms: ['web', 'android'],
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['non-square-source', 'undersized-source', 'unsafe-icon-content']),
    );
  });

  it('copies explicit native overrides without generating those containers', async () => {
    const { root, source, staging } = await fixture({ inset: 200 });
    const ico = path.join(root, 'custom.ico');
    const icns = path.join(root, 'custom.icns');
    fs.writeFileSync(ico, 'custom-ico');
    fs.writeFileSync(icns, 'custom-icns');
    const result = await generateAppIcons({
      sourcePath: source,
      stagingRoot: staging,
      platforms: ['windows', 'macos'],
      overrides: { windowsIco: ico, macosIcns: icns },
    });
    expect(result.files.every(({ source: provenance }) => provenance === 'override')).toBe(true);
    expect(fs.readFileSync(path.join(staging, 'windows/app.ico'), 'utf8')).toBe('custom-ico');
    expect(fs.readFileSync(path.join(staging, 'macos/AppIcon.icns'), 'utf8')).toBe('custom-icns');
  });
});
