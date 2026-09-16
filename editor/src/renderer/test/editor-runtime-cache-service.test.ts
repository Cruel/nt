import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { ActiveProjectWorkspaceSession } from '../../main/services/active-project-workspace-session';
import { EditorRuntimeCacheService } from '../../main/services/editor-runtime-cache-service';
import { runNovelTeaCli } from '../../cli/application';
import type { NovelTeaCliNativeToolService } from '../../cli/native-tool-service';
import { createDefaultAuthoringRecord } from '../project/entity-operations';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import {
  createAuthoringProject,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultTestData, defaultTestStep } from '../../shared/project-schema/authoring-tests';
import { PSEUDO_PREVIEW_LOCALE } from '../../shared/pseudo-localization';
import { projectWorkspaceFiles } from '../../shared/project-workspace';
import { createNodeProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';

const roots: string[] = [];

async function createWorkspace(options: Readonly<{ withAsset?: boolean }> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'noveltea-editor-runtime-cache-'));
  roots.push(root);
  const project = createAuthoringProject({ id: 'editor-cache', name: 'Editor Cache' });
  project.rooms.start = createDefaultAuthoringRecord(
    'rooms',
    'start',
  ) as (typeof project.rooms)['start'];
  project.entrypoint = { kind: 'room', id: 'start' };
  project.tests.smoke = { id: 'smoke', label: 'Smoke', data: defaultTestData('Smoke') };
  if (options.withAsset) {
    project.assets.unused = {
      id: 'unused',
      label: 'Unused image',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/unused.png',
        extension: '.png',
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      }),
    };
  }
  for (const [relative, text] of Object.entries(projectWorkspaceFiles(project, project.editor))) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, 'utf8');
  }
  if (options.withAsset) {
    await mkdir(path.join(root, 'assets'), { recursive: true });
    await writeFile(path.join(root, 'assets/unused.png'), new Uint8Array([1, 2, 3, 4]));
  }
  const opened = await createNodeProjectWorkspaceService().open(root);
  if (!opened.ok) throw new Error(opened.diagnostics[0]?.message ?? 'workspace open failed');
  return {
    root,
    project: opened.snapshot.project,
    workspace: ActiveProjectWorkspaceSession.fromOpened(opened),
  };
}

function cloneProject(project: AuthoringProject): AuthoringProject {
  return structuredClone(project);
}

async function currentGeneration(root: string) {
  return (await readFile(path.join(root, '.noveltea/cache/runtime/current'), 'utf8')).trim();
}

async function previewIndex(root: string) {
  return JSON.parse(
    await readFile(path.join(root, '.noveltea/cache/runtime/preview-index.json'), 'utf8'),
  ) as {
    schema: string;
    entries: Array<{ variant: string; generation: string; lastUsedAtMs: number }>;
  };
}

function serviceWithNativeLog(log: Array<{ operation: string; request: unknown }> = []) {
  return new EditorRuntimeCacheService(async (operation, request) => {
    log.push({ operation, request });
    if (operation === 'compile-shaders')
      return { ok: true, success: true, diagnostics: [], outputs: [] };
    if (operation === 'run-test' || operation === 'run-ui-test')
      return {
        ok: true,
        success: true,
        diagnostics: [],
        report: { schema: 'noveltea.editor.playback-report', version: 1, passed: true },
      };
    if (operation === 'run-test-suite') {
      const entries = (
        (request as { catalog?: { entries?: Array<{ id: string; status: string }> } }).catalog
          ?.entries ?? []
      ).map((entry) => ({
        id: entry.id,
        runner: entry.status === 'runnable' ? 'runtime' : null,
        status: entry.status === 'runnable' ? 'passed' : 'blocked',
        ...(entry.status === 'runnable'
          ? { report: { schema: 'noveltea.editor.playback-report', version: 1, passed: true } }
          : {
              diagnostics: [{ severity: 'error', path: `/tests/${entry.id}`, message: 'blocked' }],
            }),
      }));
      const blocked = entries.filter((entry) => entry.status === 'blocked').length;
      return {
        ok: true,
        success: true,
        report: {
          schema: 'noveltea.test-suite-report',
          counts: {
            total: entries.length,
            passed: entries.length - blocked,
            failed: 0,
            blocked,
            error: 0,
          },
          entries,
        },
      };
    }
    throw new Error(`Unexpected native operation '${operation}'.`);
  });
}

