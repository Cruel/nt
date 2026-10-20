import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vite-plus/test';
import { parseNovelTeaCliGlobals } from '../../cli/bootstrap';
import { runNativeProjectShadersCli } from '../../cli/native-project-shaders-cli';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), 'nt-native-shaders-'));
  roots.push(value);
  // Only physical discovery belongs to this transport; YAML admission must be native.
  await writeFile(path.join(value, 'project.yaml'), 'not: [yaml');
  return value;
}

it('compiles native-admitted Project data through the established shader tool', async () => {
  const projectRoot = await root();
  const requests: Readonly<Record<string, unknown>>[] = [];
  let compilerCalls = 0;
  const result = await runNativeProjectShadersCli(
    parseNovelTeaCliGlobals([
      '--json',
      'shaders',
      'compile',
      '--variant',
      'essl-300',
      '--force-rebuild',
    ]),
    projectRoot,
    (request) => {
      requests.push(request);
      return request.action === 'shader-preparation'
        ? {
            ok: true,
            project: createAuthoringProject({ id: 'shader-test', name: 'Shader Test' }),
            sourceGeneration: 'generation',
            sourceOverlays: { 'shaders/shared.sh': '// captured' },
          }
        : { ok: true };
    },
    {
      async compileShaders(_project, options) {
        compilerCalls++;
        expect(options.shaderVariants).toEqual(['essl-300']);
        expect(options.forceRebuild).toBe(true);
        expect(options.sourceOverlays).toEqual({ 'shaders/shared.sh': '// captured' });
        return { ok: true, success: true, outputs: [], diagnostics: [] };
      },
    },
  );
  expect(result?.exitCode).toBe(0);
  expect(compilerCalls).toBe(1);
  expect(requests).toEqual([
    { action: 'shader-preparation', projectRoot },
    { action: 'source-generation-proof', projectRoot, expectedSourceGeneration: 'generation' },
  ]);
});

it('does not publish a successful command result when source authority changes during compilation', async () => {
  const projectRoot = await root();
  const result = await runNativeProjectShadersCli(
    parseNovelTeaCliGlobals(['--json', 'shaders', 'compile']),
    projectRoot,
    (request) =>
      request.action === 'shader-preparation'
        ? {
            ok: true,
            project: createAuthoringProject({ id: 'shader-test', name: 'Shader Test' }),
            sourceGeneration: 'old',
            sourceOverlays: {},
          }
        : { ok: false, kind: 'conflict', error: 'Project sources changed.' },
    {
      async compileShaders() {
        return { ok: true, success: true, outputs: [], diagnostics: [] };
      },
    },
  );
  expect(result?.exitCode).toBe(3);
  expect(result?.envelope.diagnostics[0]?.code).toBe('WORKSPACE_REVISION_CONFLICT');
  expect(result?.envelope.native).toBeUndefined();
});

it('fails closed on rejected native admission without compiling or reading Project YAML', async () => {
  const projectRoot = await root();
  const result = await runNativeProjectShadersCli(
    parseNovelTeaCliGlobals(['--json', 'shaders', 'compile']),
    projectRoot,
    () => ({ ok: false, error: 'Native Project has invalid Material records.' }),
    {
      async compileShaders() {
        throw new Error('must not compile');
      },
    },
  );
  expect(result?.exitCode).toBe(3);
  expect(result?.envelope.diagnostics[0]?.message).toBe(
    'Native Project has invalid Material records.',
  );
});

it('preserves native shader failure diagnostics and exit status', async () => {
  const projectRoot = await root();
  const result = await runNativeProjectShadersCli(
    parseNovelTeaCliGlobals(['--json', 'shaders', 'compile']),
    projectRoot,
    (request) =>
      request.action === 'shader-preparation'
        ? {
            ok: true,
            project: createAuthoringProject({ id: 'shader-test', name: 'Shader Test' }),
            sourceGeneration: 'current',
            sourceOverlays: {},
          }
        : { ok: true },
    {
      async compileShaders() {
        return {
          ok: true,
          success: false,
          outputs: [],
          diagnostics: [
            {
              code: 'shader.compile',
              severity: 'error',
              path: '/materials/custom',
              message: 'Shader compilation failed.',
            },
          ],
        };
      },
    },
  );
  expect(result?.exitCode).toBe(6);
  expect(result?.envelope.diagnostics).toEqual([
    {
      code: 'native.shader.compile',
      severity: 'error',
      path: '/materials/custom',
      message: 'Shader compilation failed.',
    },
  ]);
});

it('rejects invalid shader options before native Project admission', async () => {
  const result = await runNativeProjectShadersCli(
    parseNovelTeaCliGlobals(['--json', 'shaders', 'compile', '--variant', 'unknown']),
    '/unused',
    () => {
      throw new Error('must not admit');
    },
    {
      async compileShaders() {
        throw new Error('must not compile');
      },
    },
  );
  expect(result?.exitCode).toBe(2);
});

it('uses only the owner-pinned native preparation in a disposable shader worker', async () => {
  const projectRoot = await root();
  const project = createAuthoringProject({ id: 'pinned-shaders', name: 'Pinned Shaders' });
  const captured = { 'shaders/common.sh': '#define GENERATION 1\n' };
  let compileCalls = 0;
  const result = await runNativeProjectShadersCli(
    parseNovelTeaCliGlobals(['--json', 'shaders', 'compile', '--variant', 'metal']),
    '/not-the-owner',
    () => {
      throw new Error('A pinned disposable must never re-admit the live Project');
    },
    {
      async compileShaders(_materialProject, options) {
        compileCalls++;
        expect(options.projectRoot).toBe(projectRoot);
        expect(options.sourceOverlays).toEqual(captured);
        expect(options.shaderVariants).toEqual(['metal']);
        return { ok: true, success: true, outputs: [], diagnostics: [] };
      },
    },
    {
      projectRoot,
      preparation: {
        project,
        sourceGeneration: `sha256:${'a'.repeat(64)}`,
        sourceRevisions: {},
        sourceOverlays: captured,
        referencedAssetIds: [],
        cliDiagnostics: [
          {
            code: 'authoring.entrypoint.missing',
            path: '/entrypoint',
            message: 'No project entrypoint is configured yet.',
            severity: 'warning',
          },
        ],
      },
    },
  );
  expect(result?.exitCode).toBe(0);
  expect(compileCalls).toBe(1);
  expect(result?.envelope.diagnostics).toContainEqual({
    code: 'authoring.entrypoint.missing',
    path: '/entrypoint',
    message: 'No project entrypoint is configured yet.',
    severity: 'warning',
  });
});

it('fails closed instead of reading disk when a pinned native preparation is missing', async () => {
  const result = await runNativeProjectShadersCli(
    parseNovelTeaCliGlobals(['--json', 'shaders', 'compile']),
    '/unused',
    () => {
      throw new Error('must not invoke native disk admission');
    },
    {
      async compileShaders() {
        throw new Error('must not compile');
      },
    },
    { projectRoot: '/snapshot-owner', preparation: null },
  );
  expect(result?.exitCode).toBe(70);
  expect(result?.envelope.diagnostics[0]?.message).toContain('Refusing disk re-admission');
});
