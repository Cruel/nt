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
});
