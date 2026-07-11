import { create } from 'zustand';
import type { PackageExportResponse, ShaderCompileDiagnostic, ShaderCompileOutput, ToolDiagnostic } from '../../shared/editor-tooling';
import type { ExportProfileData } from '../../shared/project-schema/authoring-export';
import type { ExportFileEntry, ExportManifestPreview } from '../../shared/project-schema/authoring-runtime-export';
import type { PlatformStageResult } from '../../shared/project-schema/platform-export-contracts';

export type ExportWorkflowStage =
  | 'idle'
  | 'validating'
  | 'building-runtime-project'
  | 'compiling-shaders'
  | 'writing-package'
  | 'previewing-package'
  | 'complete'
  | 'failed';

export interface PackageExportWorkflowResult {
  ok: boolean;
  success: boolean;
  stage: ExportWorkflowStage;
  profile: ExportProfileData | null;
  outputPath: string | null;
  diagnostics: ToolDiagnostic[];
  validationDiagnostics: ToolDiagnostic[];
  shaderDiagnostics: ShaderCompileDiagnostic[];
  shaderOutputs: ShaderCompileOutput[];
  fileEntries: ExportFileEntry[];
  manifestPreview: ExportManifestPreview | null;
  packageResponse?: PackageExportResponse;
  manifest?: unknown;
  byteCount?: number;
  checksums?: Record<string, string>;
  platformStageResult?: PlatformStageResult;
}

interface PackageExportStoreState {
  stage: ExportWorkflowStage;
  running: boolean;
  lastResult: PackageExportWorkflowResult | null;
  setStage: (stage: ExportWorkflowStage) => void;
  start: () => void;
  finish: (result: PackageExportWorkflowResult) => void;
  clear: () => void;
}

export function emptyPackageExportResult(stage: ExportWorkflowStage = 'idle'): PackageExportWorkflowResult {
  return {
    ok: stage !== 'failed',
    success: false,
    stage,
    profile: null,
    outputPath: null,
    diagnostics: [],
    validationDiagnostics: [],
    shaderDiagnostics: [],
    shaderOutputs: [],
    fileEntries: [],
    manifestPreview: null,
  };
}

export const usePackageExportStore = create<PackageExportStoreState>()((set) => ({
  stage: 'idle',
  running: false,
  lastResult: null,
  setStage: (stage) => set({ stage }),
  start: () => set({ stage: 'validating', running: true, lastResult: null }),
  finish: (lastResult) => set({ stage: lastResult.stage, running: false, lastResult }),
  clear: () => set({ stage: 'idle', running: false, lastResult: null }),
}));
