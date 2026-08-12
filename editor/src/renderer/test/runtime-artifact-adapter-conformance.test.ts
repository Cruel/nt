import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { nodeShaderCompilerAdapter } from '../../main/services/node-runtime-artifact-adapters';
import type { ShaderCompileResponse } from '../../shared/editor-tooling';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';
import {
  prepareRuntimeArtifact,
  type RuntimeArtifactShaderCompilerAdapter,
} from '../../shared/runtime-artifact-preparation';
import {
  rendererRuntimeArtifactPaths,
  rendererShaderCompilerAdapter,
} from '../export/runtime-artifact-adapters';

function shaderProject() {
  const project = createAuthoringProject({ name: 'Shader Adapter' });
  const room = defaultRoomData('Room');
  room.description.source = { kind: 'inline', text: 'Ready.' };
  project.rooms.room = { id: 'room', label: 'Room', data: room };
  project.entrypoint = { kind: 'room', id: 'room' };
  project.shaders.basic = { id: 'basic', label: 'Basic', data: defaultShaderData('Basic') };
  return project;
}

function successfulResponse(): ShaderCompileResponse {
  return {
    ok: true,
    success: true,
    diagnostics: [],
    outputs: (['vertex', 'fragment'] as const).map((stage) => ({
      shader: 'basic',
      stage,
      variant: 'glsl-120',
      sourcePath: `/project/basic.${stage}.sc`,
      outputPath: `/project/basic.${stage}.bin`,
      runtimePath: `project:/shaders/bgfx/glsl-120/basic.${stage}.bin`,
      cacheKey: `${stage}-cache`,
      byteHash: `sha256:${stage === 'vertex' ? 'a'.repeat(64) : 'b'.repeat(64)}`,
      byteSize: 4,
      cacheHit: false,
    })),
  };
}

type AdapterFactory = (
  response: unknown,
  onCompile?: () => void,
) => RuntimeArtifactShaderCompilerAdapter;

const factories: Array<[string, AdapterFactory]> = [
  [
    'renderer',
    (response, onCompile) => {
      vi.mocked(window.noveltea.compileShaders).mockImplementation(async () => {
        onCompile?.();
        return response as ShaderCompileResponse;
      });
      return rendererShaderCompilerAdapter;
    },
  ],
  [
    'native/CLI',
    (response, onCompile) =>
      nodeShaderCompilerAdapter(async () => {
        onCompile?.();
        return response as ShaderCompileResponse;
      }),
  ],
];

