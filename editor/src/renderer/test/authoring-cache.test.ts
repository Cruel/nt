import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import type { NovelTeaCliNativeToolService } from '../../cli/native-tool-service';
import { NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY } from '../../cli/static-contracts';
import {
  AUTHORING_VALIDATION_DISCOVERY_SCOPES,
  publishAuthoringCache,
  readAuthoringCache,
} from '../../shared/authoring-cache';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { captureProjectSourceInventory } from '../../shared/project-source-inventory';
import {
  NodeProjectWorkspaceFileSystem,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { createDefaultAuthoringRecord } from '../project/entity-operations';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'noveltea-authoring-cache-'));
  roots.push(root);
  const project = createAuthoringProject({ id: 'cache', name: 'Cache' });
  project.rooms.start = createDefaultAuthoringRecord(
    'rooms',
    'start',
  ) as typeof project.rooms.start;
  project.entrypoint = { kind: 'room', id: 'start' };
  for (const [relative, text] of Object.entries(projectWorkspaceFiles(project, project.editor))) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  return root;
}

function tools(): NovelTeaCliNativeToolService {
  return {
    async compileShaders() {
      return { ok: true, success: true, diagnostics: [], outputs: [] };
    },
    async validateFontCoverage() {
      return { ok: true, success: true, diagnostics: [] };
    },
    async runHeadlessTest() {
      return { ok: true, success: true };
    },
    async runUiTest() {
      return { ok: true, success: true };
    },
    async exportPackage() {
      return { ok: true, success: true };
    },
    shaderc() {
      return 0;
    },
    texturec() {
      return 0;
    },
  };
}

async function inventory(fileSystem: NodeProjectWorkspaceFileSystem, root: string) {
  return captureProjectSourceInventory(fileSystem, root, {
    authoritativePaths: ['project.json', 'editor.json', 'traits.json'],
    discoveryScopes: AUTHORING_VALIDATION_DISCOVERY_SCOPES,
  });
}

const exactResult = {
  success: true,
  exitCode: 0,
  diagnostics: [
    {
      code: 'CACHE_INFO',
      severity: 'info' as const,
      path: '/project',
      message: 'Exact result.',
      sourceUrl: 'project:/project.json',
      line: 1,
      column: 1,
    },
  ],
  editorDiagnostics: [
    {
      code: 'CACHE_INFO',
      severity: 'info' as const,
      path: '/project',
      message: 'Exact result.',
      boundaries: ['authoring' as const],
      ownerPaths: ['/project'],
    },
  ],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('narrow exact validation cache', () => {
  it('persists only one physical-authority manifest and exact validation result', async () => {
    const root = await fixture();
    const fileSystem = new NodeProjectWorkspaceFileSystem();
    const inputs = await inventory(fileSystem, root);

    await publishAuthoringCache(fileSystem, root, inputs, exactResult);

    const cachePath = path.join(root, '.noveltea/cache/authoring/current.json');
    const manifest = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual([
      'discoveryScopes',
      'inputs',
      'projectRoot',
      'result',
      'schema',
      'semanticKey',
    ]);
    expect(manifest.semanticKey).toBe(NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY);
    expect(JSON.stringify(manifest)).not.toContain('contribution');
    expect(JSON.stringify(manifest)).not.toContain('sourceAnalyses');
    expect(JSON.stringify(manifest)).not.toContain('dependencyState');
    await expect(
      stat(path.join(root, '.noveltea/cache/authoring/generations')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readAuthoringCache(fileSystem, root)).resolves.toEqual(exactResult);
  });

  it('rejects physical replacement even when byte size and nanosecond mtime are restored', async () => {
    const root = await fixture();
    const fileSystem = new NodeProjectWorkspaceFileSystem();
    await publishAuthoringCache(fileSystem, root, await inventory(fileSystem, root), exactResult);
    const roomPath = path.join(root, 'records/rooms/start.json');
    const before = await stat(roomPath, { bigint: true });
    const original = await readFile(roomPath);
    const replacement = `${roomPath}.replacement`;
    await writeFile(replacement, original);
    await utimes(replacement, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
    await rename(replacement, roomPath);

    expect((await stat(roomPath, { bigint: true })).size).toBe(before.size);
    await expect(readAuthoringCache(fileSystem, root)).resolves.toBeNull();
  });

  it('rejects changed physical input and incompatible semantic identity', async () => {
    const root = await fixture();
    const fileSystem = new NodeProjectWorkspaceFileSystem();
    await publishAuthoringCache(fileSystem, root, await inventory(fileSystem, root), exactResult);
    const currentPath = path.join(root, '.noveltea/cache/authoring/current.json');
    const manifest = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>;
    manifest.semanticKey = `${NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY}:other`;
    await writeFile(currentPath, `${JSON.stringify(manifest)}\n`);
    await expect(readAuthoringCache(fileSystem, root)).resolves.toBeNull();

    await publishAuthoringCache(fileSystem, root, await inventory(fileSystem, root), exactResult);
    const roomPath = path.join(root, 'records/rooms/start.json');
    const room = JSON.parse(await readFile(roomPath, 'utf8')) as Record<string, unknown>;
    room.label = 'Changed';
    await writeFile(roomPath, `${JSON.stringify(room)}\n`);
    await expect(readAuthoringCache(fileSystem, root)).resolves.toBeNull();
  });

  it('treats corrupt and unsafe persistence as a cache miss', async () => {
    const root = await fixture();
    const fileSystem = new NodeProjectWorkspaceFileSystem();
    const cacheRoot = path.join(root, '.noveltea/cache/authoring');
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(path.join(cacheRoot, 'current.json'), '{not-json');
    await expect(readAuthoringCache(fileSystem, root)).resolves.toBeNull();

    await rm(path.join(root, '.noveltea/cache'), { recursive: true, force: true });
    const outside = await mkdtemp(path.join(tmpdir(), 'noveltea-authoring-cache-outside-'));
    roots.push(outside);
    await symlink(outside, path.join(root, '.noveltea/cache'));
    await expect(
      publishAuthoringCache(fileSystem, root, await inventory(fileSystem, root), exactResult),
    ).resolves.toBeUndefined();
    await expect(stat(path.join(outside, 'authoring/current.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not wait for optional exact-result persistence before returning validation', async () => {
    const root = await fixture();
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let cacheWriteStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      cacheWriteStarted = resolve;
    });
    class DelayedCacheFileSystem extends NodeProjectWorkspaceFileSystem {
      override async writeTextAtomic(value: string, text: string): Promise<void> {
        if (value.endsWith('/.noveltea/cache/authoring/current.json')) {
          cacheWriteStarted();
          await gate;
        }
        await super.writeTextAtomic(value, text);
      }
    }
    const fileSystem = new DelayedCacheFileSystem();
    const validation = runNovelTeaCli(['--json', 'validate'], {
      cwd: root,
      fileSystem,
      nativeTools: tools(),
    });

    const result = await validation;
    expect(result.exitCode).toBe(0);
    await started;
    await expect(
      stat(path.join(root, '.noveltea/cache/authoring/current.json')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    releaseWrite();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await stat(path.join(root, '.noveltea/cache/authoring/current.json'));
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    throw new Error('Best-effort validation cache publication did not finish after release.');
  });
});
