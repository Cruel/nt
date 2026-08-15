import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import {
  COMFYUI_SOURCE_UPLOAD_MAX_BYTES,
  isLoopbackAddress,
  readBoundedComfyUiSourceImage,
  resolveLoopbackUploadTarget,
  uploadComfyUiSourceImage,
} from '../../main/services/comfyui-service';
import type { ComfyUiConfig } from '../../shared/comfyui';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

const roots: string[] = [];
const servers: http.Server[] = [];

function digest(bytes: Buffer) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function config(serverUrl: string): ComfyUiConfig {
  return {
    enabled: true,
    serverUrl,
    requestTimeoutMs: 2_000,
    connectionCheckIntervalMs: 1_000,
    defaultWorkflowId: 'custom',
    defaultWorkflows: {},
  };
}

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-comfyui-source-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'assets', 'images'), { recursive: true });
  const projectFilePath = path.join(root, 'project.json');
  fs.writeFileSync(projectFilePath, '{}');
  return { root, projectFilePath };
}

function imageProject(
  assetId: string,
  sourcePath: string,
  bytes: Buffer,
  overrides: Record<string, unknown> = {},
) {
  const project = createAuthoringProject({ name: 'ComfyUI Source' });
  project.assets[assetId] = {
    id: assetId,
    label: assetId,
    data: {
      kind: 'image',
      source: { type: 'project-file', path: sourcePath },
      aliases: [],
      byteSize: bytes.byteLength,
      contentHash: digest(bytes),
      imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      ...overrides,
    },
  };
  return project;
}

