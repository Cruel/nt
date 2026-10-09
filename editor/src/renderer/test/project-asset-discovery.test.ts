import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  auditProjectAssets,
  importUntrackedProjectAssets,
  organizeUntrackedProjectAsset,
} from '../../main/services/project-asset-audit-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

const roots: string[] = [];
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9LQXAAAAAASUVORK5CYII=',
  'base64',
);

async function projectFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-discovery-'));
  roots.push(root);
  await mkdir(path.join(root, 'assets/images'), { recursive: true });
  await mkdir(path.join(root, 'assets/audio'), { recursive: true });
  await mkdir(path.join(root, 'assets/video'), { recursive: true });
  return {
    root,
    projectFilePath: path.join(root, 'project.json'),
    project: createAuthoringProject(),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Project Asset discovery', () => {
  it('suggests only lightly validated media, while leaving other files manually accessible', async () => {
    const { root, projectFilePath, project } = await projectFixture();
    await writeFile(path.join(root, 'assets/images/valid.png'), tinyPng);
    await writeFile(path.join(root, 'assets/images/header-only.png'), tinyPng.subarray(0, 8));
    await writeFile(path.join(root, 'assets/images/bad.jpg'), 'not a JPEG');
    await writeFile(path.join(root, 'assets/audio/noise.mp3'), 'text not an MP3');
    await writeFile(path.join(root, 'assets/audio/truncated.ogg'), 'OggS');
    await writeFile(path.join(root, 'assets/audio/truncated.flac'), 'fLaC');
    await writeFile(path.join(root, 'assets/audio/valid.wav'), 'RIFFxxxxWAVEfmt ');
    await writeFile(
      path.join(root, 'assets/video/clip.mp4'),
      Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]),
    );
    await writeFile(
      path.join(root, 'assets/images/font.ttf'),
      Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...Array.from({ length: 16 }, () => 0)]),
    );
    await writeFile(path.join(root, 'assets/images/README.md'), '# Supporting document');
    const result = await auditProjectAssets(projectFilePath, project);
    expect(result.success).toBe(true);
    expect(
      result.untrackedFiles.map((file) => [file.projectRelativePath, file.importable]),
    ).toEqual([
      ['assets/audio/noise.mp3', false],
      ['assets/audio/truncated.flac', false],
      ['assets/audio/truncated.ogg', false],
      ['assets/audio/valid.wav', true],
      ['assets/images/bad.jpg', false],
      ['assets/images/font.ttf', true],
      ['assets/images/header-only.png', false],
      ['assets/images/README.md', false],
      ['assets/images/valid.png', true],
      ['assets/video/clip.mp4', true],
    ]);
    expect(
      result.untrackedFiles.find((file) => file.projectRelativePath.endsWith('font.ttf'))
        ?.suggestedMove,
    ).toBe('correct-folder');
    expect(
      result.untrackedFiles.find((file) => file.projectRelativePath.endsWith('README.md'))
        ?.suggestedMove,
    ).toBe('support');
    expect(
      result.untrackedFiles.find((file) => file.projectRelativePath.endsWith('bad.jpg'))
        ?.suggestedMove,
    ).toBeUndefined();
    expect(result.untrackedFiles.every((file) => !file.previewUrl)).toBe(true);
    expect(result.untrackedFiles.every((file) => file.revision.length > 0)).toBe(true);

    const manual = await importUntrackedProjectAssets(projectFilePath, ['assets/images/README.md']);
    expect(manual.success).toBe(true);
    expect(manual.assets?.[0]).toMatchObject({ kind: 'text' });
    const invalid = await importUntrackedProjectAssets(projectFilePath, ['assets/images/bad.jpg']);
    expect(invalid.success).toBe(false);
    expect(invalid.error).toMatch(/recognized image format/);
    for (const extension of ['ogg', 'flac']) {
      const truncated = await importUntrackedProjectAssets(projectFilePath, [
        `assets/audio/truncated.${extension}`,
      ]);
      expect(truncated.success).toBe(false);
      expect(truncated.error).toMatch(/recognized audio format/);
    }
  });

  it('excludes registered sources, temporary paths, and symbolic links', async () => {
    const { root, projectFilePath, project } = await projectFixture();
    await writeFile(path.join(root, 'assets/images/owned.png'), tinyPng);
    await writeFile(path.join(root, 'assets/images/other.png'), tinyPng);
    await writeFile(path.join(root, 'assets/images/.incomplete.png'), tinyPng);
    await fs.symlink(
      path.join(root, 'assets/images/other.png'),
      path.join(root, 'assets/images/link.png'),
    );
    project.assets.owned = {
      id: 'owned',
      label: 'Owned',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/owned.png' },
        aliases: [],
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    const audit = await auditProjectAssets(projectFilePath, project);
    expect(audit.untrackedFiles.map((file) => file.projectRelativePath)).toEqual([
      'assets/images/other.png',
    ]);
    const registeredMove = await organizeUntrackedProjectAsset(
      projectFilePath,
      project,
      'assets/images/owned.png',
      'correct-folder',
    );
    expect(registeredMove.success).toBe(false);
    expect(registeredMove.error).toMatch(/Registered or attached/);
  });

  it('limits simultaneous media inspection on large candidate batches', async () => {
    const { root, projectFilePath, project } = await projectFixture();
    for (let index = 0; index < 30; index++)
      await writeFile(path.join(root, `assets/images/${index}.png`), tinyPng);
    const originalOpen = fs.open.bind(fs);
    let active = 0;
    let peak = 0;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      try {
        return await originalOpen(...args);
      } finally {
        active--;
      }
    });
    const audit = await auditProjectAssets(projectFilePath, project);
    spy.mockRestore();
    expect(audit.untrackedFiles).toHaveLength(30);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it('only performs requested no-overwrite organization moves', async () => {
    const { root, projectFilePath, project } = await projectFixture();
    await writeFile(path.join(root, 'assets/images/CREDITS.md'), 'author credit');
    await writeFile(path.join(root, 'assets/images/song.wav'), 'RIFFxxxxWAVEfmt ');
    const support = await organizeUntrackedProjectAsset(
      projectFilePath,
      project,
      'assets/images/CREDITS.md',
      'support',
    );
    expect(support.success).toBe(true);
    expect(await readFile(path.join(root, 'support/CREDITS.md'), 'utf8')).toBe('author credit');
    await writeFile(path.join(root, 'assets/images/CREDITS.md'), 'new credit');
    const conflict = await organizeUntrackedProjectAsset(
      projectFilePath,
      project,
      'assets/images/CREDITS.md',
      'support',
    );
    expect(conflict.success).toBe(false);
    expect(await readFile(path.join(root, 'assets/images/CREDITS.md'), 'utf8')).toBe('new credit');
    expect(await readFile(path.join(root, 'support/CREDITS.md'), 'utf8')).toBe('author credit');
    const correct = await organizeUntrackedProjectAsset(
      projectFilePath,
      project,
      'assets/images/song.wav',
      'correct-folder',
    );
    expect(correct.success).toBe(true);
    expect(await readFile(path.join(root, 'assets/audio/song.wav'), 'utf8')).toBe(
      'RIFFxxxxWAVEfmt ',
    );
    const outside = await organizeUntrackedProjectAsset(
      projectFilePath,
      project,
      '../outside.md',
      'support',
    );
    expect(outside.success).toBe(false);

    const external = await mkdtemp(path.join(os.tmpdir(), 'noveltea-outside-support-'));
    roots.push(external);
    await rm(path.join(root, 'support'), { recursive: true });
    await fs.symlink(external, path.join(root, 'support'), 'dir');
    const symlinkDestination = await organizeUntrackedProjectAsset(
      projectFilePath,
      project,
      'assets/images/CREDITS.md',
      'support',
    );
    expect(symlinkDestination.success).toBe(false);
    expect(await readFile(path.join(root, 'assets/images/CREDITS.md'), 'utf8')).toBe('new credit');
  });
});
