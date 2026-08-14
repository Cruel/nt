import { create } from 'zustand';
import type {
  ShaderCompileDiagnostic,
  ShaderCompileOptions,
  ShaderCompileOutput,
  ShaderCompileResponse,
} from '../../shared/editor-tooling';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseShaderCompileResponse } from '../../shared/shader-compile-contract';
import {
  canonicalRuntimeShaderOutputPath,
  parseShaderData,
  shaderCompileInputFingerprint,
  type ShaderCompiledOutput,
} from '../../shared/project-schema/authoring-shaders';
import type { ShaderCompiledOutputsPayload } from '../project/shader-material-operations';

interface ShaderCompileRequestEvidence {
  capturedFingerprints: Readonly<Record<string, `sha256:${string}`>>;
  currentProject: () => AuthoringProject | null;
}

interface ShaderCompileStoreState {
  compiling: boolean;
  lastOptions: ShaderCompileOptions | null;
  diagnostics: ShaderCompileDiagnostic[];
  outputs: ShaderCompileOutput[];
  authoringOutputs: ShaderCompiledOutputsPayload['outputs'];
  error: string | null;
  runCompile: (
    shaderProject: unknown,
    evidence: ShaderCompileRequestEvidence,
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
  runCompile: async (shaderProject, evidence, options = {}) => {
    set({
      compiling: true,
      lastOptions: options,
      diagnostics: [],
      outputs: [],
      authoringOutputs: [],
      error: null,
    });
    try {
      const response = parseShaderCompileResponse(
        await window.noveltea.compileShaders(shaderProject, options),
      );
      const currentProject = evidence.currentProject();
      const verifiedOutputs: ShaderCompileOutput[] = [];
      const authoringOutputs: ShaderCompiledOutputsPayload['outputs'] = [];
      for (const output of response.outputs) {
        const key = `${output.shader}:${output.stage}:${output.variant}`;
        const capturedFingerprint = evidence.capturedFingerprints[key];
        const shader = currentProject
          ? parseShaderData(currentProject.shaders[output.shader]?.data)
          : null;
        const stageIndex = shader?.stages.findIndex((stage) => stage.stage === output.stage) ?? -1;
        const currentFingerprint =
          currentProject && stageIndex >= 0
            ? await shaderCompileInputFingerprint(
                currentProject,
                output.shader,
                stageIndex,
                output.variant,
              )
            : null;
        const runtimePath = canonicalRuntimeShaderOutputPath(output.runtimePath);
        const metadata: ShaderCompiledOutput | null =
          capturedFingerprint &&
          currentFingerprint === capturedFingerprint &&
          runtimePath &&
          /^sha256:[0-9a-f]{64}$/.test(output.byteHash) &&
          Number.isSafeInteger(output.byteSize) &&
          output.byteSize >= 0
            ? {
                path: runtimePath,
                byteHash: output.byteHash,
                byteSize: output.byteSize,
                compileInputFingerprint: capturedFingerprint,
              }
            : null;
        if (!metadata) {
          response.diagnostics.push({
            severity: 'error',
            code: capturedFingerprint
              ? 'shader.compile.output-stale-or-invalid'
              : 'shader.compile.request-fingerprint-missing',
            shader: output.shader,
            stage: output.stage,
            variant: output.variant,
            message: capturedFingerprint
              ? `Compiled output for '${key}' was rejected because its request fingerprint became stale or its integrity metadata was invalid.`
              : `Compiled output for '${key}' was rejected because the compile request did not capture an authoring fingerprint.`,
          });
          continue;
        }
        verifiedOutputs.push(output);
        authoringOutputs.push({
          shader: output.shader,
          stage: output.stage,
          variant: output.variant,
          metadata,
        });
      }
      response.outputs = verifiedOutputs;
      if (response.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
        response.success = false;
      }
      set({ authoringOutputs });
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
    set({
      compiling: false,
      lastOptions: null,
      diagnostics: [],
      outputs: [],
      authoringOutputs: [],
      error: null,
    }),
}));
