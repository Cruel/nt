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

export interface NovelTeaElectronApi {
  getAppInfo(): Promise<AppInfo>;
  selectProjectDirectory(): Promise<string | null>;
  selectPackageOutputPath(defaultPath?: string | null): Promise<string | null>;
  showItemInFolder(path: string): Promise<void>;
  previewExportedPackage(packagePath: string): Promise<PackagePreviewResponse>;
  openExternal(url: string): Promise<void>;
  zoomIn(): Promise<number>;
  zoomOut(): Promise<number>;
  resetZoom(): Promise<number>;
  minimizeAppWindow(): Promise<void>;
  toggleMaximizeAppWindow(): Promise<boolean>;
  requestAppWindowExit(): Promise<void>;
  completeAppWindowExit(): Promise<void>;
  onAppWindowBeforeClose(callback: () => void): () => void;
  isAppWindowMaximized(): Promise<boolean>;
  setNativeWindowFrame(nativeFrame: boolean): Promise<AppInfo>;
  getEnginePreviewSession(): Promise<EnginePreviewSession>;
  reloadEnginePreview(): Promise<EnginePreviewSession>;
  openProject(projectPath: string): Promise<OpenProjectResponse>;
  importLegacyGame(source: string): Promise<ProjectLoadResponse>;
  validateProject(project: unknown): Promise<ValidationResponse>;
  listPlaybackTests(project: unknown): Promise<TestListResponse>;
  runPlaybackTest(project: unknown, testId: string): Promise<PlaybackReportResponse>;
  runPlaybackSpec(project: unknown, spec: unknown): Promise<PlaybackReportResponse>;
  exportPackage(
    project: unknown,
    outputPath: string,
    options?: PackageExportOptions,
  ): Promise<PackageExportResponse>;
  compileShaders(shaderProject: unknown, options?: ShaderCompileOptions): Promise<ShaderCompileResponse>;
  saveProject(project: unknown, projectFilePath: string): Promise<SaveProjectResponse>;
  saveProjectAs(project: unknown, defaultPath?: string | null, currentProjectFilePath?: string | null): Promise<SaveProjectResponse>;
  importAssets(projectFilePath: string, options?: AssetImportOptions): Promise<AssetImportResponse>;
  reimportAsset(projectFilePath: string, projectRelativePath: string): Promise<AssetReimportResponse>;
  auditProjectAssets(projectFilePath: string, project: unknown): Promise<ProjectAssetAuditResponse>;
  importUntrackedProjectAssets(projectFilePath: string, projectRelativePaths: string[]): Promise<ProjectAssetFileOperationResponse>;
  trashProjectAssetFiles(projectFilePath: string, projectRelativePaths: string[]): Promise<ProjectAssetFileOperationResponse>;
  restoreProjectAssetFiles(projectFilePath: string, moves: ProjectAssetTrashMove[]): Promise<ProjectAssetFileOperationResponse>;
  purgeProjectTrash(projectFilePath: string): Promise<ProjectAssetFileOperationResponse>;
  startProjectAssetWatcher(projectFilePath: string): Promise<ProjectAssetFileOperationResponse>;
  stopProjectAssetWatcher(): Promise<ProjectAssetFileOperationResponse>;
  onProjectAssetAuditChanged(callback: (event: ProjectAssetAuditChangeEvent) => void): () => void;
  resolveProjectAssetUrl(projectFilePath: string, projectRelativePath: string): Promise<ProjectAssetUrlResponse | null>;
  checkComfyUiConnection(config: ComfyUiConfig): Promise<ComfyUiStatus>;
  getComfyUiQueue(config: ComfyUiConfig): Promise<ComfyUiQueueProgress>;
  listComfyUiWorkflows(projectFilePath: string): Promise<ComfyUiWorkflowListResponse>;
  installComfyUiStarterWorkflows(projectFilePath: string): Promise<ComfyUiInstallStarterWorkflowsResponse>;
  generateComfyUiImage(config: ComfyUiConfig, request: ComfyUiGenerateImageRequest): Promise<ComfyUiImageJobResponse>;
  editComfyUiImage(config: ComfyUiConfig, request: ComfyUiEditImageRequest): Promise<ComfyUiImageJobResponse>;
  cancelComfyUiJob(config: ComfyUiConfig): Promise<ComfyUiCancelJobResponse>;
  onComfyUiProgress(callback: (progress: ComfyUiQueueProgress) => void): () => void;
  setEntityRecord(
    project: unknown,
    collection: string,
    entityId: string,
    record: unknown,
  ): Promise<EntityEditResponse>;
  eraseEntityRecord(
    project: unknown,
    collection: string,
    entityId: string,
  ): Promise<EntityEditResponse>;
}
import type { AssetImportOptions, AssetImportResponse, AssetReimportResponse } from './asset-import';
import type { ComfyUiConfig, ComfyUiQueueProgress, ComfyUiStatus } from './comfyui';
import type { ComfyUiCancelJobResponse, ComfyUiEditImageRequest, ComfyUiGenerateImageRequest, ComfyUiImageJobResponse } from './comfyui-generation';
import type { ComfyUiInstallStarterWorkflowsResponse, ComfyUiWorkflowListResponse } from './comfyui-workflows';
import type { EnginePreviewSession } from './preview-protocol';
import type { ProjectAssetAuditChangeEvent, ProjectAssetAuditResponse, ProjectAssetFileOperationResponse, ProjectAssetTrashMove } from './project-asset-audit';
import type { ProjectAssetUrlResponse } from './project-asset-url';
import type {
  EntityEditResponse,
  OpenProjectResponse,
  PackageExportOptions,
  PackageExportResponse,
  PackagePreviewResponse,
  PlaybackReportResponse,
  ProjectLoadResponse,
  SaveProjectResponse,
  ShaderCompileOptions,
  ShaderCompileResponse,
  TestListResponse,
  ValidationResponse,
} from './editor-tooling';
