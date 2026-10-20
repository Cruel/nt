import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import { parseNovelTeaCliGlobals } from '../../cli/bootstrap';
import { runNativeProjectTestsCli } from '../../cli/native-project-tests-cli';
import type { NovelTeaCliNativeToolService } from '../../cli/native-tool-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultTestData, defaultTestStep } from '../../shared/project-schema/authoring-tests';
import { logicalRuntimeArtifactPaths } from '../../shared/runtime-artifact-preparation';
import { createDefaultAuthoringRecord } from '../project/entity-operations';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-tests-'));
  roots.push(root);
  const yaml = 'malformed: [yaml\n';
  await writeFile(path.join(root, 'project.yaml'), yaml);
  const project = createAuthoringProject({ id: 'native-tests', name: 'Native Tests' });
  project.rooms.start = createDefaultAuthoringRecord(
    'rooms',
    'start',
  ) as typeof project.rooms.start;
  project.entrypoint = { kind: 'room', id: 'start' };
  const semantic = defaultTestData('Semantic');
  semantic.steps = [{ ...defaultTestStep('tick'), id: 'tick', label: 'Tick' }];
  semantic.preview.selectedStepId = 'tick';
  project.tests.semantic = { id: 'semantic', label: 'Semantic', data: semantic };
  const ui = defaultTestData('UI');
  ui.steps = [
    {
      ...defaultTestStep('ui-click'),
      id: 'click',
      uiClick: { documentId: 'runtime_game', mountInstanceId: null, selector: '#go' },
    },
  ];
  ui.preview.selectedStepId = 'click';
  project.tests.ui = { id: 'ui', label: 'UI', data: ui };
  const sha = `sha256:${createHash('sha256').update(yaml).digest('hex')}`;
  const prepared = {
    project,
    sourceGeneration: 'native-admitted-generation',
    sourceRevisions: { 'project.yaml': sha, 'traits.yaml': 'absent', 'editor.yaml': 'absent' },
    sourceOverlays: {},
    referencedAssetIds: [],
    cliDiagnostics: [],
  };
  return { root, project, prepared };
}

function tools(requests: { runner: string; request: unknown }[]): NovelTeaCliNativeToolService {
  return {
    async compileShaders() {
      return { ok: true, success: true, outputs: [], diagnostics: [] };
    },
    async runHeadlessTest(request) {
      requests.push({ runner: 'runtime', request });
      return { ok: true, success: true, report: { passed: true } };
    },
    async runUiTest(request) {
      requests.push({ runner: 'ui', request });
      return { ok: true, success: true, report: { passed: true } };
    },
    async runTestSuite(request) {
      requests.push({ runner: 'suite', request });
      return {
        ok: true,
        success: true,
        report: { entries: [], counts: { passed: 0, failed: 0, blocked: 0, error: 0 } },
      };
    },
    async exportPackage() {
      throw new Error('Not used.');
    },
    shaderc() {
      return 0;
    },
    texturec() {
      return 0;
    },
  };
}

it('routes all four forms through admitted native authority and the existing runners', async () => {
  const { root, prepared } = await fixture();
  const requests: { runner: string; request: unknown }[] = [];
  const nativeActions: string[] = [];
  const native = (request: Readonly<Record<string, unknown>>) => {
    nativeActions.push(request.action as string);
    return request.action === 'shader-preparation' ? { ok: true, ...prepared } : { ok: true };
  };
  for (const [command, input] of [
    [['test', 'run', 'semantic'], undefined],
    [['test', 'run', 'ui'], undefined],
    [['test', 'run'], undefined],
    [['test', 'run-spec'], '{"steps":[]}'],
    [['test', 'run-ui-spec'], '{"steps":[]}'],
  ] as const) {
    const result = await runNovelTeaCli(['--json', ...command], {
      cwd: root,
      nativeProjectCommands: native,
      nativeTools: tools(requests),
      ...(input ? { stdinText: input } : {}),
    });
    expect(
      result.exitCode,
      `${command.join(' ')}: ${JSON.stringify(result.envelope.diagnostics)}`,
    ).toBe(0);
    expect(result.envelope.success).toBe(true);
  }
  expect(requests.map((request) => request.runner)).toEqual([
    'runtime',
    'ui',
    'suite',
    'runtime',
    'ui',
  ]);
  expect(nativeActions).toEqual([
    'shader-preparation',
    'source-generation-proof',
    'source-generation-proof',
    'source-generation-proof',
    'shader-preparation',
    'source-generation-proof',
    'source-generation-proof',
    'source-generation-proof',
    'shader-preparation',
    'source-generation-proof',
    'source-generation-proof',
    'source-generation-proof',
    'shader-preparation',
    'source-generation-proof',
    'source-generation-proof',
    'source-generation-proof',
    'shader-preparation',
    'source-generation-proof',
    'source-generation-proof',
    'source-generation-proof',
  ]);
});

