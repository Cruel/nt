import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { createDefaultAuthoringRecord } from '../project/entity-operations';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';
import {
  NativeWorkingRuntimePreparationCache,
  prepareNativeWorkingRuntime,
  projectFromNativeCompletePreparation,
  projectFromNativeWorkingPreparation,
  runNativeWorkingTest,
} from '../../main/services/native-authoring-runtime-preparation';
import type { NativeAuthoringPreparation } from '../../main/services/native-authoring-worker-contract';
import { logicalRuntimeArtifactPaths } from '../../shared/runtime-artifact-preparation';
import { createNodeProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';

function fixture() {
  const project = createAuthoringProject({ id: 'native-working', name: 'Saved Project' });
  project.rooms.start = createDefaultAuthoringRecord(
    'rooms',
    'start',
  ) as typeof project.rooms.start;
  project.entrypoint = { kind: 'room', id: 'start' };
  project.tests.smoke = { id: 'smoke', label: 'Smoke', data: defaultTestData('Smoke') };
  const revision = 'sha256:' + createHash('sha256').update('source').digest('hex');
  const prepared: NativeAuthoringPreparation = {
    accepted: true,
    error: '',
    workingRevision: 3,
    project: {
      project: { ...project.project, name: 'Dirty Project' },
      settings: project.settings,
      export: project.export,
      bootstrapModule: project.bootstrapModule,
      undefinedInteractionProgram: project.undefinedInteractionProgram,
      entrypoint: project.entrypoint,
      inventories: project.inventories,
      interactableInstances: project.interactableInstances,
      localization: project.localization,
    },
    recordOverrides: {
      rooms: { start: { ...project.rooms.start, label: 'Unsaved Room' } },
      tests: {
        smoke: { ...project.tests.smoke, label: 'Unsaved Test' },
      },
    },
    sourceRevisions: { 'project.yaml': revision },
    textOverlays: {},
    shaderOverlays: {},
    diagnostics: [],
  };
  const savedFiles = {
    fileRevisions: { 'project.yaml': { contentHash: revision, byteSize: 6 } },
  } as Parameters<typeof projectFromNativeWorkingPreparation>[1];
  return { project, prepared, savedFiles };
}

describe('certification-only native working Project runtime preparation', () => {
  it('treats C++ complete record values as authoritative without TypeScript re-normalization', () => {
    const { project, prepared } = fixture();
    const completeProject = {
      ...project,
      rooms: { ...project.rooms },
      tests: { ...project.tests },
    };
    const projected = projectFromNativeCompletePreparation({ ...prepared, completeProject });
    expect(projected.rooms).toBe(completeProject.rooms);
    expect(projected.tests).toBe(completeProject.tests);
    expect(projected.project).toBe(completeProject.project);
    expect(projected).toMatchObject(completeProject);
    expect(() =>
      projectFromNativeCompletePreparation({
        ...prepared,
        completeProject: { ...completeProject, rooms: [] },
      }),
    ).toThrow('malformed rooms transport');
    expect(() =>
      projectFromNativeCompletePreparation({
        ...prepared,
        completeProject: { ...completeProject, schema: 'invalid' },
      }),
    ).toThrow('invalid transport shape');
    expect(() =>
      projectFromNativeCompletePreparation({
        ...prepared,
        completeProject: { ...completeProject, bootstrapModule: null },
      }),
    ).toThrow('invalid transport shape');
  });

  it('compiles from a native-complete Project without a TypeScript saved baseline, rechecking source bytes', async () => {
    const { project, prepared } = fixture();
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-native-complete-'));
    try {
      await writeFile(path.join(root, 'project.yaml'), 'source');
      await mkdir(path.join(root, 'assets'));
      await writeFile(path.join(root, 'assets/asset.bin'), 'asset source');
      const native = {
        ...prepared,
        completeProject: {
          ...project,
          project: { ...project.project, name: 'Native-only Project' },
          rooms: { start: { ...project.rooms.start, label: 'Native-only Room' } },
        },
        sourceRevisions: {
          ...prepared.sourceRevisions,
          'assets/asset.bin': 'sha256:' + createHash('sha256').update('asset source').digest('hex'),
        },
      };
      const options = {
        prepared: native,
        projectRoot: root,
        paths: logicalRuntimeArtifactPaths,
      };
      const result = await prepareNativeWorkingRuntime(options);
      expect(result.status).toBe('prepared');
      if (result.status === 'prepared') {
        expect(result.artifact.manifestPreview.projectName).toBe('Native-only Project');
        await result.dispose();
      }
      const cache = new NativeWorkingRuntimePreparationCache();
      try {
        const cached = await cache.prepare(options);
        expect(cached.status).toBe('prepared');
        if (cached.status === 'prepared') await cached.dispose();
        await writeFile(path.join(root, 'assets/asset.bin'), 'externally changed');
        await expect(cache.prepare(options)).rejects.toThrow(
          'Native complete preparation source changed on disk: assets/asset.bin',
        );
      } finally {
        await cache.clear();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects dirty native records without mutating saved source, and guards source revisions', () => {
    const { project, prepared, savedFiles } = fixture();
    const effective = projectFromNativeWorkingPreparation(project, savedFiles, prepared);
    expect(effective.project.name).toBe('Dirty Project');
    expect(effective.rooms.start?.label).toBe('Unsaved Room');
    expect(effective.tests.smoke?.label).toBe('Unsaved Test');
    expect(project.project.name).toBe('Saved Project');
    expect(project.rooms.start?.label).not.toBe('Unsaved Room');
    expect(() =>
      projectFromNativeWorkingPreparation(project, { fileRevisions: {} }, prepared),
    ).toThrow('differs from the admitted saved workspace');
  });

  it('builds a Play artifact and typed Test spec through the existing runtime pipeline', async () => {
    const { project, prepared, savedFiles } = fixture();
    const options = {
      prepared,
      saved: project,
      savedFiles,
      projectRoot: '/unused-native-test-root',
      paths: logicalRuntimeArtifactPaths,
    };
    const play = await prepareNativeWorkingRuntime(options);
    expect(play.status).toBe('prepared');
    if (play.status === 'prepared') {
      expect(play.workingRevision).toBe(3);
      expect(play.artifact.manifestPreview.projectName).toBe('Dirty Project');
      await play.dispose();
    }
    const test = await prepareNativeWorkingRuntime({ ...options, testId: 'smoke' });
    expect(test.status).toBe('prepared');
    if (test.status === 'prepared') {
      expect(test.test).toMatchObject({ runner: 'runtime', spec: { id: 'smoke' } });
      expect(test.artifact.manifestPreview.projectName).toBe('Dirty Project');
      const invoke = vi.fn(async () => ({ ok: true }));
      await runNativeWorkingTest(test, '/unused-native-test-root', invoke);
      expect(invoke).toHaveBeenCalledWith(
        'run-test',
        expect.objectContaining({
          spec: expect.objectContaining({ id: 'smoke' }),
          project: test.artifact.compiledProject,
        }),
      );
      await runNativeWorkingTest(
        { ...test, test: { ...test.test!, runner: 'runtime-ui' } },
        '/unused-native-test-root',
        invoke,
      );
      expect(invoke).toHaveBeenLastCalledWith(
        'run-ui-test',
        expect.objectContaining({ projectRoot: '/unused-native-test-root' }),
      );
      await test.dispose();
    }
  });

  it('retains the same compiled runtime on a Test-only revision while refreshing Test preparation', async () => {
    const { project, prepared, savedFiles } = fixture();
    const cache = new NativeWorkingRuntimePreparationCache();
    const options = {
      prepared,
      saved: project,
      savedFiles,
      projectRoot: '/unused-native-test-root',
      paths: logicalRuntimeArtifactPaths,
      testId: 'smoke',
    };
    try {
      const [first, concurrent] = await Promise.all([
        cache.prepare(options),
        cache.prepare(options),
      ]);
      expect(first.status).toBe('prepared');
      if (first.status !== 'prepared') return;
      expect(concurrent.status).toBe('prepared');
      if (concurrent.status === 'prepared') {
        expect(concurrent.artifact).toBe(first.artifact);
        await concurrent.dispose();
      }
      await expect(
        cache.prepare({ ...options, savedFiles: { fileRevisions: {} } }),
      ).rejects.toThrow('differs from the admitted saved workspace');
      const revised = structuredClone(prepared);
      revised.workingRevision++;
      revised.recordOverrides.tests!.smoke = {
        ...project.tests.smoke!,
        label: 'Another unsaved Test version',
      };
      revised.sourceRevisions['records/tests/smoke.yaml'] =
        prepared.sourceRevisions['project.yaml']!;
      const updatedSavedFiles = {
        fileRevisions: {
          ...savedFiles.fileRevisions,
          'records/tests/smoke.yaml': {
            contentHash: prepared.sourceRevisions['project.yaml']!,
            byteSize: 1,
          },
        },
      } as typeof savedFiles;
      const second = await cache.prepare({
        ...options,
        prepared: revised,
        savedFiles: updatedSavedFiles,
      });
      expect(second.status).toBe('prepared');
      if (second.status === 'prepared') {
        expect(second.artifact).toBe(first.artifact);
        expect(second.workingRevision).toBe(prepared.workingRevision + 1);
        expect(second.test).toMatchObject({ spec: { id: 'smoke' } });
        await second.dispose();
      }
      const changedSource = structuredClone(revised);
      changedSource.workingRevision++;
      changedSource.textOverlays['scripts/changed.lua'] = 'return 2';
      const third = await cache.prepare({
        ...options,
        prepared: changedSource,
        savedFiles: updatedSavedFiles,
      });
      expect(third.status).toBe('prepared');
      if (third.status === 'prepared') {
        expect(third.artifact).not.toBe(first.artifact);
        await third.dispose();
      }
      await first.dispose();
    } finally {
      await cache.clear();
    }
  });

  it('blocks invalid native working input rather than accidentally reusing saved source', async () => {
    const { project, prepared, savedFiles } = fixture();
    const result = await prepareNativeWorkingRuntime({
      saved: project,
      savedFiles,
      prepared: {
        ...prepared,
        accepted: false,
        error: 'Invalid dirty Lua',
        diagnostics: [
          {
            path: '/scripts/start',
            code: 'authoring.localization.lua_source_literal',
            severity: 'error',
            message: 'Invalid dirty Lua',
          },
        ],
      },
      projectRoot: '/unused-native-test-root',
      paths: logicalRuntimeArtifactPaths,
    });
    expect(result).toMatchObject({
      status: 'blocked',
      diagnostics: [{ message: 'Invalid dirty Lua' }],
    });
  });

  it('stages dirty project-file Lua outside the saved Project for native preview packaging', async () => {
    const { project, prepared, savedFiles } = fixture();
    project.scripts.demo = {
      id: 'demo',
      label: 'Demo Script',
      data: { kind: 'script-module', source: { kind: 'project-file', path: 'scripts/demo.lua' } },
    };
    const text = "local preview = Text.tr('Dirty source')\n";
    prepared.textOverlays['scripts/demo.lua'] = text;
    const result = await prepareNativeWorkingRuntime({
      saved: project,
      prepared,
      savedFiles,
      projectRoot: '/unused-native-test-root',
      paths: logicalRuntimeArtifactPaths,
    });
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    const source = result.artifact.fileEntries.find(
      (entry) => entry.packagePath === 'scripts/demo.lua',
    );
    expect(source?.kind).toBe('script-source');
    expect(source?.source).not.toBe('scripts/demo.lua');
    expect(await readFile(source!.source, 'utf8')).toBe(text);
    await result.dispose();
    await expect(readFile(source!.source, 'utf8')).rejects.toThrow();
  });
});

const addon = process.env.NOVELTEA_AUTHORING_NODE_ADDON;
describe.skipIf(!addon)('native Project ↔ saved workspace preparation differential', () => {
  it('merges native dirty Room, Test and RML revisions into a real saved Feature Lab Project', async () => {
    const root = path.resolve(process.cwd(), '../tests/projects/feature-lab');
    const opened = await createNodeProjectWorkspaceService().open(root, {
      recoverTransactions: false,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const addonModule = createRequire(import.meta.url)(path.resolve(addon!)) as {
      open(root: string): unknown;
      close(handle: unknown): void;
      snapshot(handle: unknown): string;
      prepareWorking(handle: unknown, revision: number, testId: string): string;
      prepareCompleteWorking(handle: unknown, revision: number, testId: string): string;
      patch(handle: unknown, revision: number, patches: string): string;
      stageTextSource(handle: unknown, revision: number, source: string, text: string): string;
    };
    const handle = addonModule.open(root);
    try {
      let revision = (JSON.parse(addonModule.snapshot(handle)) as { workingRevision: number })
        .workingRevision;
      const baseline = JSON.parse(
        addonModule.prepareWorking(handle, revision, ''),
      ) as NativeAuthoringPreparation;
      const completeBaseline = JSON.parse(
        addonModule.prepareCompleteWorking(handle, revision, ''),
      ) as NativeAuthoringPreparation;
      expect(completeBaseline.accepted, completeBaseline.error).toBe(true);
      expect(projectFromNativeCompletePreparation(completeBaseline)).toEqual(
        opened.snapshot.project,
      );
      const saved = projectFromNativeWorkingPreparation(
        opened.snapshot.project,
        opened.snapshot,
        baseline,
      );
      expect(saved.project.name).toBe(opened.snapshot.project.project.name);
      const edit = JSON.parse(
        addonModule.patch(
          handle,
          revision,
          JSON.stringify([
            { operation: 'replace', path: '/project/name', value: 'Unsaved native preview' },
            {
              operation: 'replace',
              path: '/tests/world-composition-flow/label',
              value: 'Edited Test',
            },
          ]),
        ),
      ) as { accepted: boolean; snapshot: { workingRevision: number } };
      expect(edit.accepted).toBe(true);
      revision = edit.snapshot.workingRevision;
      const staged = JSON.parse(
        addonModule.stageTextSource(
          handle,
          revision,
          'records/layouts/notice-board/layout.rml',
          '<rml><body><nt-tr>Dirty RML</nt-tr></body></rml>',
        ),
      ) as { accepted: boolean; snapshot: { workingRevision: number } };
      expect(staged.accepted).toBe(true);
      revision = staged.snapshot.workingRevision;
      const prepared = JSON.parse(
        addonModule.prepareWorking(handle, revision, 'world-composition-flow'),
      ) as NativeAuthoringPreparation;
      expect(prepared.accepted).toBe(true);
      const projection = projectFromNativeWorkingPreparation(
        opened.snapshot.project,
        opened.snapshot,
        prepared,
      );
      expect(projection.project.name).toBe('Unsaved native preview');
      const completeDirty = JSON.parse(
        addonModule.prepareCompleteWorking(handle, revision, 'world-composition-flow'),
      ) as NativeAuthoringPreparation;
      expect(completeDirty.accepted, completeDirty.error).toBe(true);
      expect(projectFromNativeCompletePreparation(completeDirty)).toEqual(projection);
      expect(projection.tests['world-composition-flow']?.label).toBe('Edited Test');
      expect(projection.layouts['notice-board']?.data.rml).toMatchObject({
        sourceText: '<rml><body><nt-tr>Dirty RML</nt-tr></body></rml>',
      });
      expect(opened.snapshot.project.project.name).toBe('Feature Lab');
      const invalid = JSON.parse(
        addonModule.patch(
          handle,
          revision,
          JSON.stringify([
            {
              operation: 'replace',
              path: '/rooms/room-lifecycle-roundtrip/data/presentationSpace/size/width',
              value: -1,
            },
          ]),
        ),
      ) as { accepted: boolean; snapshot: { workingRevision: number } };
      expect(invalid.accepted).toBe(true);
      const blocked = JSON.parse(
        addonModule.prepareCompleteWorking(handle, invalid.snapshot.workingRevision, ''),
      ) as NativeAuthoringPreparation;
      expect(blocked.accepted).toBe(false);
      expect(blocked.completeProject).toBeNull();
      expect(blocked.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
    } finally {
      addonModule.close(handle);
    }
  }, 120_000);
});
