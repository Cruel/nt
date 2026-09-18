import { create } from 'zustand';
import type {
  ShaderCompileDiagnostic,
  ShaderCompileOptions,
  ShaderCompileOutput,
  ShaderCompileResponse,
} from '../../shared/editor-tooling';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { useProjectStore } from '../project/project-store';
import { parseShaderCompileResponse } from '../../shared/shader-compile-contract';

interface ShaderCompileRequestEvidence {
  capturedFingerprints?: Readonly<Record<string, `sha256:${string}`>>;
  currentProject?: () => AuthoringProject | null;
}

interface ShaderCompileStoreState {
  compiling: boolean;
  lastOptions: ShaderCompileOptions | null;
  diagnostics: ShaderCompileDiagnostic[];
  outputs: ShaderCompileOutput[];
  /** Compiled shader binaries are derived artifacts and are never written into authoring records. */
  authoringOutputs: readonly [];
  error: string | null;
  runCompile: (
    shaderProject: unknown,
    evidence?: ShaderCompileRequestEvidence,
    options?: ShaderCompileOptions,
  ) => Promise<ShaderCompileResponse>;
  setResult: (response: ShaderCompileResponse, options?: ShaderCompileOptions) => void;
  clear: () => void;
}

export const useShaderCompileStore = create<ShaderCompileStoreState>()((set, get) => ({
  compiling: false,
  lastOptions: null,
  diagnostics: [],
  outputs: [],
  authoringOutputs: [],
  error: null,
  runCompile: async (shaderProject, _evidence, options = {}) => {
    set({
      compiling: true,
      lastOptions: options,
      diagnostics: [],
      outputs: [],
      authoringOutputs: [],
      error: null,
    });
    try {
      const projectSessionId = useProjectStore.getState().projectSessionId;
      if (!projectSessionId)
        throw new Error('Shader compilation requires an active Project session.');
      const response = parseShaderCompileResponse(
        await window.noveltea.compileShaders(projectSessionId, shaderProject, {
          forceRebuild: options.forceRebuild,
          shaderVariants: options.shaderVariants,
        }),
      );
      get().setResult(response, options);
      return response;
    } catch (error) {
      const response: ShaderCompileResponse = {
        ok: false,
        success: false,
        outputs: [],
        diagnostics: [
          { severity: 'error', message: error instanceof Error ? error.message : String(error) },
        ],
        error: error instanceof Error ? error.message : String(error),
      };
      get().setResult(response, options);
      return response;
    }
  },
  setResult: (response, options) =>
    set({
      compiling: false,
      lastOptions: options ?? get().lastOptions,
      diagnostics: response.diagnostics,
      outputs: response.outputs,
      authoringOutputs: [],
      error: response.error ?? null,
    }),
  clear: () =>
    set({
      compiling: false,
      lastOptions: null,
      diagnostics: [],
      outputs: [],
      authoringOutputs: [],
      error: null,
    }),
}));
