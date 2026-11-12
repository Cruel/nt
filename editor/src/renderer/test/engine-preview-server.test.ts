import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
}));

import { EnginePreviewServer } from '../../main/engine-preview-server';

const temporaryRoots: string[] = [];
const servers: EnginePreviewServer[] = [];
const originalPreviewRoot = process.env.NOVELTEA_ENGINE_PREVIEW_ROOT;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (originalPreviewRoot === undefined) delete process.env.NOVELTEA_ENGINE_PREVIEW_ROOT;
  else process.env.NOVELTEA_ENGINE_PREVIEW_ROOT = originalPreviewRoot;
});

describe('EnginePreviewServer', () => {
  it('keeps the shared session stable when one preview iframe reloads', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-preview-server-'));
    temporaryRoots.push(root);
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Preview</title>');
    process.env.NOVELTEA_ENGINE_PREVIEW_ROOT = root;

    const server = new EnginePreviewServer();
    servers.push(server);
    const initial = await server.getSession();

    await expect(server.reload()).resolves.toEqual(initial);
    await expect(server.getSession()).resolves.toEqual(initial);
  });

  it('serves runtime preparation files from project and native overlays without exposing absolute paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-preview-server-'));
    const overlay = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-native-preview-'));
    temporaryRoots.push(root, overlay);
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Preview</title>');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets', 'photo.png'), 'image-content');
    fs.mkdirSync(path.join(root, 'licenses'), { recursive: true });
    fs.writeFileSync(path.join(root, 'licenses', 'attribution.txt'), 'notice-content');
    const shaderRoot = path.join(root, '.noveltea', 'build');
    fs.mkdirSync(path.join(shaderRoot, 'shaders'), { recursive: true });
    fs.writeFileSync(path.join(shaderRoot, 'shaders', 'native.bin'), 'shader-binary');
    fs.writeFileSync(path.join(overlay, 'dirty.lua'), 'dirty-working-content');
    process.env.NOVELTEA_ENGINE_PREVIEW_ROOT = root;

    const server = new EnginePreviewServer();
    servers.push(server);
    server.setProjectFilePath(path.join(root, 'project.yaml'));
    const session = await server.getSession();
    const assets = await server.registerRuntimeAssets({
      fileEntries: [
        { source: path.join(root, 'assets', 'photo.png'), packagePath: 'images/photo.png' },
        { source: path.join(overlay, 'dirty.lua'), packagePath: 'scripts/dirty.lua' },
        {
          source: path.join(root, 'licenses', 'attribution.txt'),
          packagePath: 'licenses/attribution.txt',
        },
      ],
      shaderAssetRoot: shaderRoot,
      requiredShaderBinaryPaths: ['shaders/native.bin'],
    });

    expect(assets).toHaveLength(4);
    for (const asset of assets) {
      expect(asset.sourcePath).toMatch(/^__runtime-prepared\/[a-f0-9]+\/\d+$/);
      expect(asset.sourcePath).not.toContain(root);
      expect(asset.sourcePath).not.toContain(overlay);
    }
    expect(assets.map((asset) => asset.runtimePath)).toEqual([
      'images/photo.png',
      'scripts/dirty.lua',
      'licenses/attribution.txt',
      'shaders/native.bin',
    ]);
    expect(
      await (await fetch(`${session.origin}/project-assets/${assets[0]!.sourcePath}`)).text(),
    ).toBe('image-content');
    expect(
      await (await fetch(`${session.origin}/project-assets/${assets[1]!.sourcePath}`)).text(),
    ).toBe('dirty-working-content');
    expect(
      await (await fetch(`${session.origin}/project-assets/${assets[2]!.sourcePath}`)).text(),
    ).toBe('notice-content');
    expect(
      await (await fetch(`${session.origin}/project-assets/${assets[3]!.sourcePath}`)).text(),
    ).toBe('shader-binary');

    server.setProjectFilePath(path.join(root, 'project.yaml'));
    expect((await fetch(`${session.origin}/project-assets/${assets[0]!.sourcePath}`)).status).toBe(
      200,
    );

    fs.rmSync(overlay, { recursive: true, force: true });
    expect((await fetch(`${session.origin}/project-assets/${assets[1]!.sourcePath}`)).status).toBe(
      404,
    );

    server.setProjectFilePath(path.join(overlay, 'project.yaml'));
    expect((await fetch(`${session.origin}/project-assets/${assets[0]!.sourcePath}`)).status).toBe(
      404,
    );
  });

  it('rejects unsafe runtime destinations and non-absolute source files', async () => {
    const server = new EnginePreviewServer();
    servers.push(server);
    server.setProjectFilePath('/tmp/preview-project/project.yaml');
    await expect(
      server.registerRuntimeAssets({
        fileEntries: [{ source: '/tmp/asset.png', packagePath: '../escape.png' }],
        requiredShaderBinaryPaths: [],
      }),
    ).rejects.toThrow(/runtime asset path/i);
    await expect(
      server.registerRuntimeAssets({
        fileEntries: [{ source: 'asset.png', packagePath: 'assets/asset.png' }],
        requiredShaderBinaryPaths: [],
      }),
    ).rejects.toThrow(/absolute/i);
  });

  it('does not register files from a Project that switches during asynchronous admission', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-preview-switch-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'asset.png');
    fs.writeFileSync(source, 'asset');
    const server = new EnginePreviewServer();
    servers.push(server);
    server.setProjectFilePath(path.join(root, 'project.yaml'));
    const registering = server.registerRuntimeAssets({
      fileEntries: [{ source, packagePath: 'images/asset.png' }],
      requiredShaderBinaryPaths: [],
    });
    server.setProjectFilePath(path.join(root, 'other', 'project.yaml'));
    await expect(registering).rejects.toThrow(/Project changed during asset registration/);
  });
});
