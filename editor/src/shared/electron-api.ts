export interface AppInfo {
  version: string;
  electronVersion: string;
  platform: string;
  arch: string;
  packaged: boolean;
}

export interface NovelTeaElectronApi {
  getAppInfo(): Promise<AppInfo>;
  selectProjectDirectory(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  getEnginePreviewSession(): Promise<EnginePreviewSession>;
  reloadEnginePreview(): Promise<EnginePreviewSession>;
  openProject(projectPath: string): Promise<OpenProjectResponse>;
  importLegacyGame(source: string): Promise<ProjectLoadResponse>;
  validateProject(project: unknown): Promise<ValidationResponse>;
  listPlaybackTests(project: unknown): Promise<TestListResponse>;
  runPlaybackTest(project: unknown, testId: string): Promise<PlaybackReportResponse>;
  exportPackage(
    project: unknown,
    outputPath: string,
    options?: PackageExportOptions,
  ): Promise<PackageExportResponse>;
  compileShaders(shaderProject: unknown, options?: ShaderCompileOptions): Promise<ShaderCompileResponse>;
  saveProject(project: unknown, projectFilePath: string): Promise<SaveProjectResponse>;
  saveProjectAs(project: unknown, defaultPath?: string | null): Promise<SaveProjectResponse>;
  importAssets(projectFilePath: string, options?: AssetImportOptions): Promise<AssetImportResponse>;
  reimportAsset(projectFilePath: string, projectRelativePath: string): Promise<AssetReimportResponse>;
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
import type { EnginePreviewSession } from './preview-protocol';
import type {
  EntityEditResponse,
  OpenProjectResponse,
  PackageExportOptions,
  PackageExportResponse,
  PlaybackReportResponse,
  ProjectLoadResponse,
  SaveProjectResponse,
  ShaderCompileOptions,
  ShaderCompileResponse,
  TestListResponse,
  ValidationResponse,
} from './editor-tooling';
