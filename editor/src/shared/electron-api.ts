export interface AppInfo {
  version: string;
  electronVersion: string;
  platform: string;
  arch: string;
  packaged: boolean;
  frameless: boolean;
  nativeFrame: boolean;
  preferredSystemLanguages: string[];
  systemLocale: string;
}

interface NovelTeaElectronApiContract {
  getAppInfo(): Promise<AppInfo>;
  getDefaultProjectDirectory(): Promise<string>;
  selectDirectory(options?: {
    title?: string;
    defaultPath?: string | null;
  }): Promise<string | null>;
  selectProjectDirectory(): Promise<string | null>;
  selectPackageOutputPath(defaultPath?: string | null): Promise<string | null>;
  selectTemplateArchivePath(): Promise<string | null>;
  showItemInFolder(path: string): Promise<void>;
  previewExportedPackage(
    projectSessionId: string,
    packagePath: string,
  ): Promise<PackagePreviewResponse>;
  openExternal(url: string): Promise<void>;
  zoomIn(): Promise<number>;
  zoomOut(): Promise<number>;
  resetZoom(): Promise<number>;
  minimizeAppWindow(): Promise<void>;
  toggleMaximizeAppWindow(): Promise<boolean>;
  requestAppWindowExit(): Promise<void>;
  completeAppWindowExit(): Promise<void>;
  onAppWindowBeforeClose(callback: () => void): () => void;
  onEditorShortcut(callback: (command: EditorShortcutCommand) => void): () => void;
  isAppWindowMaximized(): Promise<boolean>;
  setNativeWindowFrame(nativeFrame: boolean): Promise<AppInfo>;
  getEnginePreviewSession(projectSessionId: string): Promise<EnginePreviewSession>;
  reloadEnginePreview(projectSessionId: string): Promise<EnginePreviewSession>;
  createProject(request: CreateProjectRequest): Promise<SaveProjectResponse>;
  openProject(projectPath: string): Promise<OpenProjectResponse>;
  closeActiveProject(): Promise<void>;
  validateProject(project: unknown): Promise<ValidationResponse>;
  listPlaybackTests(project: unknown): Promise<TestListResponse>;
  runPlaybackTest(project: unknown, testId: string): Promise<PlaybackReportResponse>;
  runPlaybackSpec(project: unknown, spec: unknown): Promise<PlaybackReportResponse>;
  runUiPlaybackSpec(project: unknown, spec: unknown): Promise<PlaybackReportResponse>;
  exportPackage(
    project: unknown,
    outputPath: string,
    options?: PackageExportOptions,
  ): Promise<PackageExportResponse>;
  stagePlatformExport(
    request: import('./project-schema/platform-export-contracts').PlatformStageRequest,
  ): Promise<import('./project-schema/platform-export-contracts').PlatformStageResult>;
  exportProjectToPlatform(
    request: import('./project-schema/platform-export-contracts').ProjectPlatformExportRequest,
  ): Promise<import('./project-schema/platform-export-contracts').PlatformStageResult>;
  onPlatformExportProgress(
    callback: (
      event: import('./project-schema/platform-export-contracts').PlatformExportProgressEvent,
    ) => void,
  ): () => void;
  cancelPlatformExport(operationId: string): Promise<{ cancelled: boolean }>;
  listPlayerTemplates(
    query?: import('./project-schema/platform-export-contracts').TemplateRegistryQuery,
  ): Promise<import('./project-schema/platform-export-contracts').InstalledTemplate[]>;
  inspectPlayerTemplate(
    templateId: string,
    buildId: string,
  ): Promise<import('./project-schema/platform-export-contracts').InstalledTemplate | null>;
  installPlayerTemplate(
    request: import('./project-schema/platform-export-contracts').TemplateInstallRequest,
  ): Promise<import('./project-schema/platform-export-contracts').TemplateInstallResult>;
  downloadPlayerTemplate(
    request: import('./project-schema/platform-export-contracts').TemplateDownloadRequest,
  ): Promise<import('./project-schema/platform-export-contracts').TemplateDownloadResult>;
  removePlayerTemplate(templateId: string, buildId: string): Promise<{ removed: boolean }>;
  resolvePlayerTemplate(
    request: import('./project-schema/platform-export-contracts').TemplateResolveRequest,
  ): Promise<import('./project-schema/platform-export-contracts').TemplateResolveResult>;
  compileShaders(
    projectSessionId: string,
    shaderProject: unknown,
    options?: Pick<ShaderCompileOptions, 'forceRebuild' | 'shaderVariants'>,
  ): Promise<ShaderCompileResponse>;
  saveProjectContent(
    projectSessionId: string,
    expectedWorkspaceRevision: string,
    contentProject: unknown,
    editorState: import('./project-schema/editor-project-state').EditorProjectState,
    scriptSourcePaths?: Record<string, string>,
    commitOptions?: import('./editor-tooling').ProjectWorkspaceCommitOptions,
  ): Promise<SaveProjectResponse>;
  saveProjectEditorMetadata(
    projectSessionId: string,
    expectedWorkspaceRevision: string,
    editorState: import('./project-schema/editor-project-state').EditorProjectState,
    expectedFileRevisions?: Record<string, `sha256:${string}`>,
  ): Promise<SaveProjectEditorMetadataResponse>;
  saveProjectCopyAs(
    projectSessionId: string,
    project: unknown,
    workingProjectAssetPaths?: string[],
    scriptSourcePaths?: Record<string, string>,
  ): Promise<SaveProjectResponse>;
  importAssets(
    projectSessionId: string,
    options?: AssetImportOptions,
  ): Promise<AssetImportResponse>;
  reimportAsset(
    projectSessionId: string,
    projectRelativePath: string,
  ): Promise<AssetReimportResponse>;
  auditProjectAssets(
    projectSessionId: string,
    project: unknown,
  ): Promise<ProjectAssetAuditResponse>;
  importUntrackedProjectAssets(
    projectSessionId: string,
    projectRelativePaths: string[],
  ): Promise<ProjectAssetFileOperationResponse>;
  trashProjectAssetFiles(
    projectSessionId: string,
    projectRelativePaths: string[],
  ): Promise<ProjectAssetFileOperationResponse>;
  restoreProjectAssetFiles(
    projectSessionId: string,
    moves: ProjectAssetTrashMove[],
  ): Promise<ProjectAssetFileOperationResponse>;
  purgeProjectTrash(projectSessionId: string): Promise<ProjectAssetFileOperationResponse>;
  startProjectWorkspaceWatcher(
    projectSessionId: string,
  ): Promise<ProjectAssetFileOperationResponse>;
  stopProjectWorkspaceWatcher(projectSessionId: string): Promise<ProjectAssetFileOperationResponse>;
  onProjectWorkspaceChanged(callback: (event: ProjectWorkspaceWatchEvent) => void): () => void;
  resolveProjectAssetUrl(
    projectFilePath: string,
    projectRelativePath: string,
  ): Promise<ProjectAssetUrlResponse | null>;
  requestImageThumbnail(
    request: import('./image-thumbnails').ImageThumbnailRequest,
  ): Promise<import('./image-thumbnails').ImageThumbnailResult>;
  prewarmImageThumbnails(
    request: import('./image-thumbnails').ImageThumbnailPrewarmRequest,
  ): Promise<import('./image-thumbnails').ImageThumbnailPrewarmResult>;
  cancelImageThumbnailPrewarm(
    request: import('./image-thumbnails').CancelImageThumbnailPrewarmRequest,
  ): Promise<import('./image-thumbnails').CancelImageThumbnailPrewarmResult>;
  clearEditorCache(): Promise<import('./image-thumbnails').ClearEditorCacheResult>;
  onEditorCacheEpoch(
    callback: (event: import('./image-thumbnails').EditorCacheEpochEvent) => void,
  ): () => void;
  readProjectTextSources(
    request: import('./project-text-sources').ReadProjectTextSourcesRequest,
  ): Promise<import('./project-text-sources').ReadProjectTextSourcesResponse>;
  checkComfyUiConnection(config: ComfyUiConfig): Promise<ComfyUiStatus>;
  getComfyUiQueue(config: ComfyUiConfig): Promise<ComfyUiQueueProgress>;
  listComfyUiWorkflowLibrary(
    request?: ComfyUiWorkflowLibraryListRequest,
  ): Promise<ComfyUiWorkflowLibraryListResponse>;
  copyComfyUiWorkflow(request: ComfyUiWorkflowCopyRequest): Promise<ComfyUiWorkflowCopyResponse>;
  deleteComfyUiWorkflow(
    request: ComfyUiWorkflowDeleteRequest,
  ): Promise<ComfyUiWorkflowDeleteResponse>;
  renameComfyUiWorkflow(
    request: import('./comfyui-workflows').ComfyUiWorkflowRenameRequest,
  ): Promise<import('./comfyui-workflows').ComfyUiWorkflowRenameResponse>;
  importComfyUiWorkflowToLibrary(
    request: ComfyUiImportWorkflowToLibraryRequest,
  ): Promise<ComfyUiImportWorkflowToLibraryResponse>;
  repairComfyUiWorkflowInLibrary(
    request: ComfyUiRepairWorkflowInLibraryRequest,
  ): Promise<ComfyUiRepairWorkflowInLibraryResponse>;
  revealComfyUiWorkflow(
    workflowKey: ComfyUiWorkflowKey,
    projectFilePath?: string | null,
  ): Promise<boolean>;
  verifyComfyUiWorkflowLibrary(
    request: ComfyUiVerifyWorkflowLibraryRequest,
  ): Promise<ComfyUiVerifyWorkflowLibraryResponse>;
  analyzeComfyUiWorkflowImport(
    request: ComfyUiAnalyzeWorkflowImportRequest,
  ): Promise<ComfyUiAnalyzeWorkflowImportResponse>;
  generateComfyUiImage(
    config: ComfyUiConfig,
    request: ComfyUiGenerateImageRequest,
  ): Promise<ComfyUiImageJobResponse>;
  editComfyUiImage(
    config: ComfyUiConfig,
    request: ComfyUiEditImageRequest,
  ): Promise<ComfyUiImageJobResponse>;
  cancelComfyUiJob(config: ComfyUiConfig): Promise<ComfyUiCancelJobResponse>;
  onComfyUiProgress(callback: (progress: ComfyUiQueueProgress) => void): () => void;
}

