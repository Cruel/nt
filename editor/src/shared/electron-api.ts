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
    projectSessionId: string,
    project: unknown,
    outputPath: string,
    options: import('./project-schema/prepared-runtime-artifact').PreparedRuntimePackageOptions,
  ): Promise<PackageExportResponse>;
  stagePlatformExport(
    projectSessionId: string,
    request: import('./project-schema/platform-export-contracts').PlatformStageRequest,
  ): Promise<import('./project-schema/platform-export-contracts').PlatformStageResult>;
  exportProjectToPlatform(
    projectSessionId: string,
    request: Omit<
      import('./project-schema/platform-export-contracts').ProjectPlatformExportRequest,
      'projectPath' | 'projectRoot'
    >,
  ): Promise<import('./project-schema/platform-export-contracts').PlatformStageResult>;
  onPlatformExportProgress(
    callback: (
      event: import('./project-schema/platform-export-contracts').PlatformExportProgressEvent,
    ) => void,
  ): () => void;
  cancelPlatformExport(
    projectSessionId: string,
    operationId: string,
  ): Promise<{ cancelled: boolean }>;
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
  loadUserExportConfig(): Promise<
    import('./project-schema/platform-export-contracts').UserExportConfig
  >;
  saveUserExportConfig(
    value: import('./project-schema/platform-export-contracts').UserExportConfig,
  ): Promise<import('./project-schema/platform-export-contracts').UserExportConfig>;
  loadUserPreferences(): Promise<import('./user-config').NovelTeaUserPreferences>;
  saveUserPreferences(
    value: import('./user-config').NovelTeaUserPreferences,
  ): Promise<import('./user-config').NovelTeaUserPreferences>;
  compileShaders(
    projectSessionId: string,
    shaderProject: unknown,
    options?: Pick<ShaderCompileOptions, 'forceRebuild' | 'shaderVariants'>,
  ): Promise<ShaderCompileResponse>;
  saveProjectContent(
    projectSessionId: string,
    request: import('./editor-tooling').ProjectContentSaveRequest,
    editorState: import('./project-schema/editor-project-state').EditorProjectState,
  ): Promise<import('./editor-tooling').ProjectContentSaveResponse>;
  saveProjectEditorMetadata(
    projectSessionId: string,
    editorState: import('./project-schema/editor-project-state').EditorProjectState,
    recoveryFileOwnershipHints?: Record<string, string[]>,
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
  resolveProjectOriginalAssetUrl(
    projectSessionId: string,
    assetId: string,
  ): Promise<ProjectOriginalAssetUrlResponse>;
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
  loadComfyUiUserConfig(): Promise<ComfyUiSharedUserConfig>;
  saveComfyUiUserConfig(config: ComfyUiSharedUserConfig): Promise<ComfyUiSharedUserConfig>;
  checkComfyUiConnection(config: ComfyUiConfig): Promise<ComfyUiStatus>;
  getComfyUiQueue(config: ComfyUiConfig): Promise<ComfyUiQueueProgress>;
  listComfyUiWorkflowLibrary(
    projectSessionId: string | null,
    request?: Omit<ComfyUiWorkflowLibraryListRequest, 'projectFilePath'>,
  ): Promise<ComfyUiWorkflowLibraryListResponse>;
  copyComfyUiWorkflow(
    projectSessionId: string | null,
    request: Omit<ComfyUiWorkflowCopyRequest, 'projectFilePath'>,
  ): Promise<ComfyUiWorkflowCopyResponse>;
  deleteComfyUiWorkflow(
    projectSessionId: string | null,
    request: Omit<ComfyUiWorkflowDeleteRequest, 'projectFilePath'>,
  ): Promise<ComfyUiWorkflowDeleteResponse>;
  renameComfyUiWorkflow(
    projectSessionId: string | null,
    request: Omit<import('./comfyui-workflows').ComfyUiWorkflowRenameRequest, 'projectFilePath'>,
  ): Promise<import('./comfyui-workflows').ComfyUiWorkflowRenameResponse>;
  importComfyUiWorkflowToLibrary(
    request: ComfyUiImportWorkflowToLibraryRequest,
  ): Promise<ComfyUiImportWorkflowToLibraryResponse>;
  repairComfyUiWorkflowInLibrary(
    projectSessionId: string | null,
    request: Omit<ComfyUiRepairWorkflowInLibraryRequest, 'projectFilePath'>,
  ): Promise<ComfyUiRepairWorkflowInLibraryResponse>;
  revealComfyUiWorkflow(
    projectSessionId: string | null,
    workflowKey: ComfyUiWorkflowKey,
  ): Promise<boolean>;
  verifyComfyUiWorkflowLibrary(
    projectSessionId: string | null,
    request: Omit<ComfyUiVerifyWorkflowLibraryRequest, 'projectFilePath'>,
  ): Promise<ComfyUiVerifyWorkflowLibraryResponse>;
  analyzeComfyUiWorkflowImport(
    projectSessionId: string | null,
    request: Omit<ComfyUiAnalyzeWorkflowImportRequest, 'projectFilePath'>,
  ): Promise<ComfyUiAnalyzeWorkflowImportResponse>;
  generateComfyUiImage(
    projectSessionId: string,
    config: ComfyUiConfig,
    request: Omit<ComfyUiGenerateImageRequest, 'projectFilePath'>,
  ): Promise<ComfyUiImageJobResponse>;
  editComfyUiImage(
    projectSessionId: string,
    config: ComfyUiConfig,
    request: ComfyUiEditImageRequest,
  ): Promise<ComfyUiImageJobResponse>;
  cancelComfyUiJob(
    projectSessionId: string,
    config: ComfyUiConfig,
  ): Promise<ComfyUiCancelJobResponse>;
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
import type {
  ComfyUiConfig,
  ComfyUiQueueProgress,
  ComfyUiSharedUserConfig,
  ComfyUiStatus,
} from './comfyui';
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
import type { ProjectOriginalAssetUrlResponse } from './project-original-asset';
import type {
  CreateProjectRequest,
  OpenProjectResponse,
  SaveProjectEditorMetadataResponse,
  PackageExportResponse,
  PackagePreviewResponse,
  PlaybackReportResponse,
  SaveProjectResponse,
  ShaderCompileOptions,
  ShaderCompileResponse,
  TestListResponse,
  ValidationResponse,
} from './editor-tooling';
