import { create } from 'zustand';
import type {
  ShaderCompileDiagnostic,
  ShaderCompileOptions,
  ShaderCompileOutput,
  ShaderCompileResponse,
} from '../../shared/editor-tooling';

interface ShaderCompileStoreState {
  compiling: boolean;
  lastOptions: ShaderCompileOptions | null;
  diagnostics: ShaderCompileDiagnostic[];
  outputs: ShaderCompileOutput[];
  error: string | null;
  runCompile: (
    shaderProject: unknown,
    options?: ShaderCompileOptions,
    inputFingerprints?: Readonly<Record<string, `sha256:${string}`>>,
  ) => Promise<ShaderCompileResponse>;
  setResult: (response: ShaderCompileResponse, options?: ShaderCompileOptions) => void;
  clear: () => void;
}

function normalizeResponse(value: unknown): ShaderCompileResponse {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const diagnostics = Array.isArray(record.diagnostics)
    ? (record.diagnostics as ShaderCompileDiagnostic[])
    : [];
  const outputs = Array.isArray(record.outputs) ? (record.outputs as ShaderCompileOutput[]) : [];
  return {
    ok: record.ok === true,
    success: record.success === true,
    diagnostics,
    outputs,
    error: typeof record.error === 'string' ? record.error : undefined,
  };
}

export const useShaderCompileStore = create<ShaderCompileStoreState>()((set, get) => ({
  compiling: false,
  lastOptions: null,
  diagnostics: [],
  outputs: [],
  error: null,
  runCompile: async (shaderProject, options = {}, inputFingerprints = {}) => {
    set({ compiling: true, lastOptions: options, error: null });
    try {
      const response = normalizeResponse(
        await window.noveltea.compileShaders(shaderProject, options),
      );
      response.outputs = response.outputs.map((output) => ({
        ...output,
        compileInputFingerprint:
          inputFingerprints[`${output.shader}:${output.stage}:${output.variant}`] ??
          output.compileInputFingerprint,
      }));
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
      error: response.error ?? null,
    }),
  clear: () =>
    set({ compiling: false, lastOptions: null, diagnostics: [], outputs: [], error: null }),
}));