it('never readmits the Project from disk when a worker has a native pinned generation', async () => {
  const { root, prepared } = await fixture();
  const requests: { runner: string; request: unknown }[] = [];
  const result = await runNativeProjectTestsCli(
    parseNovelTeaCliGlobals(['--json', 'test', 'run', 'semantic']),
    root,
    () => {
      throw new Error('Pinned worker attempted native disk admission.');
    },
    tools(requests),
    {
      pinned: { projectRoot: root, preparation: prepared },
      paths: logicalRuntimeArtifactPaths,
      pinnedProjectTextSources: {},
      pinnedExternalAssets: [],
    },
  );
  expect(result?.exitCode).toBe(0);
  expect(requests).toHaveLength(1);
});

it('rejects native source drift instead of executing and does not retry a newer generation', async () => {
  const { root, prepared } = await fixture();
  const requests: { runner: string; request: unknown }[] = [];
  let calls = 0;
  const result = await runNativeProjectTestsCli(
    parseNovelTeaCliGlobals(['--json', 'test', 'run-spec']),
    root,
    (request) => {
      calls++;
      return request.action === 'shader-preparation'
        ? { ok: true, ...prepared }
        : { ok: false, kind: 'conflict', error: 'Project changed after native admission.' };
    },
    tools(requests),
    { readStdinText: () => '{"steps":[]}' },
  );
  expect(result?.exitCode).toBe(5);
  expect(requests).toHaveLength(0);
  expect(calls).toBe(2);
});

it('preserves native Project semantic admission failures as validation rather than filesystem errors', async () => {
  const { root } = await fixture();
  const result = await runNativeProjectTestsCli(
    parseNovelTeaCliGlobals(['--json', 'test', 'run']),
    root,
    () => ({
      ok: false,
      error: 'Full native working Project validation failed.',
      projectDiagnostics: [
        {
          code: 'room.entrypoint.invalid',
          path: '/entrypoint',
          severity: 'error',
          message: 'Invalid Room reference.',
        },
      ],
    }),
    tools([]),
  );
  expect(result?.exitCode).toBe(4);
  expect(result?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'room.entrypoint.invalid', path: '/entrypoint' }),
  );
  expect(result?.envelope.diagnostics).not.toContainEqual(
    expect.objectContaining({ code: 'WORKSPACE_SOURCE_READ' }),
  );
});

it('rejects missing pinned preparation and malformed stdin without admitting disk sources', async () => {
  const { root } = await fixture();
  const native = () => {
    throw new Error('Disk must not be opened.');
  };
  const missing = await runNativeProjectTestsCli(
    parseNovelTeaCliGlobals(['--json', 'test', 'run']),
    root,
    native,
    tools([]),
    { pinned: { projectRoot: root, preparation: null } },
  );
  expect(missing?.exitCode).toBe(70);
  const stdin = await runNativeProjectTestsCli(
    parseNovelTeaCliGlobals(['--json', 'test', 'run-ui-spec']),
    root,
    native,
    tools([]),
    { readStdinText: () => '{invalid' },
  );
  expect(stdin?.exitCode).toBe(2);
});