function cliNativeTools(projects: unknown[]): NovelTeaCliNativeToolService {
  return {
    async compileShaders() {
      return { ok: true, success: true, diagnostics: [], outputs: [] };
    },
    async runHeadlessTest(request) {
      projects.push((request as { project: unknown }).project);
      return { ok: true, success: true };
    },
    async runTestSuite() {
      return {
        ok: true,
        success: true,
        report: {
          schema: 'noveltea.test-suite-report',
          counts: { total: 1, passed: 1, failed: 0, blocked: 0, error: 0 },
          entries: [],
        },
      };
    },
    async runUiTest() {
      return { ok: true, success: true };
    },
    async exportPackage() {
      return { ok: true, success: true };
    },
    async validateFontCoverage() {
      return { ok: true, success: true, diagnostics: [] };
    },
    shaderc() {
      return 0;
    },
    texturec() {
      return 0;
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('editor persistent runtime cache', () => {
  it('refuses to publish stale editor content against a newly changed disk snapshot', async () => {
    const { root, project, workspace } = await createWorkspace();
    const roomPath = path.join(root, 'records', 'rooms', 'start.json');
    const diskRoom = JSON.parse(await readFile(roomPath, 'utf8')) as Record<string, unknown>;
    diskRoom.label = 'Externally Changed';
    await writeFile(roomPath, `${JSON.stringify(diskRoom, null, 2)}\n`, 'utf8');

    const result = await serviceWithNativeLog().preparePlay(workspace, project, {});

    expect(result).toMatchObject({
      status: 'prepared',
      cache: {
        scope: 'persistent-canonical',
        observation: {
          published: false,
          publicationReason: 'workspace-source-changed-during-preparation',
        },
      },
    });
  });

  it('publishes clean canonical Play and reuses the generation on the next preparation', async () => {
    const { root, project, workspace } = await createWorkspace();
    const service = serviceWithNativeLog();

    const first = await service.preparePlay(workspace, project, {});
    const generation = await currentGeneration(root);
    const second = await service.preparePlay(workspace, project, {});

    expect(first).toMatchObject({
      status: 'prepared',
      buildContext: { kind: 'canonical' },
      cache: {
        scope: 'persistent-canonical',
        status: 'prepared',
        observation: { status: 'miss', published: true },
      },
    });
    expect(second).toMatchObject({
      status: 'prepared',
      cache: {
        scope: 'persistent-canonical',
        status: 'hit',
        observation: { status: 'hit', testCatalogStatus: 'hit' },
      },
    });
    expect(await currentGeneration(root)).toBe(generation);
  });

  it('rebuilds stale clean inputs and republishes without treating them as editor dirtiness', async () => {
    const { root, project, workspace } = await createWorkspace({ withAsset: true });
    const service = serviceWithNativeLog();
    const first = await service.preparePlay(workspace, project, {});
    expect(first.status).toBe('prepared');
    const originalGeneration = await currentGeneration(root);

    await writeFile(path.join(root, 'assets/unused.png'), new Uint8Array([4, 3, 2, 1, 0]));
    const rebuilt = await service.preparePlay(workspace, project, {});

    expect(rebuilt).toMatchObject({
      status: 'prepared',
      cache: {
        scope: 'persistent-canonical',
        status: 'prepared',
        observation: { status: 'stale', published: true },
      },
    });
    expect(await currentGeneration(root)).not.toBe(originalGeneration);
  });

  it('keeps compilation-relevant dirty Project state session-local and never republishes it', async () => {
    const { root, project, workspace } = await createWorkspace();
    const service = serviceWithNativeLog();
    await service.preparePlay(workspace, project, {});
    const generation = await currentGeneration(root);
    const dirty = cloneProject(project);
    dirty.project.name = 'Unsaved name';

    const result = await service.preparePlay(workspace, dirty, {});

    expect(result).toEqual({
      status: 'session-local',
      buildContext: { kind: 'canonical' },
      reason: 'project-content-dirty',
    });
    expect(await currentGeneration(root)).toBe(generation);
  });

  it('ignores editor/Test-only dirtiness for Play but rejects pending runtime compilation input', async () => {
    const { project, workspace } = await createWorkspace();
    const service = serviceWithNativeLog();
    const editorOnly = cloneProject(project);
    editorOnly.editor.explorer.searchQuery = 'unsaved explorer filter';
    const testOnly = cloneProject(project);
    testOnly.tests.smoke!.label = 'Unsaved Test label';

    const editorOnlyResult = await service.preparePlay(workspace, editorOnly, {});
    const testOnlyResult = await service.preparePlay(workspace, testOnly, {
      'record:tests:smoke': {
        '/data/label': {
          text: 'Unsaved Test label',
          diagnosticCode: 'editor.pending-input.invalid',
        },
      },
    });
    const pendingResult = await service.preparePlay(workspace, project, {
      'project:settings': {
        '/settings/display/referenceResolution/width': {
          text: '-',
          diagnosticCode: 'editor.pending-input.invalid',
        },
      },
    });

    expect(editorOnlyResult.status).toBe('prepared');
    expect(editorOnlyResult).toMatchObject({ cache: { scope: 'persistent-canonical' } });
    expect(testOnlyResult.status).toBe('prepared');
    expect(testOnlyResult).toMatchObject({ cache: { scope: 'persistent-canonical' } });
    expect(pendingResult).toEqual({
      status: 'session-local',
      buildContext: { kind: 'canonical' },
      reason: 'pending-compilation-input',
    });
  });

  it('isolates preview locale variants from the canonical persistent generation and caps the LRU', async () => {
    const { root, project, workspace } = await createWorkspace({ withAsset: true });
    const service = serviceWithNativeLog();
    await service.preparePlay(workspace, project, {});
    const canonicalGeneration = await currentGeneration(root);

    const locales = ['fr', 'de', 'es', 'it', 'pt'];
    for (const locale of locales)
      project.localization.locales[locale] = {
        supported: true,
        parentLocale: null,
        fontStack: null,
      };
    // Adopt the locale definitions as saved content without changing the cache through editor-only
    // preview selection. This models a Project that was opened with these locales already persisted.
    const files = projectWorkspaceFiles(project, project.editor);
    for (const [relative, text] of Object.entries(files)) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text, 'utf8');
    }
    const reopened = await createNodeProjectWorkspaceService().open(root);
    if (!reopened.ok) throw new Error('workspace reopen failed');
    workspace.adopt(reopened.snapshot, reopened.editorState);
    const refreshedCanonical = await service.preparePlay(workspace, workspace.project(), {});
    expect(refreshedCanonical.status).toBe('prepared');
    const refreshedCanonicalGeneration = await currentGeneration(root);
    expect(refreshedCanonicalGeneration).not.toBe(canonicalGeneration);

    for (const locale of locales) {
      const preview = cloneProject(workspace.project());
      preview.editor.previewLocale = locale;
      const result = await service.preparePlay(workspace, preview, {});
      expect(result).toMatchObject({
        status: 'prepared',
        buildContext: { kind: 'preview-locale', locale },
        cache: { scope: 'persistent-preview', status: 'prepared' },
      });
      if (result.status === 'prepared')
        expect(result.artifact.fileEntries.every((entry) => !path.isAbsolute(entry.source))).toBe(
          true,
        );
      expect((await previewIndex(root)).entries).toHaveLength(
        Math.min(locales.indexOf(locale) + 1, 4),
      );
    }
    const pseudo = cloneProject(workspace.project());
    pseudo.editor.previewLocale = PSEUDO_PREVIEW_LOCALE;
    const pseudoResult = await service.preparePlay(workspace, pseudo, {});
    expect(pseudoResult).toMatchObject({
      status: 'prepared',
      buildContext: { kind: 'pseudo-preview-locale', locale: PSEUDO_PREVIEW_LOCALE },
      cache: { scope: 'persistent-preview' },
    });
    expect((await previewIndex(root)).entries).toHaveLength(4);
    expect(await currentGeneration(root)).toBe(refreshedCanonicalGeneration);

    const restartedService = serviceWithNativeLog();
    const reusedPreview = cloneProject(workspace.project());
    reusedPreview.editor.previewLocale = PSEUDO_PREVIEW_LOCALE;
    expect(await restartedService.preparePlay(workspace, reusedPreview, {})).toMatchObject({
      status: 'prepared',
      cache: { scope: 'persistent-preview', status: 'hit', observation: { status: 'hit' } },
    });

    const projects: unknown[] = [];
    const cliResult = await runNovelTeaCli(['--json', 'test', 'run', 'smoke'], {
      cwd: root,
      nativeTools: cliNativeTools(projects),
    });
    expect(cliResult.exitCode).toBe(0);
    expect(cliResult.envelope.runtimeCache).toMatchObject({
      status: 'hit',
      testCatalogStatus: 'hit',
    });
    expect(projects).toHaveLength(1);
  });

  it('rebuilds once and retries once when native admission rejects a cached compiled project', async () => {
    const { project, workspace } = await createWorkspace();
    const warmup = serviceWithNativeLog();
    expect(await warmup.runPlaybackTest(workspace, project, 'smoke', {})).toMatchObject({
      ok: true,
    });

    let playbackCalls = 0;
    const recovering = new EditorRuntimeCacheService(async (operation) => {
      if (operation === 'compile-shaders')
        return { ok: true, success: true, diagnostics: [], outputs: [] };
      if (operation === 'run-test') {
        playbackCalls += 1;
        if (playbackCalls === 1)
          return {
            ok: false,
            success: false,
            compiledProjectAdmissionRejected: true,
            error: 'Cached compiled project was rejected.',
          };
        return {
          ok: true,
          success: true,
          report: { schema: 'noveltea.editor.playback-report', version: 1, passed: true },
        };
      }
      throw new Error(`Unexpected native operation '${operation}'.`);
    });

    expect(await recovering.runPlaybackTest(workspace, project, 'smoke', {})).toMatchObject({
      ok: true,
      success: true,
    });
    expect(playbackCalls).toBe(2);
  });

  it('keeps a published canonical generation when later native test launch fails', async () => {
    const { root, project, workspace } = await createWorkspace();
    const service = new EditorRuntimeCacheService(async (operation) => {
      if (operation === 'run-test')
        return { ok: false, success: false, error: 'runtime environment unavailable' };
      throw new Error(`Unexpected native operation '${operation}'.`);
    });

    const result = await service.runPlaybackTest(workspace, project, 'smoke', {});
    const generation = await currentGeneration(root);

    expect(result).toMatchObject({ ok: false, error: 'runtime environment unavailable' });
    expect(generation).not.toBe('');
    const reused = await service.preparePlay(workspace, project, {});
    expect(reused).toMatchObject({
      status: 'prepared',
      cache: { scope: 'persistent-canonical', status: 'hit' },
    });
    expect(await currentGeneration(root)).toBe(generation);
  });

  it('publishes a canonical generation that the CLI immediately reuses', async () => {
    const { root, project, workspace } = await createWorkspace();
    const service = serviceWithNativeLog();
    const prepared = await service.preparePlay(workspace, project, {});
    expect(prepared.status).toBe('prepared');

    const projects: unknown[] = [];
    const result = await runNovelTeaCli(['--json', 'test', 'run', 'smoke'], {
      cwd: root,
      nativeTools: cliNativeTools(projects),
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.runtimeCache).toMatchObject({
      status: 'hit',
      reason: 'current-generation-valid',
      testCatalogStatus: 'hit',
    });
    expect(projects).toHaveLength(1);
  });

  it('runs clean tests from the cached lowered catalog while dirty tests stay session-local', async () => {
    const { project, workspace } = await createWorkspace();
    const nativeCalls: Array<{ operation: string; request: unknown }> = [];
    const service = serviceWithNativeLog(nativeCalls);

    const clean = await service.runPlaybackTest(workspace, project, 'smoke', {});
    const dirty = cloneProject(project);
    dirty.project.name = 'Unsaved';
    const dirtyResult = await service.runPlaybackTest(workspace, dirty, 'smoke', {});

    expect(clean).toMatchObject({ ok: true, report: { passed: true } });
    expect(dirtyResult).toMatchObject({ ok: true, report: { passed: true } });
    expect(nativeCalls.filter((call) => call.operation === 'run-test')).toHaveLength(2);
    expect(await service.preparePlay(workspace, dirty, {})).toMatchObject({
      status: 'session-local',
    });
  });

  it('runs suites through one native operation using cached clean state and session-local dirty state', async () => {
    const { root, project, workspace } = await createWorkspace();
    const nativeCalls: Array<{ operation: string; request: unknown }> = [];
    const service = serviceWithNativeLog(nativeCalls);

    const clean = await service.runPlaybackSuite(workspace, project, {});
    const generation = await currentGeneration(root);
    const dirty = cloneProject(project);
    const blockedData = defaultTestData('Blocked');
    blockedData.steps = [
      {
        ...defaultTestStep('save'),
        id: 'save-named-slot',
        label: 'Save named slot',
        saveSlot: { slotId: 'named-slot' },
      },
    ];
    blockedData.preview.selectedStepId = 'save-named-slot';
    dirty.tests.blocked = { id: 'blocked', label: 'Blocked', data: blockedData };
    const dirtyResult = await service.runPlaybackSuite(workspace, dirty, {});

    expect(clean).toMatchObject({
      ok: true,
      report: { counts: { total: 1, passed: 1, blocked: 0 } },
    });
    expect(dirtyResult).toMatchObject({
      ok: true,
      report: { counts: { total: 2, passed: 1, blocked: 1 } },
    });
    const suiteCalls = nativeCalls.filter((call) => call.operation === 'run-test-suite');
    expect(suiteCalls).toHaveLength(2);
    expect(suiteCalls[0]?.request).toMatchObject({
      projectRoot: root,
      catalog: { schema: 'noveltea.runtime-test-catalog', entries: [{ id: 'smoke' }] },
    });
    expect(suiteCalls[1]?.request).toMatchObject({
      projectRoot: root,
      catalog: {
        schema: 'noveltea.runtime-test-catalog',
        entries: [
          { id: 'blocked', status: 'blocked' },
          { id: 'smoke', status: 'runnable' },
        ],
      },
    });
    expect(await currentGeneration(root)).toBe(generation);
  });
});