async function activate(projectFilePath: string, project: unknown) {
  const sessions = new ActiveProjectSessionService();
  const sessionId = await sessions.activateProjectFile(projectFilePath, undefined, project);
  return { sessions, sessionId };
}

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('secure ComfyUI source-image upload', () => {
  it('recognizes IPv4, IPv6, and IPv4-mapped loopback only', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.255.1.2')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress('8.8.8.8')).toBe(false);
    expect(isLoopbackAddress('::2')).toBe(false);
  });

  it('accepts localhost/literal loopback HTTP and rejects credentials, remote, ambiguous, and HTTPS targets', async () => {
    await expect(
      resolveLoopbackUploadTarget(config('http://127.0.0.1:8188')),
    ).resolves.toMatchObject({
      address: '127.0.0.1',
      family: 4,
    });
    await expect(resolveLoopbackUploadTarget(config('http://[::1]:8188'))).resolves.toMatchObject({
      address: '::1',
      family: 6,
    });
    await expect(resolveLoopbackUploadTarget(config('http://localhost:8188'))).resolves.toEqual(
      expect.objectContaining({ url: expect.any(URL) }),
    );
    await expect(
      resolveLoopbackUploadTarget(config('http://user:pass@127.0.0.1:8188')),
    ).rejects.toThrow(/credentials/);
    await expect(resolveLoopbackUploadTarget(config('https://127.0.0.1:8188'))).rejects.toThrow(
      /loopback HTTP/,
    );
    await expect(resolveLoopbackUploadTarget(config('http://192.168.1.10:8188'))).rejects.toThrow(
      /loopback/,
    );
    await expect(resolveLoopbackUploadTarget(config('http://example.com:8188'))).rejects.toThrow(
      /localhost or a loopback IP literal/,
    );
  });

  it('requires a current admitted image and rejects unsafe/non-image/revision/size sources before upload', async () => {
    const { root, projectFilePath } = tempProject();
    const bytes = Buffer.from('source-image');
    const sourcePath = 'assets/images/source.png';
    fs.writeFileSync(path.join(root, sourcePath), bytes);

    let active = await activate(projectFilePath, imageProject('source', sourcePath, bytes));
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'missing'),
    ).rejects.toThrow(/unknown-asset/);
    active.sessions.closeActiveProject();
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'source'),
    ).rejects.toThrow(/stale-or-unknown/);

    active = await activate(
      projectFilePath,
      imageProject('source', sourcePath, bytes, { kind: 'audio', imageMetadata: null }),
    );
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'source'),
    ).rejects.toThrow(/unsupported-kind/);

    active = await activate(projectFilePath, imageProject('source', '../outside.png', bytes));
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'source'),
    ).rejects.toThrow(/invalid-source/);

    active = await activate(
      projectFilePath,
      imageProject('source', sourcePath, bytes, { contentHash: `sha256:${'0'.repeat(64)}` }),
    );
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'source'),
    ).rejects.toThrow(/revision-mismatch/);

    active = await activate(
      projectFilePath,
      imageProject('source', sourcePath, bytes, { byteSize: bytes.byteLength + 1 }),
    );
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'source'),
    ).rejects.toThrow(/size-mismatch/);
  });

  it('rejects escaping symlinks but permits contained symlinks', async () => {
    const { root, projectFilePath } = tempProject();
    const bytes = Buffer.from('source-image');
    const inside = path.join(root, 'assets', 'images', 'inside.png');
    fs.writeFileSync(inside, bytes);
    fs.symlinkSync(inside, path.join(root, 'assets', 'images', 'contained.png'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-comfyui-outside-'));
    roots.push(outsideRoot);
    const outside = path.join(outsideRoot, 'outside.png');
    fs.writeFileSync(outside, bytes);
    fs.symlinkSync(outside, path.join(root, 'assets', 'images', 'escape.png'));

    let active = await activate(
      projectFilePath,
      imageProject('source', 'assets/images/contained.png', bytes),
    );
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'source'),
    ).resolves.toMatchObject({
      bytes,
    });

    active = await activate(
      projectFilePath,
      imageProject('source', 'assets/images/escape.png', bytes),
    );
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'source'),
    ).rejects.toThrow(/symlink-escape/);
  });

  it('admits exactly 32 MiB and rejects metadata over the source-upload ceiling before buffering', async () => {
    const { root, projectFilePath } = tempProject();
    const exact = Buffer.alloc(COMFYUI_SOURCE_UPLOAD_MAX_BYTES);
    const sourcePath = 'assets/images/limit.png';
    fs.writeFileSync(path.join(root, sourcePath), exact);
    let active = await activate(projectFilePath, imageProject('source', sourcePath, exact));
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'source'),
    ).resolves.toMatchObject({
      bytes: expect.objectContaining({ byteLength: COMFYUI_SOURCE_UPLOAD_MAX_BYTES }),
    });

    active = await activate(
      projectFilePath,
      imageProject('source', sourcePath, exact, { byteSize: COMFYUI_SOURCE_UPLOAD_MAX_BYTES + 1 }),
    );
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'source'),
    ).rejects.toThrow(/invalid-metadata/);
  });

  it('uploads to a pinned loopback fake server and never follows redirects', async () => {
    let uploadBody = Buffer.alloc(0);
    const serverUrl = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        uploadBody = Buffer.concat(chunks);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ name: 'source.png', subfolder: 'noveltea' }));
      });
    });
    const { root, projectFilePath } = tempProject();
    const bytes = Buffer.from('source-image');
    const sourcePath = 'assets/images/source.png';
    fs.writeFileSync(path.join(root, sourcePath), bytes);
    const active = await activate(projectFilePath, imageProject('source', sourcePath, bytes));

    await expect(
      uploadComfyUiSourceImage(active.sessions, active.sessionId, config(serverUrl), 'source'),
    ).resolves.toBe('noveltea/source.png');
    expect(uploadBody.includes(bytes)).toBe(true);
    expect(uploadBody.toString('utf8')).toContain('name="overwrite"');

    const redirectUrl = await listen((_request, response) => {
      response.statusCode = 302;
      response.setHeader('location', 'http://127.0.0.1:1/remote');
      response.end();
    });
    await expect(
      uploadComfyUiSourceImage(active.sessions, active.sessionId, config(redirectUrl), 'source'),
    ).rejects.toThrow(/redirects are not allowed/);
  });
});