it('retains per-Test failure diagnostics and treats native runner exceptions as infrastructure errors', async () => {
  const { root, prepared } = await fixture();
  const native = (request: Readonly<Record<string, unknown>>) =>
    request.action === 'shader-preparation' ? { ok: true, ...prepared } : { ok: true };
  const requests: { runner: string; request: unknown }[] = [];
  const failed = await runNativeProjectTestsCli(
    parseNovelTeaCliGlobals(['--json', 'test', 'run', 'semantic']),
    root,
    native,
    {
      ...tools(requests),
      async runHeadlessTest() {
        return {
          ok: true,
          success: false,
          report: {
            passed: false,
            diagnostics: [
              { severity: 'error', path: '/steps/tick', message: 'Incorrect runtime state.' },
            ],
          },
        };
      },
    },
  );
  expect(failed?.exitCode).toBe(6);
  expect(failed?.envelope.native).toMatchObject({ report: { passed: false } });
  expect(failed?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({
      code: 'native.test.failed',
      path: '/steps/tick',
      message: 'Incorrect runtime state.',
    }),
  );
  const crashed = await runNativeProjectTestsCli(
    parseNovelTeaCliGlobals(['--json', 'test', 'run-ui-spec']),
    root,
    native,
    {
      ...tools(requests),
      async runUiTest() {
        throw new Error('UI runner process exited.');
      },
    },
    { readStdinText: () => '{"steps":[]}' },
  );
  expect(crashed?.exitCode).toBe(6);
  expect(crashed?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'native.test', message: 'UI runner process exited.' }),
  );
});

it('keeps blocked authored Tests out of single runner dispatch and exposes blocked-only suites', async () => {
  const { root, project, prepared } = await fixture();
  project.tests.blocked = { id: 'blocked', label: 'Blocked', data: defaultTestData('Blocked') };
  project.tests.blocked.data.steps = [];
  const native = (request: Readonly<Record<string, unknown>>) =>
    request.action === 'shader-preparation' ? { ok: true, ...prepared } : { ok: true };
  const requests: { runner: string; request: unknown }[] = [];
  const blocked = await runNativeProjectTestsCli(
    parseNovelTeaCliGlobals(['--json', 'test', 'run', 'blocked']),
    root,
    native,
    tools(requests),
  );
  expect(blocked?.exitCode).not.toBe(0);
  expect(requests).toHaveLength(0);
  expect(blocked?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({
      code: 'native.test.spec',
      path: expect.stringContaining('/tests/blocked'),
    }),
  );
  const suite = await runNativeProjectTestsCli(
    parseNovelTeaCliGlobals(['--json', 'test', 'run']),
    root,
    native,
    {
      ...tools(requests),
      async runTestSuite(request) {
        requests.push({ runner: 'suite', request });
        return {
          ok: true,
          success: true,
          report: {
            entries: [
              {
                id: 'blocked',
                status: 'blocked',
                diagnostics: [{ path: '/tests/blocked/data', message: 'No steps.' }],
              },
            ],
            counts: { passed: 0, failed: 0, blocked: 1, error: 0 },
          },
        };
      },
    },
  );
  expect(suite?.exitCode).toBe(0);
  expect(
    (requests[0]!.request as { catalog: { entries: { id: string; status: string }[] } }).catalog
      .entries,
  ).toContainEqual(expect.objectContaining({ id: 'blocked', status: 'blocked' }));
});

it('reuses a canonical native runtime across a Test-only edit and rebuilds on cache rejection', async () => {
  const { root, project, prepared } = await fixture();
  // The C++ owner sends object keys sorted; the parsed cache schema restores
  // canonical schema order. This must not invalidate an unchanged profile.
  project.export.runtime = Object.fromEntries(
    Object.entries(project.export.runtime).sort(([left], [right]) => left.localeCompare(right)),
  ) as typeof project.export.runtime;
  const native = (request: Readonly<Record<string, unknown>>) =>
    request.action === 'shader-preparation' ? { ok: true, ...prepared } : { ok: true };
  let calls = 0;
  let rejectCached = false;
  const nativeTools = {
    ...tools([]),
    async runHeadlessTest() {
      calls++;
      if (rejectCached) {
        rejectCached = false;
        return { ok: false, compiledProjectAdmissionRejected: true };
      }
      return { ok: true, success: true, report: { passed: true } };
    },
  };
  const run = () =>
    runNativeProjectTestsCli(
      parseNovelTeaCliGlobals(['--json', 'test', 'run', 'semantic']),
      root,
      native,
      nativeTools,
    );
  const first = await run();
  expect(first?.exitCode).toBe(0);
  expect(first?.envelope.runtimeCache).toMatchObject({ status: 'miss', published: true });
  const second = await run();
  expect(second?.exitCode).toBe(0);
  expect(second?.envelope.runtimeCache).toMatchObject({ status: 'hit' });
  project.tests.semantic.data.steps[0]!.tick.deltaSeconds = 1;
  const third = await run();
  expect(third?.exitCode).toBe(0);
  expect(third?.envelope.runtimeCache).toMatchObject({ status: 'hit', published: true });
  rejectCached = true;
  const retried = await run();
  expect(retried?.exitCode).toBe(0);
  expect(retried?.envelope.runtimeCache).toMatchObject({ published: true });
  expect(calls).toBe(5);
});

