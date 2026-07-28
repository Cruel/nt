import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { useShaderCompileStore } from '@/shaders/shader-compile-store';

describe('shader compile store', () => {
  beforeEach(() => {
    useShaderCompileStore.getState().clear();
    vi.mocked(window.noveltea.compileShaders).mockReset();
  });

  it('invalidates prior verified outputs before a new compile and keeps them cleared on failure', async () => {
    useShaderCompileStore.setState({
      authoringOutputs: [
        {
          shader: 'old-shader',
          stage: 'fragment',
          variant: 'glsl-120',
          metadata: {
            path: 'project:/shaders/bgfx/glsl-120/old-shader.fs.bin',
            byteHash: `sha256:${'a'.repeat(64)}`,
            byteSize: 4,
            compileInputFingerprint: `sha256:${'b'.repeat(64)}`,
          },
        },
      ],
    });
    let rejectCompile: (reason: Error) => void = () => undefined;
    vi.mocked(window.noveltea.compileShaders).mockReturnValue(
      new Promise((_, reject) => {
        rejectCompile = reject;
      }),
    );

    const compile = useShaderCompileStore
      .getState()
      .runCompile({}, { capturedFingerprints: {}, currentProject: () => null }, {});

    expect(useShaderCompileStore.getState().authoringOutputs).toEqual([]);
    rejectCompile(new Error('compile IPC failed'));
    await expect(compile).resolves.toMatchObject({ success: false });
    expect(useShaderCompileStore.getState().authoringOutputs).toEqual([]);
  });
});
