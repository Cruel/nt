import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { readBoundedComfyUiSourceImage } from '../../main/services/comfyui-service';
import { COMFYUI_IPC_LIMITS } from '../../shared/comfyui';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

const roots: string[] = [];

function digest(bytes: Buffer) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
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

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('ComfyUI editor source-image authority adapter', () => {
  it('requires a current admitted image and rejects unsafe/non-image/revision/size sources before shared upload', async () => {
    const { root, projectFilePath } = tempProject();
    const bytes = Buffer.from('source-image');
    const sourcePath = 'assets/images/source.png';
    fs.writeFileSync(path.join(root, sourcePath), bytes);

    let active = await activate(projectFilePath, imageProject('source', sourcePath, bytes));
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'missing'),
    ).rejects.toMatchObject({ code: 'unauthorized-asset' });
    active.sessions.closeActiveProject();
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'source'),
    ).rejects.toMatchObject({ code: 'stale-project-session' });

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
    ).resolves.toMatchObject({ bytes });

    active = await activate(
      projectFilePath,
      imageProject('source', 'assets/images/escape.png', bytes),
    );
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'source'),
    ).rejects.toThrow(/symlink-escape/);
  });

  it('admits exactly 32 MiB and rejects metadata over the source ceiling before buffering', async () => {
    const { root, projectFilePath } = tempProject();
    const exact = Buffer.alloc(COMFYUI_IPC_LIMITS.sourceUploadBytes);
    const sourcePath = 'assets/images/limit.png';
    fs.writeFileSync(path.join(root, sourcePath), exact);
    let active = await activate(projectFilePath, imageProject('source', sourcePath, exact));
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'source'),
    ).resolves.toMatchObject({
      bytes: expect.objectContaining({ byteLength: COMFYUI_IPC_LIMITS.sourceUploadBytes }),
    });

    active = await activate(
      projectFilePath,
      imageProject('source', sourcePath, exact, {
        byteSize: COMFYUI_IPC_LIMITS.sourceUploadBytes + 1,
      }),
    );
    await expect(
      readBoundedComfyUiSourceImage(active.sessions, active.sessionId, 'source'),
    ).rejects.toThrow(/too-large/);
  });
});
