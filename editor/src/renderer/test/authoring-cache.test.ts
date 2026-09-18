import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import type { NovelTeaCliNativeToolService } from '../../cli/native-tool-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  NodeProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { createDefaultAuthoringRecord } from '../project/entity-operations';

const roots: string[] = [];
async function fixture(withLua = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'noveltea-authoring-cache-'));
  roots.push(root);
  const project = createAuthoringProject({ id: 'cache', name: 'Cache' });
  project.rooms.start = createDefaultAuthoringRecord(
    'rooms',
    'start',
  ) as typeof project.rooms.start;
  project.entrypoint = { kind: 'room', id: 'start' };
  if (withLua) {
    project.scripts.logic = createDefaultAuthoringRecord(
      'scripts',
      'logic',
    ) as typeof project.scripts.logic;
    project.scripts.logic!.data.source = {
      kind: 'inline-lua',
      source: 'local value = "unterminated',
    };
  }
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
async function generation(root: string) {
  return (
    JSON.parse(await readFile(path.join(root, '.noveltea/cache/authoring/current'), 'utf8')) as {
      generation: string;
    }
  ).generation;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('persistent CLI validation', () => {
  it('does not certify a source addition that happened after workspace assembly', async () => {
    const root = await fixture();
    const fileSystem = new NodeProjectWorkspaceFileSystem();
    class RacingWorkspace extends ProjectWorkspaceService {
      override async open(...args: Parameters<ProjectWorkspaceService['open']>) {
        const opened = await super.open(...args);
        const extra = createDefaultAuthoringRecord('rooms', 'extra');
        await writeFile(path.join(root, 'records/rooms/extra.json'), JSON.stringify(extra));
        return opened;
      }
    }
    const result = await runNovelTeaCli(['--json', 'validate'], {
      cwd: root,
      nativeTools: tools(),
      fileSystem,
      workspace: new RacingWorkspace(fileSystem),
    });
    expect(result.exitCode).toBe(0);
    await expect(generation(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves source locations and informational diagnostics on cache hits', async () => {
    const root = await fixture(true);
    const nativeTools = tools();
    const fileSystem = new NodeProjectWorkspaceFileSystem();
    class InformationalWorkspace extends ProjectWorkspaceService {
      override async open(...args: Parameters<ProjectWorkspaceService['open']>) {
        const opened = await super.open(...args);
        return {
          ...opened,
          diagnostics: [
            ...opened.diagnostics,
            {
              code: 'validation.information',
              severity: 'info' as const,
              path: '/',
              message: 'Inspection complete',
              boundaries: [],
              ownerPaths: ['/'],
            },
          ],
        };
      }
    }
    const cold = await runNovelTeaCli(['--json', 'validate'], {
      cwd: root,
      nativeTools,
      fileSystem,
      workspace: new InformationalWorkspace(fileSystem),
    });
    expect(cold.exitCode).toBe(0);
    expect(cold.envelope.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'authoring.lua.lexical_incomplete',
        sourceUrl: expect.any(String),
        line: 1,
        column: 1,
      }),
    );
    expect(cold.envelope.diagnostics.some((item) => item.severity === 'info')).toBe(true);
    const first = await generation(root);
    expect(await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools })).toEqual(cold);
    expect(await generation(root)).toBe(first);
  });

  it('preserves semantic errors and warning order in JSON and human output', async () => {
    const root = await fixture();
    const file = path.join(root, 'project.json');
    const project = JSON.parse(await readFile(file, 'utf8'));
    project.entrypoint = { kind: 'room', id: 'missing' };
    await writeFile(file, JSON.stringify(project));
    const nativeTools = tools();
    const cold = await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools });
    expect(cold.exitCode).toBe(4);
    expect(cold.envelope.diagnostics.some((item) => item.severity === 'error')).toBe(true);
    const first = await generation(root);
    expect(await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools })).toEqual(cold);
    const warmHuman = await runNovelTeaCli(['validate'], { cwd: root, nativeTools });
    await rm(path.join(root, '.noveltea/cache/authoring/current'));
    expect(await runNovelTeaCli(['validate'], { cwd: root, nativeTools })).toEqual(warmHuman);
    expect(await generation(root)).not.toBe(first);
  });

  it('retains the disk baseline if validation races with an external edit', async () => {
    const root = await fixture();
    const file = path.join(root, 'records/rooms/start.json');
    const result = await runNovelTeaCli(['--json', 'validate'], {
      cwd: root,
      nativeTools: {
        ...tools(),
        async validateFontCoverage() {
          await writeFile(file, `${await readFile(file, 'utf8')}\n`);
          return { ok: true, success: true, diagnostics: [] };
        },
      },
    });
    expect(result.exitCode).toBe(0);
    await expect(generation(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never memoizes native tooling failures', async () => {
    const root = await fixture();
    const failed = await runNovelTeaCli(['--json', 'validate'], {
      cwd: root,
      nativeTools: {
        ...tools(),
        async validateFontCoverage() {
          throw new Error('Unavailable host');
        },
      },
    });
    expect(failed.exitCode).toBe(6);
    await expect(generation(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools: tools() })).exitCode,
    ).toBe(0);
    expect(await generation(root)).toBeTruthy();
  });

  it('publishes isolated complete generations under concurrent validation', async () => {
    const root = await fixture();
    const results = await Promise.all(
      [0, 1].map(() => runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools: tools() })),
    );
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.exitCode).toBe(0);
    const generations = await readdir(path.join(root, '.noveltea/cache/authoring/generations'));
    expect(generations).toHaveLength(2);
    const warm = await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools: tools() });
    expect(warm).toEqual(results[0]);
  });

  it('falls back without writing through a symlinked cache directory', async () => {
    const root = await fixture();
    const target = await mkdtemp(path.join(tmpdir(), 'noveltea-cache-outside-'));
    roots.push(target);
    await mkdir(path.join(root, '.noveltea/cache'), { recursive: true });
    await symlink(target, path.join(root, '.noveltea/cache/authoring'), 'junction');
    const result = await runNovelTeaCli(['--json', 'validate'], {
      cwd: root,
      nativeTools: tools(),
    });
    expect(result.exitCode).toBe(0);
    expect(await readdir(target)).toEqual([]);
  });

  it('publishes a clean disk generation and reuses diagnostics without rereading authored records', async () => {
    const root = await fixture();
    const nativeTools = tools();
    const cold = await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools });
    expect(cold.exitCode).toBe(0);
    const first = await generation(root);
    class CacheOnlyReads extends NodeProjectWorkspaceFileSystem {
      override async readText(file: string) {
        if (
          !file.includes(`${path.sep}.noveltea${path.sep}`) &&
          file !== path.join(root, 'project.json')
        )
          throw new Error('Authoring source reread');
        return super.readText(file);
      }
    }
    const warm = await runNovelTeaCli(['--json', 'validate'], {
      cwd: root,
      nativeTools,
      fileSystem: new CacheOnlyReads(),
    });
    expect(warm).toEqual(cold);
    expect(await generation(root)).toBe(first);
  });
});