it('does not report success after a native source generation changes while the runner executes', async () => {
  const { root, prepared } = await fixture();
  const requests: { runner: string; request: unknown }[] = [];
  let proofs = 0;
  const result = await runNativeProjectTestsCli(
    parseNovelTeaCliGlobals(['--json', 'test', 'run', 'semantic']),
    root,
    (request) => {
      if (request.action === 'shader-preparation') return { ok: true, ...prepared };
      proofs++;
      return { ok: proofs < 3, kind: 'conflict', error: 'Source changed during playback.' };
    },
    tools(requests),
  );
  expect(proofs).toBe(3);
  expect(requests).toHaveLength(1);
  expect(result?.exitCode).toBe(5);
  expect(result?.envelope.success).toBe(false);
  expect(result?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'WORKSPACE_REVISION_CONFLICT' }),
  );
});

it('rejects a pinned physical Asset mismatch and a cancelled execution without success', async () => {
  const { root, prepared } = await fixture();
  const requests: { runner: string; request: unknown }[] = [];
  const forbidden = () => {
    throw new Error('Pinned worker must never re-admit native disk.');
  };
  const mismatched = await runNativeProjectTestsCli(
    parseNovelTeaCliGlobals(['--json', 'test', 'run', 'semantic']),
    root,
    forbidden,
    tools(requests),
    {
      pinned: { projectRoot: root, preparation: prepared },
      paths: logicalRuntimeArtifactPaths,
      pinnedProjectTextSources: {},
      pinnedExternalAssets: [
        { path: 'assets/missing.png', contentHash: 'sha256:' + '0'.repeat(64) },
      ],
    },
  );
  expect(mismatched?.exitCode).toBe(5);
  expect(requests).toHaveLength(0);

  const controller = new AbortController();
  const cancelled = await runNativeProjectTestsCli(
    parseNovelTeaCliGlobals(['--json', 'test', 'run', 'semantic']),
    root,
    (request) =>
      request.action === 'shader-preparation' ? { ok: true, ...prepared } : { ok: true },
    {
      ...tools(requests),
      async runHeadlessTest(request) {
        requests.push({ runner: 'runtime', request });
        controller.abort();
        return { ok: true, success: true, report: { passed: true } };
      },
    },
    { abortSignal: controller.signal },
  );
  expect(requests).toHaveLength(1);
  expect(cancelled?.exitCode).toBe(130);
  expect(cancelled?.envelope.success).toBe(false);
});

it('rejects a corrupted canonical runtime artifact and republishes a fresh native generation', async () => {
  const { root, prepared } = await fixture();
  const native = (request: Readonly<Record<string, unknown>>) =>
    request.action === 'shader-preparation' ? { ok: true, ...prepared } : { ok: true };
  const run = () =>
    runNativeProjectTestsCli(
      parseNovelTeaCliGlobals(['--json', 'test', 'run', 'semantic']),
      root,
      native,
      tools([]),
    );
  const initial = await run();
  expect(initial?.exitCode).toBe(0);
  expect(initial?.envelope.runtimeCache).toMatchObject({ published: true });
  const cache = path.join(root, '.noveltea/cache/runtime');
  const generation = (await readFile(path.join(cache, 'current'), 'utf8')).trim();
  const artifactPath = path.join(cache, 'generations', generation, 'artifact.json');
  await writeFile(artifactPath, '{"corrupt":true}');
  const rebuilt = await run();
  expect(rebuilt?.exitCode).toBe(0);
  expect(rebuilt?.envelope.runtimeCache).toMatchObject({
    status: 'unusable',
    reason: 'artifact-digest-mismatch',
    published: true,
  });
  expect((await readdir(path.join(cache, 'generations'))).length).toBeGreaterThan(0);
  const warmed = await run();
  expect(warmed?.envelope.runtimeCache).toMatchObject({ status: 'hit' });
});
