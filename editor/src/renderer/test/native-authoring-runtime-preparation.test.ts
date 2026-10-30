import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { createDefaultAuthoringRecord } from '../project/entity-operations';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';
import {
  NativeWorkingRuntimePreparationCache,
  prepareNativeWorkingRuntime,
  projectFromNativeCompletePreparation,
} from '../../main/services/native-authoring-runtime-preparation';
import type { NativeAuthoringPreparation } from '../../main/services/native-authoring-worker-contract';
import { logicalRuntimeArtifactPaths } from '../../shared/runtime-artifact-preparation';

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
  return { project, prepared };
}

describe('native working Project runtime preparation', () => {
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
        referencedAssetIds: [],
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
          'Native export source changed since admission: assets/asset.bin',
        );
      } finally {
        await cache.clear();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses only the native runtime artifact for Test-only revisions and preserves unsaved recovery', async () => {
    const { project, prepared } = fixture();
    const root = await mkdtemp(path.join(tmpdir(), 'noveltea-native-test-cache-'));
    const cache = new NativeWorkingRuntimePreparationCache();
    try {
      await writeFile(path.join(root, 'project.yaml'), 'source');
      await mkdir(path.join(root, 'records/tests'), { recursive: true });
      const testFile = path.join(root, 'records/tests/smoke.yaml');
      await writeFile(testFile, 'test v1');
      const journal = path.join(root, '.noveltea/editor/native-dirty-state.json');
      await mkdir(path.dirname(journal), { recursive: true });
      await writeFile(journal, 'unsaved native replay evidence');
      const digest = (value: string) =>
        'sha256:' + createHash('sha256').update(value).digest('hex');
      const baseline: NativeAuthoringPreparation = {
        ...prepared,
        referencedAssetIds: [],
        completeProject: project,
        sourceRevisions: {
          'project.yaml': digest('source'),
          'records/tests/smoke.yaml': digest('test v1'),
        },
      };
      const first = await cache.prepare({
        projectRoot: root,
        prepared: baseline,
        paths: logicalRuntimeArtifactPaths,
        testId: 'smoke',
      });
      expect(first.status).toBe('prepared');
      if (first.status !== 'prepared') return;
      const updated = structuredClone(project);
      updated.tests.smoke!.data.steps[0]!.tick.deltaSeconds = 2;
      await writeFile(testFile, 'test v2');
      const next = await cache.prepare({
        projectRoot: root,
        paths: logicalRuntimeArtifactPaths,
        testId: 'smoke',
        prepared: {
          ...baseline,
          workingRevision: baseline.workingRevision + 1,
          completeProject: updated,
          recordOverrides: { ...baseline.recordOverrides, tests: updated.tests },
          sourceRevisions: {
            ...baseline.sourceRevisions,
            'records/tests/smoke.yaml': digest('test v2'),
          },
        },
      });
      expect(next.status).toBe('prepared');
      if (next.status === 'prepared') {
        expect(next.artifact).toBe(first.artifact);
        expect(next.workingRevision).toBe(baseline.workingRevision + 1);
        expect(next.test?.spec).not.toEqual(first.test?.spec);
        await next.dispose();
      }
      await first.dispose();
      await cache.clear();
      expect(await readFile(journal, 'utf8')).toBe('unsaved native replay evidence');
    } finally {
      await cache.clear();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a native-declined dirty preparation without using saved data', async () => {
    const { prepared } = fixture();
    const result = await prepareNativeWorkingRuntime({
      prepared: {
        ...prepared,
        accepted: false,
        error: 'Invalid dirty Lua',
        diagnostics: [
          {
            path: '/scripts/start',
            code: 'native.lua',
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
});
