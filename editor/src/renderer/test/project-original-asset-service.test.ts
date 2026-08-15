import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import {
  createProjectOriginalAssetProtocolHandler,
  resolveProjectOriginalAssetUrl,
} from '../../main/services/project-original-asset-service';
import { PROJECT_ORIGINAL_ASSET_MAX_BYTES } from '../../shared/project-original-asset';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

const roots: string[] = [];

function digest(bytes: Buffer) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function zeroDigest(byteCount: number) {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(1024 * 1024);
  let remaining = byteCount;
  while (remaining > 0) {
    const size = Math.min(remaining, chunk.byteLength);
    hash.update(size === chunk.byteLength ? chunk : chunk.subarray(0, size));
    remaining -= size;
  }
  return `sha256:${hash.digest('hex')}`;
}

function tempProject(name = 'project') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `noveltea-original-${name}-`));
  roots.push(root);
  const projectFilePath = path.join(root, 'project.json');
  fs.writeFileSync(projectFilePath, '{}');
  fs.mkdirSync(path.join(root, 'assets', 'images'), { recursive: true });
  return { root, projectFilePath };
}

function projectWithAsset(
  assetId: string,
  sourcePath: string,
  bytes: Buffer,
  overrides: Record<string, unknown> = {},
) {
  const project = createAuthoringProject({ name: 'Original Asset' });
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

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('session-scoped original Asset streaming', () => {
  it('returns only a protocol URL and streams an admitted image with authoritative headers', async () => {
    const { root, projectFilePath } = tempProject();
    const bytes = Buffer.from('png-bytes');
    fs.writeFileSync(path.join(root, 'assets', 'images', 'logo.png'), bytes);
    const { sessions, sessionId } = await activate(
      projectFilePath,
      projectWithAsset('logo', 'assets/images/logo.png', bytes),
    );

    const resolved = await resolveProjectOriginalAssetUrl(sessions, sessionId, 'logo');
    expect(resolved).toEqual({
      ok: true,
      url: `noveltea-asset://source/${sessionId}/logo`,
    });

    const handler = createProjectOriginalAssetProtocolHandler(sessions);
    const response = await handler(new Request(resolved.ok ? resolved.url : 'invalid:'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it('never streams bytes beyond the admitted length if the file grows after protocol admission', async () => {
    const { root, projectFilePath } = tempProject('growth');
    const bytes = Buffer.from('png');
    const sourcePath = path.join(root, 'assets', 'images', 'logo.png');
    fs.writeFileSync(sourcePath, bytes);
    const { sessions, sessionId } = await activate(
      projectFilePath,
      projectWithAsset('logo', 'assets/images/logo.png', bytes),
    );
    const handler = createProjectOriginalAssetProtocolHandler(sessions);
    const response = await handler(new Request(`noveltea-asset://source/${sessionId}/logo`));

    fs.appendFileSync(sourcePath, Buffer.from('-unexpected-growth'));

    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it('permits contained symlinks and rejects symlink escapes and alternate traversal spellings', async () => {
    const { root, projectFilePath } = tempProject();
    const bytes = Buffer.from('png');
    const target = path.join(root, 'assets', 'images', 'target.png');
    fs.writeFileSync(target, bytes);
    fs.symlinkSync('target.png', path.join(root, 'assets', 'images', 'inside.png'));
    const outside = path.join(root, '..', `${path.basename(root)}-outside.png`);
    fs.writeFileSync(outside, bytes);
    roots.push(outside);
    fs.symlinkSync(outside, path.join(root, 'assets', 'images', 'outside.png'));

    const project = createAuthoringProject();
    for (const [id, sourcePath] of [
      ['inside', 'assets/images/inside.png'],
      ['outside', 'assets/images/outside.png'],
      ['traversal', 'assets/images/../images/target.png'],
    ] as const) {
      project.assets[id] = projectWithAsset(id, sourcePath, bytes).assets[id]!;
    }
    const { sessions, sessionId } = await activate(projectFilePath, project);

    expect((await resolveProjectOriginalAssetUrl(sessions, sessionId, 'inside')).ok).toBe(true);
    expect(await resolveProjectOriginalAssetUrl(sessions, sessionId, 'outside')).toEqual({
      ok: false,
      code: 'symlink-escape',
      boundaryCode: 'symlink-escape',
    });
    expect(await resolveProjectOriginalAssetUrl(sessions, sessionId, 'traversal')).toEqual({
      ok: false,
      code: 'invalid-source',
      boundaryCode: 'unsafe-path',
    });
  });

  it('rejects a Project root replaced by a symlink after activation', async () => {
    const projectA = tempProject('root-a');
    const projectB = tempProject('root-b');
    const movedProjectA = `${projectA.root}-moved`;
    const bytes = Buffer.from('png');
    fs.writeFileSync(path.join(projectA.root, 'assets', 'images', 'logo.png'), bytes);
    fs.writeFileSync(path.join(projectB.root, 'assets', 'images', 'logo.png'), bytes);
    const { sessions, sessionId } = await activate(
      projectA.projectFilePath,
      projectWithAsset('logo', 'assets/images/logo.png', bytes),
    );

    fs.renameSync(projectA.root, movedProjectA);
    fs.symlinkSync(projectB.root, projectA.root, 'dir');
    try {
      expect(await resolveProjectOriginalAssetUrl(sessions, sessionId, 'logo')).toEqual({
        ok: false,
        code: 'symlink-escape',
        boundaryCode: 'symlink-escape',
      });
    } finally {
      fs.rmSync(projectA.root);
      fs.renameSync(movedProjectA, projectA.root);
    }
  });

  it('rejects changed size, changed revision, non-regular files, and sources over 128 MiB', async () => {
    const { root, projectFilePath } = tempProject();
    const sourcePath = path.join(root, 'assets', 'images', 'logo.png');
    const original = Buffer.from('original');
    fs.writeFileSync(sourcePath, original);

    const sizeProject = projectWithAsset('logo', 'assets/images/logo.png', original, {
      byteSize: original.byteLength + 1,
    });
    let active = await activate(projectFilePath, sizeProject);
    expect(await resolveProjectOriginalAssetUrl(active.sessions, active.sessionId, 'logo')).toEqual(
      {
        ok: false,
        code: 'size-mismatch',
        boundaryCode: 'source-revision-mismatch',
      },
    );

    const revisionProject = projectWithAsset('logo', 'assets/images/logo.png', original, {
      contentHash: `sha256:${'0'.repeat(64)}`,
    });
    active = await activate(projectFilePath, revisionProject);
    expect(await resolveProjectOriginalAssetUrl(active.sessions, active.sessionId, 'logo')).toEqual(
      {
        ok: false,
        code: 'revision-mismatch',
        boundaryCode: 'source-revision-mismatch',
      },
    );

    fs.rmSync(sourcePath);
    fs.mkdirSync(sourcePath);
    const directoryProject = projectWithAsset('logo', 'assets/images/logo.png', original);
    active = await activate(projectFilePath, directoryProject);
    expect(
      (await resolveProjectOriginalAssetUrl(active.sessions, active.sessionId, 'logo')).ok,
    ).toBe(false);

    fs.rmSync(sourcePath, { recursive: true, force: true });
    fs.writeFileSync(sourcePath, Buffer.alloc(0));
    fs.truncateSync(sourcePath, PROJECT_ORIGINAL_ASSET_MAX_BYTES + 1);
    const oversizedProject = projectWithAsset('logo', 'assets/images/logo.png', Buffer.alloc(0), {
      byteSize: PROJECT_ORIGINAL_ASSET_MAX_BYTES + 1,
    });
    active = await activate(projectFilePath, oversizedProject);
    expect(await resolveProjectOriginalAssetUrl(active.sessions, active.sessionId, 'logo')).toEqual(
      {
        ok: false,
        code: 'too-large',
        boundaryCode: 'source-too-large',
      },
    );
  });

  it('accepts exactly 128 MiB and rejects larger files', async () => {
    const { root, projectFilePath } = tempProject('limit');
    const sourcePath = path.join(root, 'assets', 'images', 'limit.png');
    fs.writeFileSync(sourcePath, Buffer.alloc(0));
    fs.truncateSync(sourcePath, PROJECT_ORIGINAL_ASSET_MAX_BYTES);
    const exactProject = projectWithAsset('limit', 'assets/images/limit.png', Buffer.alloc(0), {
      byteSize: PROJECT_ORIGINAL_ASSET_MAX_BYTES,
      contentHash: zeroDigest(PROJECT_ORIGINAL_ASSET_MAX_BYTES),
    });
    let active = await activate(projectFilePath, exactProject);
    const exact = await resolveProjectOriginalAssetUrl(active.sessions, active.sessionId, 'limit');
    expect(exact.ok).toBe(true);

    fs.truncateSync(sourcePath, PROJECT_ORIGINAL_ASSET_MAX_BYTES + 1);
    const overProject = projectWithAsset('limit', 'assets/images/limit.png', Buffer.alloc(0), {
      byteSize: PROJECT_ORIGINAL_ASSET_MAX_BYTES + 1,
      contentHash: zeroDigest(PROJECT_ORIGINAL_ASSET_MAX_BYTES + 1),
    });
    active = await activate(projectFilePath, overProject);
    expect(
      await resolveProjectOriginalAssetUrl(active.sessions, active.sessionId, 'limit'),
    ).toEqual({
      ok: false,
      code: 'too-large',
      boundaryCode: 'source-too-large',
    });
  });

  it('returns stable failures for unknown Assets, unsupported kinds, and stale sessions', async () => {
    const { root, projectFilePath } = tempProject('failures');
    const bytes = Buffer.from('text');
    fs.mkdirSync(path.join(root, 'assets', 'text'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets', 'text', 'note.txt'), bytes);
    const project = createAuthoringProject();
    project.assets.note = {
      id: 'note',
      label: 'Note',
      data: {
        kind: 'text',
        source: { type: 'project-file', path: 'assets/text/note.txt' },
        aliases: [],
        byteSize: bytes.byteLength,
        contentHash: digest(bytes),
        imageMetadata: null,
      },
    };
    const { sessions, sessionId } = await activate(projectFilePath, project);
    expect(await resolveProjectOriginalAssetUrl(sessions, sessionId, 'missing')).toEqual({
      ok: false,
      code: 'unknown-asset',
      boundaryCode: 'unauthorized-asset',
    });
    expect(await resolveProjectOriginalAssetUrl(sessions, sessionId, 'note')).toEqual({
      ok: false,
      code: 'unsupported-kind',
      boundaryCode: 'unauthorized-asset',
    });
    sessions.closeActiveProject();
    expect(await resolveProjectOriginalAssetUrl(sessions, sessionId, 'note')).toEqual({
      ok: false,
      code: 'stale-or-unknown',
      boundaryCode: 'stale-project-session',
    });
  });

  it('invalidates Project A URLs after Project B becomes active', async () => {
    const a = tempProject('a');
    const b = tempProject('b');
    const bytes = Buffer.from('png');
    fs.writeFileSync(path.join(a.root, 'assets', 'images', 'logo.png'), bytes);
    fs.writeFileSync(path.join(b.root, 'assets', 'images', 'logo.png'), bytes);
    const sessions = new ActiveProjectSessionService();
    const sessionA = await sessions.activateProjectFile(
      a.projectFilePath,
      undefined,
      projectWithAsset('logo', 'assets/images/logo.png', bytes),
    );
    const urlA = await resolveProjectOriginalAssetUrl(sessions, sessionA, 'logo');
    expect(urlA.ok).toBe(true);

    await sessions.activateProjectFile(
      b.projectFilePath,
      undefined,
      projectWithAsset('logo', 'assets/images/logo.png', bytes),
    );
    const handler = createProjectOriginalAssetProtocolHandler(sessions);
    const response = await handler(new Request(urlA.ok ? urlA.url : 'invalid:'));
    expect(response.status).toBe(410);
  });
});
