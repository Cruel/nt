export type ToolSeverity = 'info' | 'warning' | 'error';

export type ToolDiagnosticNavigation = {
  kind: 'interactable-instance-property';
  instanceId: string;
  propertyId: string;
};

export interface ToolDiagnostic {
  code?: string;
  severity: ToolSeverity;
  path: string;
  message: string;
  category?: string;
  ownerPaths?: readonly string[];
  navigation?: ToolDiagnosticNavigation;
}

export interface OpenProjectResponse {
  ok: boolean;
  success: boolean;
  contentProject?: unknown;
  savedContentProject?: unknown;
  editorState?: import('./project-schema/editor-project-state').EditorProjectState;
  repairs?: import('./project-schema/decode-authoring-project').AuthoringEnumRepair[];
  recoveryFileRevisions?: Record<string, `sha256:${string}` | 'absent'>;
  scriptSourcePaths?: Record<string, string>;
  diagnostics: ToolDiagnostic[];
  error?: string;
  projectPath: string;
  projectFilePath: string;
  projectSessionId?: string;
}

export interface SaveProjectEditorMetadataResponse {
  ok: boolean;
  success: boolean;
  diagnostics: ToolDiagnostic[];
  editorState?: import('./project-schema/editor-project-state').EditorProjectState;
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
  fileEntries?: Array<{
    source: string;
    packagePath: string;
    storage?: 'auto' | 'stored' | 'compressed';
  }>;
  requiredSeekablePaths?: string[];
  display?: {
    reference_resolution: { width: number; height: number };
    world_raster_policy: 'capped' | 'native';
    bar_color: string;
  };
  accessibility?: {
    ui_scale: { enabled: boolean; minimum: number; maximum: number };
    text_scale: { enabled: boolean; minimum: number; maximum: number };
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
  stage: 'vertex' | 'fragment';
  variant: string;
  sourcePath: string;
  outputPath: string;
  runtimePath: string;
  cacheKey: string;
  byteHash: `sha256:${string}`;
  byteSize: number;
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
  projectSessionId?: string;
  workspaceRevision?: string;
  fileRevisions?: Record<string, `sha256:${string}`>;
  contentProject?: unknown;
  editorState?: import('./project-schema/editor-project-state').EditorProjectState;
  scriptSourcePaths?: Record<string, string>;
  assetTrashMoves?: import('./project-asset-audit').ProjectAssetTrashMove[];
  diagnostics?: ToolDiagnostic[];
  error?: string;
}

export type ProjectMutationPathValue = { exists: false } | { exists: true; value: unknown };

export interface ProjectContentSaveRequest {
  saveUnitIds: string[];
  affectedPaths: string[];
  baseValueByPath: Record<string, ProjectMutationPathValue>;
  localValueByPath: Record<string, ProjectMutationPathValue>;
  operationLabel: string;
  recoveryFileOwnershipHints?: Record<string, string[]>;
  identityRemap?: Array<{ fromPath: string; toPath: string }>;
  structural?: boolean;
  assetTransition?:
    | { kind: 'trash'; projectRelativePaths: string[] }
    | { kind: 'restore'; moves: import('./project-asset-audit').ProjectAssetTrashMove[] };
}

export interface ProjectContentSaveResponse {
  ok: boolean;
  success: boolean;
  projectPath?: string;
  projectFilePath?: string;
  editorState?: import('./project-schema/editor-project-state').EditorProjectState;
  committedSaveUnitIds?: string[];
  fileRevisions?: Record<string, `sha256:${string}` | 'absent'>;
  externalValueByPath?: Record<string, ProjectMutationPathValue>;
  scriptSourcePaths?: Record<string, string>;
  assetTrashMoves?: import('./project-asset-audit').ProjectAssetTrashMove[];
  diagnostics?: ToolDiagnostic[];
  error?: string;
}

export interface ProjectWorkspaceCommitOptions {
  expectedFileRevisions: Record<string, `sha256:${string}`>;
  saveUnitIds?: string[];
  baselineProject?: unknown;
  affectedPaths?: string[];
  operationLabel: string;
  structural?: boolean;
  assetTransition?:
    | { kind: 'trash'; projectRelativePaths: string[] }
    | { kind: 'restore'; moves: import('./project-asset-audit').ProjectAssetTrashMove[] };
}

export interface CreateProjectRequest {
  projectName: string;
  projectDirectory: string;
}
