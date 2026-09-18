import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { useProjectStore } from '@/project/project-store';
import { useShaderCompileStore } from '@/shaders/shader-compile-store';

describe('shader compile store', () => {
  beforeEach(() => {
    useShaderCompileStore.getState().clear();
    useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
    vi.mocked(window.noveltea.compileShaders).mockReset();
  });

  it('clears prior derived outputs before a new compile and keeps authoring state untouched on failure', async () => {
    useShaderCompileStore.setState({
      outputs: [
        {
          program: 'old-program',
          programIdentity: 'old-identity',
          stage: 'fragment',
          variant: 'glsl-330',
          sourceIdentity: 'project:/shaders/old.fs.sc',
          dependencies: [],
          outputPath: '/tmp/old.fs.bin',
          runtimePath: 'project:/shaders/derived/glsl-330/old.fs.bin',
          cacheKey: 'old-cache',
          byteHash: `sha256:${'a'.repeat(64)}`,
          byteSize: 4,
          reflectedInputs: [],
          cacheHit: false,
        },
      ],
    });
    let rejectCompile: (reason: Error) => void = () => undefined;
    vi.mocked(window.noveltea.compileShaders).mockReturnValue(
      new Promise((_, reject) => {
        rejectCompile = reject;
      }),
    );

    const compile = useShaderCompileStore.getState().runCompile({
      schema: 'noveltea.shader-source-programs',
      programs: {},
    });

    expect(useShaderCompileStore.getState().outputs).toEqual([]);
    expect(useShaderCompileStore.getState().authoringOutputs).toEqual([]);
    rejectCompile(new Error('compile IPC failed'));
    await expect(compile).resolves.toMatchObject({ success: false });
    expect(useShaderCompileStore.getState().outputs).toEqual([]);
    expect(useShaderCompileStore.getState().authoringOutputs).toEqual([]);
  });
});
