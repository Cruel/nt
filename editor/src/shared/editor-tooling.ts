export type ToolSeverity = 'info' | 'warning' | 'error';

export interface ToolDiagnostic {
  severity: ToolSeverity;
  path: string;
  message: string;
  category?: string;
}

export interface OpenProjectResponse {
  ok: boolean;
  success: boolean;
  contentProject?: unknown;
  savedContentProject?: unknown;
  editorState?: import('./project-schema/editor-project-state').EditorProjectState;
  repairs?: import('./project-schema/decode-authoring-project').AuthoringEnumRepair[];
  contentFingerprint?: string;
  diagnostics: ToolDiagnostic[];
  error?: string;
  projectPath: string;
  projectFilePath: string;
}

export interface SaveProjectEditorMetadataResponse {
  ok: boolean;
  success: boolean;
  diagnostics: ToolDiagnostic[];
  contentFingerprint?: string;
  error?: string;
}

export interface ValidationResponse {
  ok: boolean;
  success: boolean;
  diagnostics: ToolDiagnostic[];
  error?: string;
}

export interface PlaybackTestSummary {
  id: string;
  steps: number;
}

export interface TestListResponse {
  ok: boolean;
  tests: PlaybackTestSummary[];
  diagnostics: ToolDiagnostic[];
  error?: string;
}

export interface PlaybackReportResponse {
  ok: boolean;
  report?: unknown;
  diagnostics: ToolDiagnostic[];
  error?: string;
}

export interface PackageExportOptions {
  kind?: 'runtime' | 'editable';
  projectName?: string;
  projectVersion?: string;
  createdBy?: string;
  includeChecksums?: boolean;
  stripShaderSources?: boolean;
  shaderAssetRoot?: string;
  shaderVariants?: string[];
  shaderMaterialMetadata?: unknown;
  requiredShaderBinaryPaths?: string[];
  assetRoots?: Array<{ root: string; packagePrefix?: string }>;
  fileEntries?: Array<{ source: string; packagePath: string }>;
  display?: {
    aspect_ratio: { width: number; height: number };
    orientation: 'landscape' | 'portrait';
    bar_color: string;
  };
  platform?: {
    orientation: 'landscape' | 'portrait';
    desktop: { initialWidth: number; initialHeight: number; arguments: string[] };
    web: { orientation: 'landscape' | 'portrait'; query: string };
    android: {
      orientation: 'landscape' | 'portrait';
      gradleProperty: string;
      screenOrientation: 'sensorLandscape' | 'sensorPortrait';
    };
  };
}

export interface PackageExportResponse {
  ok: boolean;
  success: boolean;
  diagnostics: ToolDiagnostic[];
  manifest?: unknown;
  byteCount?: number;
  checksums?: Record<string, string>;
  error?: string;
}

export interface PackagePreviewResponse {
  ok: boolean;
  success: boolean;
  diagnostics: ToolDiagnostic[];
  packagePath?: string;
  error?: string;
}

export interface ShaderCompileOptions {
  shaderc?: string;
  bgfxShaderIncludeDir?: string;
  projectRoot?: string;
  outputRoot?: string;
  cacheRoot?: string;
  forceRebuild?: boolean;
  shaderVariants?: string[];
}

export interface ShaderCompileDiagnostic {
  severity: ToolSeverity;
  code?: string;
  shader?: string;
  stage?: string;
  variant?: string;
  sourcePath?: string;
  outputPath?: string;
  commandLine?: string;
  exitCode?: number;
  message: string;
  path?: string;
}

export interface ShaderCompileOutput {
  shader: string;
  stage: 'vertex' | 'fragment' | string;
  variant: string;
  sourcePath: string;
  outputPath: string;
  runtimePath: string;
  cacheKey: string;
  cacheHit: boolean;
}

export interface ShaderCompileResponse {
  ok: boolean;
  success: boolean;
  diagnostics: ShaderCompileDiagnostic[];
  outputs: ShaderCompileOutput[];
  error?: string;
}

export interface SaveProjectResponse {
  ok: boolean;
  success: boolean;
  projectPath?: string;
  projectFilePath?: string;
  contentFingerprint?: string;
  diagnostics?: ToolDiagnostic[];
  error?: string;
}

export interface CreateProjectRequest {
  projectName: string;
  projectDirectory: string;
}