describe.each(factories)('%s shader compiler adapter', (_name, adapterFactory) => {
  beforeEach(() =>
    vi
      .mocked(window.noveltea.compileShaders)
      .mockReset()
      .mockResolvedValue({ ok: true, success: true, diagnostics: [], outputs: [] }),
  );

  it('prepares through the shared interface on success', async () => {
    const project = shaderProject();
    const result = await prepareRuntimeArtifact({
      project,
      projectRoot: '/project',
      profile: { ...defaultExportProfile(project), shaderVariants: ['glsl-120'] },
      intent: 'runtime-package-export',
      shaderCompiler: adapterFactory(successfulResponse()),
      paths: rendererRuntimeArtifactPaths,
    });
    expect(result.status).toBe('prepared');
  });

  it('accepts main-process classified diagnostic metadata', async () => {
    const project = shaderProject();
    const response = successfulResponse();
    const result = await prepareRuntimeArtifact({
      project,
      projectRoot: '/project',
      profile: { ...defaultExportProfile(project), shaderVariants: ['glsl-120'] },
      intent: 'runtime-package-export',
      shaderCompiler: adapterFactory({
        ...response,
        diagnostics: [
          {
            severity: 'warning',
            code: 'shader.compile.warning',
            message: 'Compiler warning.',
            path: '/shaders/basic',
            category: 'shader',
            boundaries: ['runtime-package', 'platform-export'],
            ownerPaths: ['/shaders/basic'],
          },
        ],
      }),
      paths: rendererRuntimeArtifactPaths,
    });
    expect(result.status).toBe('prepared');
  });

  it('normalizes execution diagnostics into a blocked outcome', async () => {
    const project = shaderProject();
    const result = await prepareRuntimeArtifact({
      project,
      projectRoot: '/project',
      profile: { ...defaultExportProfile(project), shaderVariants: ['glsl-120'] },
      intent: 'runtime-package-export',
      shaderCompiler: adapterFactory({
        ok: false,
        success: false,
        outputs: [],
        diagnostics: [{ severity: 'error', code: 'compile-failed', message: 'failed' }],
      }),
      paths: rendererRuntimeArtifactPaths,
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked')
      expect(result.diagnostics.some((item) => item.code === 'compile-failed')).toBe(true);
  });

  it('blocks an unsuccessful compiler response without diagnostics', async () => {
    const project = shaderProject();
    const result = await prepareRuntimeArtifact({
      project,
      projectRoot: '/project',
      profile: { ...defaultExportProfile(project), shaderVariants: ['glsl-120'] },
      intent: 'runtime-package-export',
      shaderCompiler: adapterFactory({
        ok: false,
        success: false,
        outputs: [],
        diagnostics: [],
        error: 'compiler exited unsuccessfully',
      }),
      paths: rendererRuntimeArtifactPaths,
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked')
      expect(
        result.diagnostics.some((item) => item.code === 'runtime-artifact.shader-compiler.failed'),
      ).toBe(true);
  });

  it('rejects malformed output evidence at the adapter boundary', async () => {
    const project = shaderProject();
    const response = successfulResponse();
    response.outputs[0]!.byteHash = 'sha256:bad';
    const result = await prepareRuntimeArtifact({
      project,
      projectRoot: '/project',
      profile: { ...defaultExportProfile(project), shaderVariants: ['glsl-120'] },
      intent: 'runtime-package-export',
      shaderCompiler: adapterFactory(response),
      paths: rendererRuntimeArtifactPaths,
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked')
      expect(
        result.diagnostics.some((item) => item.code === 'shader.compile.response-invalid'),
      ).toBe(true);
  });

  it('rejects malformed native response records without throwing', async () => {
    const project = shaderProject();
    const result = await prepareRuntimeArtifact({
      project,
      projectRoot: '/project',
      profile: { ...defaultExportProfile(project), shaderVariants: ['glsl-120'] },
      intent: 'runtime-package-export',
      shaderCompiler: adapterFactory({
        ok: true,
        success: true,
        diagnostics: [],
        outputs: [null],
      }),
      paths: rendererRuntimeArtifactPaths,
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked')
      expect(
        result.diagnostics.some((item) => item.code === 'shader.compile.response-invalid'),
      ).toBe(true);
  });

  it('rejects successful compiler responses with no required outputs', async () => {
    const project = shaderProject();
    const result = await prepareRuntimeArtifact({
      project,
      projectRoot: '/project',
      profile: { ...defaultExportProfile(project), shaderVariants: ['glsl-120'] },
      intent: 'runtime-package-export',
      shaderCompiler: adapterFactory({ ok: true, success: true, diagnostics: [], outputs: [] }),
      paths: rendererRuntimeArtifactPaths,
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked')
      expect(
        result.diagnostics.filter((item) => item.code === 'runtime-artifact.shader-output-missing'),
      ).toHaveLength(2);
  });

  it('rejects successful compiler responses with only part of the required output set', async () => {
    const project = shaderProject();
    const response = successfulResponse();
    response.outputs = response.outputs.slice(0, 1);
    const result = await prepareRuntimeArtifact({
      project,
      projectRoot: '/project',
      profile: { ...defaultExportProfile(project), shaderVariants: ['glsl-120'] },
      intent: 'runtime-package-export',
      shaderCompiler: adapterFactory(response),
      paths: rendererRuntimeArtifactPaths,
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked')
      expect(
        result.diagnostics.filter((item) => item.code === 'runtime-artifact.shader-output-missing'),
      ).toHaveLength(1);
  });

  it('rejects successful compiler responses with duplicate output keys', async () => {
    const project = shaderProject();
    const response = successfulResponse();
    response.outputs.push({ ...response.outputs[0]! });
    const result = await prepareRuntimeArtifact({
      project,
      projectRoot: '/project',
      profile: { ...defaultExportProfile(project), shaderVariants: ['glsl-120'] },
      intent: 'runtime-package-export',
      shaderCompiler: adapterFactory(response),
      paths: rendererRuntimeArtifactPaths,
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked')
      expect(
        result.diagnostics.some((item) => item.code === 'runtime-artifact.shader-output-duplicate'),
      ).toBe(true);
  });

  it('returns cancellation after an in-flight adapter finishes', async () => {
    const project = shaderProject();
    let cancelled = false;
    const result = await prepareRuntimeArtifact({
      project,
      projectRoot: '/project',
      profile: { ...defaultExportProfile(project), shaderVariants: ['glsl-120'] },
      intent: 'runtime-package-export',
      shaderCompiler: adapterFactory(successfulResponse(), () => {
        cancelled = true;
      }),
      paths: rendererRuntimeArtifactPaths,
      isCancelled: () => cancelled,
    });
    expect(result.status).toBe('cancelled');
  });
});