type FunctionProperties<T> = {
  [Key in keyof T]: T[Key] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Result
    : T[Key];
};

export type NovelTeaElectronApi = FunctionProperties<NovelTeaElectronApiContract>;
import type {
  AssetImportOptions,
  AssetImportResponse,
  AssetReimportResponse,
} from './asset-import';
import type { ComfyUiConfig, ComfyUiQueueProgress, ComfyUiStatus } from './comfyui';
import type {
  ComfyUiCancelJobResponse,
  ComfyUiEditImageRequest,
  ComfyUiGenerateImageRequest,
  ComfyUiImageJobResponse,
} from './comfyui-generation';
import type {
  ComfyUiAnalyzeWorkflowImportRequest,
  ComfyUiAnalyzeWorkflowImportResponse,
  ComfyUiImportWorkflowToLibraryRequest,
  ComfyUiImportWorkflowToLibraryResponse,
  ComfyUiRepairWorkflowInLibraryRequest,
  ComfyUiRepairWorkflowInLibraryResponse,
  ComfyUiVerifyWorkflowLibraryRequest,
  ComfyUiVerifyWorkflowLibraryResponse,
  ComfyUiWorkflowCopyRequest,
  ComfyUiWorkflowCopyResponse,
  ComfyUiWorkflowDeleteRequest,
  ComfyUiWorkflowDeleteResponse,
  ComfyUiWorkflowKey,
  ComfyUiWorkflowLibraryListRequest,
  ComfyUiWorkflowLibraryListResponse,
} from './comfyui-workflows';
import type { EnginePreviewSession } from './preview-protocol';
import type { EditorShortcutCommand } from './editor-shortcuts';
import type {
  ProjectAssetAuditResponse,
  ProjectAssetFileOperationResponse,
  ProjectAssetTrashMove,
} from './project-asset-audit';
import type { ProjectWorkspaceWatchEvent } from './project-workspace-watch';
import type { ProjectAssetUrlResponse } from './project-asset-url';
import type {
  CreateProjectRequest,
  OpenProjectResponse,
  SaveProjectEditorMetadataResponse,
  PackageExportOptions,
  PackageExportResponse,
  PackagePreviewResponse,
  PlaybackReportResponse,
  SaveProjectResponse,
  ShaderCompileOptions,
  ShaderCompileResponse,
  TestListResponse,
  ValidationResponse,
} from './editor-tooling';
