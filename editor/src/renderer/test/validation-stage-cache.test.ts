import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import {
  compileWithVerifiedValidationCache,
  shaderOutputsStillValid,
} from '../../cli/validation-stage-cache';
import { InMemoryProjectWorkspaceFileSystem } from '../../shared/project-workspace';

describe('verified native validation stage outputs', () => {
  it('shares exact shader results with export but respects variants, source edits and forced recompilation', async () => {
    const root = '/projects/stage-cache-export';
    const shader = `${root}/shaders/test.fs.sc`;
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(
      { [shader]: '// version 1' },
      { pathMetadata: true },
    );
    const options = { projectRoot: root, shaderVariants: ['glsl-330', 'essl-300', 'metal'] };
    let compilations = 0;
    const compile = async () => {
      compilations++;
      return { ok: true, success: true, diagnostics: [], outputs: [] };
    };
    const invoke = (overrides: Partial<typeof options & { forceRebuild: boolean }> = {}) =>
      compileWithVerifiedValidationCache(
        fileSystem,
        root,
        'shared-stage-test',
        { programs: { fixture: true } },
        { ...options, ...overrides },
        compile,
      );
    expect((await invoke()).success).toBe(true);
    expect((await invoke()).success).toBe(true);
    expect(compilations).toBe(1);
    await invoke({ shaderVariants: ['metal'] });
    expect(compilations).toBe(2);
    await fileSystem.writeTextAtomic(shader, '// version 2');
    await invoke();
    expect(compilations).toBe(3);
    await invoke({ forceRebuild: true });
    expect(compilations).toBe(4);
  });
  it('invalidates shader compilation for non-.sc include edits and removals', async () => {
    const root = '/projects/stage-cache-includes';
    const shader = `${root}/shaders/main.fs.sc`;
    const include = `${root}/shaders/shared.sh`;
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(
      { [shader]: '#include "shared.sh"', [include]: 'vec4 shade() { return vec4(1.0); }' },
      { pathMetadata: true },
    );
    let compilations = 0;
    const invoke = () =>
      compileWithVerifiedValidationCache(
        fileSystem,
        root,
        'non-sc-include-test',
        { programs: { fixture: true } },
        { projectRoot: root, shaderVariants: ['glsl-330', 'essl-300', 'metal'] },
        async () => {
          compilations += 1;
          return { ok: true, success: true, diagnostics: [], outputs: [] };
        },
      );
    await invoke();
    await invoke();
    expect(compilations).toBe(1);
    await fileSystem.writeTextAtomic(include, 'vec4 shade() { return vec4(0.0); }');
    await invoke();
    expect(compilations).toBe(2);
    await fileSystem.removeFile(include);
    await invoke();
    expect(compilations).toBe(3);
  });
  it('rejects compiled outputs whose bytes changed or disappeared', async () => {
    const root = '/projects/stage-cache-test';
    const path = `${root}/.noveltea/build/shaders/sample.bin`;
    const bytes = 'verified compiled shader';
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(
      { [path]: bytes },
      {
        pathMetadata: true,
      },
    );
    const response = {
      ok: true,
      success: true,
      diagnostics: [],
      outputs: [
        {
          program: 'sample',
          programIdentity: 'sample',
          stage: 'fragment' as const,
          variant: 'glsl-330',
          sourceIdentity: 'source',
          dependencies: [],
          dependencyRevisions: [],
          outputPath: path,
          runtimePath: 'project:/shaders/sample.bin',
          cacheKey: 'sample',
          byteHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const,
          byteSize: Buffer.byteLength(bytes),
          reflectedInputs: [],
          cacheHit: false,
        },
      ],
    };
    expect(await shaderOutputsStillValid(fileSystem, root, response)).toBe(true);
    await fileSystem.writeTextAtomic(path, 'replaced');
    expect(await shaderOutputsStillValid(fileSystem, root, response)).toBe(false);
    await fileSystem.removeFile(path);
    expect(await shaderOutputsStillValid(fileSystem, root, response)).toBe(false);
  });
});
