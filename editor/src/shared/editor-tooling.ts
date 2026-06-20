export type ToolSeverity = 'info' | 'warning' | 'error';

export interface ToolDiagnostic {
  severity: ToolSeverity;
  path: string;
  message: string;
  category?: string;
}

export interface ProjectLoadResponse {
  ok: boolean;
  success: boolean;
  importedLegacy: boolean;
  project?: unknown;
  diagnostics: ToolDiagnostic[];
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
  shaderAssetRoot?: string;
  shaderVariants?: string[];
  assetRoots?: Array<{ root: string; packagePrefix?: string }>;
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

export interface EntityEditResponse {
  ok: boolean;
  success: boolean;
  project?: unknown;
  diagnostics: ToolDiagnostic[];
  error?: string;
}

export interface OpenProjectResponse extends ProjectLoadResponse {
  projectPath: string;
  projectFilePath: string;
}

export type EntityCollection =
  | 'object'
  | 'verb'
  | 'action'
  | 'room'
  | 'map'
  | 'dialogue'
  | 'cutscene'
  | 'script'
  | 'asset'
  | 'tests';
