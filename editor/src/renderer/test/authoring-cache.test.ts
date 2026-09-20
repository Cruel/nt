import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { runNovelTeaCli, type AuthoringValidationInstrumentation } from '../../cli/application';
import type { NovelTeaCliNativeToolService } from '../../cli/native-tool-service';
import { readReusableAuthoringContributions } from '../../shared/authoring-cache';
import { sha256PrefixedUtf8 } from '../../shared/web-crypto';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  NodeProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { createDefaultAuthoringRecord } from '../project/entity-operations';

const roots: string[] = [];
async function fixture(
  withLua = false,
  configure?: (project: ReturnType<typeof createAuthoringProject>) => void,
) {
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
  configure?.(project);
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
  it('reuses unaffected validation checks after a one-Room edit with fresh-equivalent output', async () => {
    const root = await fixture(false, (project) => {
      for (let index = 0; index < 30; index++) {
        const id = `room-${index}`;
        project.rooms[id] = createDefaultAuthoringRecord('rooms', id) as typeof project.rooms.start;
      }
      project.rooms['room-0']!.label = ' ';
    });
    const fileSystem = new NodeProjectWorkspaceFileSystem();
    const work: Array<{ executed: number; reused: number }> = [];
    const instrumentation: AuthoringValidationInstrumentation[] = [];
    class ObservedWorkspace extends ProjectWorkspaceService {
      override async open(...args: Parameters<ProjectWorkspaceService['open']>) {
        const opened = await super.open(...args);
        if (opened.ok) work.push(opened.validationWork);
        return opened;
      }
    }
    const options = {
      cwd: root,
      nativeTools: tools(),
      fileSystem,
      workspace: new ObservedWorkspace(fileSystem),
      onAuthoringValidationInstrumentation(value: AuthoringValidationInstrumentation) {
        instrumentation.push(value);
      },
    };
    await runNovelTeaCli(['--json', 'validate'], options);
    const file = path.join(root, 'records/rooms/start.json');
    const room = JSON.parse(await readFile(file, 'utf8'));
    room.label = 'Changed';
    await writeFile(file, JSON.stringify(room));
    const incremental = await runNovelTeaCli(['--json', 'validate'], {
      ...options,
      skipAuthoringWholeResultCache: true,
    });
    const fresh = await runNovelTeaCli(['--json', 'validate'], {
      ...options,
      forceAuthoringCacheRebuild: true,
    });
    expect(incremental).toEqual(fresh);
    expect(work[0]!.executed).toBeGreaterThan(60);
    expect(work[1]!.reused).toBeGreaterThan(50);
    expect(work[1]!.executed).toBeLessThan(work[0]!.executed / 2);
    expect(work[2]!.reused).toBe(0);
    expect(instrumentation).toHaveLength(3);
    expect(instrumentation[1]!.validationWork.reused).toBeGreaterThan(50);
    expect(instrumentation[1]!.sourceWork.parsedJsonSources).toBe(1);
    expect(instrumentation[1]!.sourceWork.projectedJsonSources).toBe(1);
    expect(instrumentation[1]!.sourceWork.wholeProjectSchemaParses).toBe(0);
    expect(instrumentation[1]!.sourceWork.reusedJsonSources).toBeGreaterThan(30);
    expect(instrumentation[1]!.dependencyWork.reusedContributions).toBeGreaterThan(
      instrumentation[1]!.dependencyWork.derivedContributions,
    );
    expect(instrumentation[1]!.compilerWork).toEqual({
      wholeProjectNormalizations: 0,
      linkBuilds: 0,
      artifactLowerings: 0,
      serializations: 0,
    });
    expect(instrumentation[2]!.dependencyWork.reusedContributions).toBe(0);
    expect(instrumentation[2]!.sourceWork.wholeProjectSchemaParses).toBe(1);
  });
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

  it('rejects cache generations that omit an authoritative root fragment', async () => {
    const root = await fixture();
    const nativeTools = tools();
    expect(
      (await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools })).exitCode,
    ).toBe(0);
    const currentPath = path.join(root, '.noveltea/cache/authoring/current');
    const pointer = JSON.parse(await readFile(currentPath, 'utf8')) as {
      generation: string;
      manifestSha256: string;
    };
    const manifestPath = path.join(
      root,
      '.noveltea/cache/authoring/generations',
      pointer.generation,
      'manifest.json',
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      inputs: Array<{ path: string }>;
    } & Record<string, unknown>;
    manifest.inputs = manifest.inputs.filter((input) => input.path !== 'traits.json');
    const manifestText = `${JSON.stringify(manifest)}\n`;
    await writeFile(manifestPath, manifestText);
    await writeFile(
      currentPath,
      `${JSON.stringify({
        ...pointer,
        manifestSha256: await sha256PrefixedUtf8(manifestText),
      })}\n`,
    );

    let traitsRead = false;
    const traitsPath = path.join(root, 'traits.json');
    class RootFragmentReads extends NodeProjectWorkspaceFileSystem {
      override async readText(file: string) {
        if (file === traitsPath) traitsRead = true;
        return super.readText(file);
      }
    }
    const fileSystem = new RootFragmentReads();
    expect(
      (
        await runNovelTeaCli(['--json', 'validate'], {
          cwd: root,
          nativeTools,
          fileSystem,
          workspace: new ProjectWorkspaceService(fileSystem),
        })
      ).exitCode,
    ).toBe(0);
    expect(traitsRead).toBe(true);
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

  it('persists parsed, validation, dependency, and source-analysis contributions', async () => {
    const root = await fixture(true);
    const roomPath = path.join(root, 'records/rooms/start.json');
    const room = JSON.parse(await readFile(roomPath, 'utf8')) as Record<string, unknown>;
    room.label = '   ';
    await writeFile(roomPath, JSON.stringify(room));
    const nativeTools = tools();
    expect(
      (await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools })).exitCode,
    ).toBe(4);
    const currentGeneration = await generation(root);
    const artifact = JSON.parse(
      await readFile(
        path.join(
          root,
          '.noveltea/cache/authoring/generations',
          currentGeneration,
          'contributions.json',
        ),
        'utf8',
      ),
    ) as {
      entries: Array<{
        path: string;
        contentHash: string;
        kind: string;
        parsed?: { id?: string };
        schemaValid: boolean;
        ownerPaths: string[];
        localDiagnostics: Array<{ code: string }>;
      }>;
      dependencyContributions: Array<{
        sourceRevisions: Array<{ path: string; contentHash: string }>;
        contribution: { ownerPath?: string };
      }>;
      sourceAnalyses: Array<{
        sourceRevisions: Array<{ path: string; contentHash: string }>;
        analyses: unknown[];
      }>;
    };
    expect(artifact.entries).toContainEqual(
      expect.objectContaining({
        path: 'records/rooms/start.json',
        contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        kind: 'json',
        parsed: expect.objectContaining({ id: 'start' }),
        schemaValid: true,
        ownerPaths: ['/rooms/start'],
        localDiagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'authoring.record.label.required' }),
        ]),
      }),
    );
    expect(artifact.dependencyContributions).toContainEqual(
      expect.objectContaining({
        sourceRevisions: expect.arrayContaining([
          expect.objectContaining({ path: 'records/rooms/start.json' }),
        ]),
        contribution: expect.objectContaining({ ownerPath: '/rooms/start' }),
      }),
    );
    expect(artifact.sourceAnalyses).toContainEqual(
      expect.objectContaining({
        sourceRevisions: expect.arrayContaining([
          expect.objectContaining({ path: 'scripts/logic.lua' }),
        ]),
        analyses: expect.arrayContaining([expect.any(Object)]),
      }),
    );
  });

  it('invalidates cross-source semantic checks when a referenced Trait changes', async () => {
    const root = await fixture(false, (project) => {
      project.rooms.start!.traits = ['shared'];
    });
    const nativeTools = tools();
    const fileSystem = new NodeProjectWorkspaceFileSystem();
    const work: Array<{ executed: number; reused: number }> = [];
    class ObservedWorkspace extends ProjectWorkspaceService {
      override async open(...args: Parameters<ProjectWorkspaceService['open']>) {
        const opened = await super.open(...args);
        if (opened.ok) work.push(opened.validationWork);
        return opened;
      }
    }
    const options = {
      cwd: root,
      nativeTools,
      fileSystem,
      workspace: new ObservedWorkspace(fileSystem),
    };
    expect((await runNovelTeaCli(['--json', 'validate'], options)).exitCode).toBe(4);

    const traitsPath = path.join(root, 'traits.json');
    const traits = JSON.parse(await readFile(traitsPath, 'utf8')) as Record<string, unknown>;
    traits.shared = {
      id: 'shared',
      label: 'Shared',
      ownerKinds: ['room'],
      properties: [],
    };
    await writeFile(traitsPath, JSON.stringify(traits));
    const incremental = await runNovelTeaCli(['--json', 'validate'], options);
    const fresh = await runNovelTeaCli(['--json', 'validate'], {
      ...options,
      forceAuthoringCacheRebuild: true,
    });
    expect(incremental).toEqual(fresh);
    expect(incremental.exitCode).toBe(0);
    expect(work[1]!.executed).toBeGreaterThan(0);
    expect(work[1]!.reused).toBeGreaterThan(0);
    expect(work[1]!.executed).toBeLessThan(work[0]!.executed);
    expect(work[2]!.reused).toBe(0);

    const currentGeneration = await generation(root);
    const artifact = JSON.parse(
      await readFile(
        path.join(
          root,
          '.noveltea/cache/authoring/generations',
          currentGeneration,
          'contributions.json',
        ),
        'utf8',
      ),
    ) as {
      entries: Array<{ path: string; localDiagnostics: Array<{ message: string }> }>;
    };
    const room = artifact.entries.find((entry) => entry.path === 'records/rooms/start.json');
    expect(room?.localDiagnostics.some((item) => item.message.includes("Trait 'shared'"))).toBe(
      false,
    );
  });

  it('binds cached source analyses to the complete analyzed-source revision set', async () => {
    const root = await fixture(true, (project) => {
      project.scripts.other = createDefaultAuthoringRecord(
        'scripts',
        'other',
      ) as typeof project.scripts.other;
      project.scripts.other!.data.source = {
        kind: 'inline-lua',
        source: 'local other = "value"',
      };
    });
    const nativeTools = tools();
    expect(
      (await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools })).exitCode,
    ).toBe(0);
    const currentGeneration = await generation(root);
    const artifact = JSON.parse(
      await readFile(
        path.join(
          root,
          '.noveltea/cache/authoring/generations',
          currentGeneration,
          'contributions.json',
        ),
        'utf8',
      ),
    ) as {
      sourceAnalyses: Array<{
        sourceRevisions: Array<{ path: string }>;
      }>;
    };
    const analysis = artifact.sourceAnalyses.find((entry) =>
      entry.sourceRevisions.some((revision) => revision.path === 'scripts/logic.lua'),
    );
    expect(analysis?.sourceRevisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'scripts/logic.lua' }),
        expect.objectContaining({ path: 'scripts/other.lua' }),
      ]),
    );
  });

  it('persists and re-admits exact Asset-backed source-analysis revisions', async () => {
    const sourceText = 'local value = "asset-backed"\n';
    const contentHash = await sha256PrefixedUtf8(sourceText);
    const root = await fixture(false, (project) => {
      project.assets['script-source'] = {
        id: 'script-source',
        label: 'Script Source',
        data: {
          kind: 'script',
          source: { type: 'project-file', path: 'assets/lua/shared.lua' },
          aliases: [],
          extension: '.lua',
          byteSize: sourceText.length,
          contentHash,
          imageMetadata: null,
        },
      } as never;
      project.scripts.logic = createDefaultAuthoringRecord(
        'scripts',
        'logic',
      ) as typeof project.scripts.logic;
      project.scripts.logic!.data.source = {
        kind: 'asset',
        asset: { $ref: { collection: 'assets', id: 'script-source' } },
      };
    });
    const sourcePath = path.join(root, 'assets/lua/shared.lua');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, sourceText);
    const nativeTools = tools();
    expect(
      (await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools })).exitCode,
    ).toBe(0);

    const currentGeneration = await generation(root);
    const artifact = JSON.parse(
      await readFile(
        path.join(
          root,
          '.noveltea/cache/authoring/generations',
          currentGeneration,
          'contributions.json',
        ),
        'utf8',
      ),
    ) as {
      externalSourceRevisions: Array<{ path: string; contentHash: string }>;
      sourceAnalyses: Array<{
        sourceRevisions: Array<{ path: string; contentHash: string }>;
      }>;
    };
    expect(artifact.externalSourceRevisions).toContainEqual({
      path: 'assets/lua/shared.lua',
      contentHash,
      byteSize: sourceText.length,
    });
    expect(
      artifact.sourceAnalyses.some((entry) =>
        entry.sourceRevisions.some(
          (revision) =>
            revision.path === 'assets/lua/shared.lua' && revision.contentHash === contentHash,
        ),
      ),
    ).toBe(true);

    const touched = new Date(Date.now() + 5_000);
    await utimes(sourcePath, touched, touched);
    let rehashed = false;
    class AssetMetadataMissReads extends NodeProjectWorkspaceFileSystem {
      override async readBytes(file: string) {
        if (file === sourcePath) rehashed = true;
        return super.readBytes(file);
      }
    }
    const reusable = await readReusableAuthoringContributions(new AssetMetadataMissReads(), root);
    expect(rehashed).toBe(true);
    expect(
      reusable?.sourceAnalyses.some((entry) =>
        entry.sourceRevisions.some((revision) => revision.path === 'assets/lua/shared.lua'),
      ),
    ).toBe(true);

    await writeFile(sourcePath, 'local value = "asset-changed"\n');
    const changed = await readReusableAuthoringContributions(
      new NodeProjectWorkspaceFileSystem(),
      root,
    );
    expect(
      changed?.sourceAnalyses.some((entry) =>
        entry.sourceRevisions.some((revision) => revision.path === 'assets/lua/shared.lua'),
      ),
    ).toBe(false);
  });

  it('invalidates a semantic contribution when a declared derivation source changes', async () => {
    const root = await fixture(false, (project) => {
      project.rooms.start!.data.description = {
        source: { kind: 'localized', key: 'room.start.description' },
        markup: 'plain',
      };
      project.localization.messages['018f4f8c-9b5d-7ae2-9b36-4c8af613f010'] = {
        kind: 'named',
        key: 'room.start.description',
        source: 'Start room',
      };
    });
    const nativeTools = tools();
    expect(
      (await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools })).exitCode,
    ).toBe(0);

    const currentGeneration = await generation(root);
    const artifact = JSON.parse(
      await readFile(
        path.join(
          root,
          '.noveltea/cache/authoring/generations',
          currentGeneration,
          'contributions.json',
        ),
        'utf8',
      ),
    ) as {
      dependencyContributions: Array<{
        sourceRevisions: Array<{ path: string }>;
        contribution: { ownerPath?: string };
      }>;
    };
    const roomContribution = artifact.dependencyContributions.find(
      (entry) => entry.contribution.ownerPath === '/rooms/start',
    );
    expect(roomContribution?.sourceRevisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'records/rooms/start.json' }),
        expect.objectContaining({ path: 'i18n/messages.json' }),
        expect.objectContaining({ path: 'i18n/project.json' }),
      ]),
    );

    const messagesPath = path.join(root, 'i18n/messages.json');
    await writeFile(messagesPath, `${await readFile(messagesPath, 'utf8')}\n`);
    const reusable = await readReusableAuthoringContributions(
      new NodeProjectWorkspaceFileSystem(),
      root,
    );
    expect(
      reusable?.dependencyContributions.some(
        (entry) => (entry.contribution as { ownerPath?: string }).ownerPath === '/rooms/start',
      ),
    ).toBe(false);
  });

  it('reuses unchanged parsed and semantic contributions after a source changes', async () => {
    const root = await fixture(true);
    const other = createDefaultAuthoringRecord('rooms', 'other');
    const otherPath = path.join(root, 'records/rooms/other.json');
    await writeFile(otherPath, JSON.stringify(other));
    const nativeTools = tools();
    expect(
      (await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools })).exitCode,
    ).toBe(0);

    const changedPath = path.join(root, 'records/rooms/start.json');
    const changed = JSON.parse(await readFile(changedPath, 'utf8')) as Record<string, unknown>;
    changed.label = 'Changed start room';
    await writeFile(changedPath, JSON.stringify(changed));

    const reusable = await readReusableAuthoringContributions(
      new NodeProjectWorkspaceFileSystem(),
      root,
    );
    expect(reusable?.sourceContributions['records/rooms/other.json']).toBeDefined();
    expect(reusable?.sourceContributions['records/rooms/start.json']).toBeUndefined();
    expect(
      reusable?.dependencyContributions.some(
        (entry) => (entry.contribution as { ownerPath?: string }).ownerPath === '/rooms/other',
      ),
    ).toBe(true);
    expect(
      reusable?.dependencyContributions.some(
        (entry) => (entry.contribution as { ownerPath?: string }).ownerPath === '/rooms/start',
      ),
    ).toBe(false);
    expect(
      reusable?.sourceAnalyses.some((entry) =>
        entry.sourceRevisions.some((revision) => revision.path === 'scripts/logic.lua'),
      ),
    ).toBe(true);

    class IncrementalReads extends NodeProjectWorkspaceFileSystem {
      private unrelated(file: string) {
        return file === otherPath;
      }
      override async readText(file: string) {
        if (this.unrelated(file)) throw new Error('Unchanged source text was reread');
        return super.readText(file);
      }
      override async readBytes(file: string) {
        if (this.unrelated(file)) throw new Error('Unchanged source bytes were reread');
        return super.readBytes(file);
      }
      override async readFileRevision(file: string) {
        if (this.unrelated(file)) throw new Error('Unchanged source was rehashed');
        return super.readFileRevision(file);
      }
    }

    const dependencyWork: Array<{
      derivedContributions: number;
      reusedContributions: number;
      analyzedOwners: number;
      reusedSourceAnalyses: number;
    }> = [];
    class ObservedIncrementalWorkspace extends ProjectWorkspaceService {
      override async buildDependencyGraphAnalysis(
        ...args: Parameters<ProjectWorkspaceService['buildDependencyGraphAnalysis']>
      ) {
        const analysis = await super.buildDependencyGraphAnalysis(...args);
        dependencyWork.push(analysis.work);
        return analysis;
      }
    }
    const incrementalFileSystem = new IncrementalReads();
    const incremental = await runNovelTeaCli(['--json', 'validate'], {
      cwd: root,
      nativeTools,
      fileSystem: incrementalFileSystem,
      workspace: new ObservedIncrementalWorkspace(incrementalFileSystem),
    });
    expect(incremental.exitCode).toBe(0);
    expect(dependencyWork).toHaveLength(1);
    expect(dependencyWork[0]!.reusedContributions).toBeGreaterThan(0);
    expect(dependencyWork[0]!.derivedContributions).toBeGreaterThan(0);
    expect(dependencyWork[0]!.derivedContributions).toBeLessThan(
      dependencyWork[0]!.reusedContributions,
    );
    await rm(path.join(root, '.noveltea/cache/authoring/current'));
    const fresh = await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools });
    expect(incremental).toEqual(fresh);
  });

  it('rehashes a metadata-only change and reuses the exact parsed contribution', async () => {
    const root = await fixture();
    const nativeTools = tools();
    expect(
      (await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools })).exitCode,
    ).toBe(0);
    const sourcePath = path.join(root, 'records/rooms/start.json');
    const touched = new Date(Date.now() + 5_000);
    await utimes(sourcePath, touched, touched);
    let hashedTouchedSource = false;

    class MetadataMissReads extends NodeProjectWorkspaceFileSystem {
      override async readText(file: string) {
        if (file === sourcePath) throw new Error('Touched source was reparsed');
        return super.readText(file);
      }
      override async readBytes(file: string) {
        if (file === sourcePath) hashedTouchedSource = true;
        return super.readBytes(file);
      }
      override async readFileRevision(file: string) {
        if (file === sourcePath)
          throw new Error('Touched source was rehashed after cache admission');
        return super.readFileRevision(file);
      }
    }

    const work: Array<{ executed: number; reused: number }> = [];
    class ObservedWorkspace extends ProjectWorkspaceService {
      override async open(...args: Parameters<ProjectWorkspaceService['open']>) {
        const opened = await super.open(...args);
        if (opened.ok) work.push(opened.validationWork);
        return opened;
      }
    }
    const metadataMissFileSystem = new MetadataMissReads();
    const options = {
      cwd: root,
      nativeTools,
      fileSystem: metadataMissFileSystem,
      workspace: new ObservedWorkspace(metadataMissFileSystem),
    };
    const incremental = await runNovelTeaCli(['--json', 'validate'], options);
    const freshFileSystem = new NodeProjectWorkspaceFileSystem();
    const fresh = await runNovelTeaCli(['--json', 'validate'], {
      cwd: root,
      nativeTools,
      fileSystem: freshFileSystem,
      workspace: new ObservedWorkspace(freshFileSystem),
      forceAuthoringCacheRebuild: true,
    });
    expect(incremental).toEqual(fresh);
    expect(incremental.exitCode).toBe(0);
    expect(hashedTouchedSource).toBe(true);
    expect(work[0]!.reused).toBeGreaterThan(0);
    expect(work[1]!.reused).toBe(0);
  });

  it('falls back to full validation when candidate source inventory changes', async () => {
    const root = await fixture();
    const other = createDefaultAuthoringRecord('rooms', 'other');
    const otherPath = path.join(root, 'records/rooms/other.json');
    await writeFile(otherPath, JSON.stringify(other));
    const nativeTools = tools();
    expect(
      (await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools })).exitCode,
    ).toBe(0);

    const added = createDefaultAuthoringRecord('rooms', 'added');
    await writeFile(path.join(root, 'records/rooms/added.json'), JSON.stringify(added));
    let rereadUnchangedSource = false;
    const work: Array<{ executed: number; reused: number }> = [];
    class StructuralChangeReads extends NodeProjectWorkspaceFileSystem {
      override async readText(file: string) {
        if (file === otherPath) rereadUnchangedSource = true;
        return super.readText(file);
      }
    }
    class ObservedWorkspace extends ProjectWorkspaceService {
      override async open(...args: Parameters<ProjectWorkspaceService['open']>) {
        const opened = await super.open(...args);
        if (opened.ok) work.push(opened.validationWork);
        return opened;
      }
    }
    const structuralChangeFileSystem = new StructuralChangeReads();
    const options = {
      cwd: root,
      nativeTools,
      fileSystem: structuralChangeFileSystem,
      workspace: new ObservedWorkspace(structuralChangeFileSystem),
    };
    const incremental = await runNovelTeaCli(['--json', 'validate'], options);
    const fresh = await runNovelTeaCli(['--json', 'validate'], {
      ...options,
      forceAuthoringCacheRebuild: true,
    });
    expect(incremental).toEqual(fresh);
    expect(incremental.exitCode).toBe(0);
    expect(rereadUnchangedSource).toBe(true);
    expect(work[0]!.reused).toBe(0);
    expect(work[1]!.reused).toBe(0);
  });

  it('falls back to full validation when an authoritative source is deleted', async () => {
    const root = await fixture(false, (project) => {
      project.rooms.other = createDefaultAuthoringRecord(
        'rooms',
        'other',
      ) as typeof project.rooms.start;
    });
    const nativeTools = tools();
    const fileSystem = new NodeProjectWorkspaceFileSystem();
    const work: Array<{ executed: number; reused: number }> = [];
    class ObservedWorkspace extends ProjectWorkspaceService {
      override async open(...args: Parameters<ProjectWorkspaceService['open']>) {
        const opened = await super.open(...args);
        if (opened.ok) work.push(opened.validationWork);
        return opened;
      }
    }
    const options = {
      cwd: root,
      nativeTools,
      fileSystem,
      workspace: new ObservedWorkspace(fileSystem),
    };
    expect((await runNovelTeaCli(['--json', 'validate'], options)).exitCode).toBe(0);
    await rm(path.join(root, 'records/rooms/other.json'));

    const incremental = await runNovelTeaCli(['--json', 'validate'], options);
    const fresh = await runNovelTeaCli(['--json', 'validate'], {
      ...options,
      forceAuthoringCacheRebuild: true,
    });
    expect(incremental).toEqual(fresh);
    expect(incremental.exitCode).toBe(0);
    expect(work[1]!.reused).toBe(0);
    expect(work[2]!.reused).toBe(0);
  });
});
