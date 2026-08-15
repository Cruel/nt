import { contextBridge, ipcRenderer } from 'electron';
import type { NovelTeaElectronApi } from './shared/electron-api';
import { IPC_CHANNELS } from './shared/ipc-channels';
import { normalizeEditorIpcBoundaryError } from './shared/editor-ipc-boundary';

async function invokeGuarded<Result>(channel: string, ...arguments_: unknown[]): Promise<Result> {
  try {
    return await ipcRenderer.invoke(channel, ...arguments_);
  } catch (error) {
    throw normalizeEditorIpcBoundaryError(error);
  }
}

const api: NovelTeaElectronApi = {
  getAppInfo: () => invokeGuarded(IPC_CHANNELS.GET_APP_INFO),
  getDefaultProjectDirectory: () => invokeGuarded(IPC_CHANNELS.GET_DEFAULT_PROJECT_DIRECTORY),
  selectDirectory: (options = {}) => invokeGuarded(IPC_CHANNELS.SELECT_DIRECTORY, options),
  selectProjectDirectory: () => invokeGuarded(IPC_CHANNELS.SELECT_PROJECT_DIRECTORY),
  selectPackageOutputPath: (defaultPath: string | null = null) =>
    invokeGuarded(IPC_CHANNELS.SELECT_PACKAGE_OUTPUT_PATH, defaultPath),
  selectTemplateArchivePath: () => invokeGuarded(IPC_CHANNELS.SELECT_TEMPLATE_ARCHIVE_PATH),
  showItemInFolder: (path: string) => invokeGuarded(IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, path),
  previewExportedPackage: (projectSessionId: string, packagePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_EXPORTED_PACKAGE, projectSessionId, packagePath),
  openExternal: (url: string) => invokeGuarded(IPC_CHANNELS.OPEN_EXTERNAL, url),
  zoomIn: () => invokeGuarded(IPC_CHANNELS.ZOOM_IN),
  zoomOut: () => invokeGuarded(IPC_CHANNELS.ZOOM_OUT),
  resetZoom: () => invokeGuarded(IPC_CHANNELS.RESET_ZOOM),
  minimizeAppWindow: () => invokeGuarded(IPC_CHANNELS.MINIMIZE_APP_WINDOW),
  toggleMaximizeAppWindow: () => invokeGuarded(IPC_CHANNELS.TOGGLE_MAXIMIZE_APP_WINDOW),
  requestAppWindowExit: () => invokeGuarded(IPC_CHANNELS.REQUEST_APP_WINDOW_EXIT),
  completeAppWindowExit: () => invokeGuarded(IPC_CHANNELS.COMPLETE_APP_WINDOW_EXIT),
  onAppWindowBeforeClose: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.APP_WINDOW_BEFORE_CLOSE, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_WINDOW_BEFORE_CLOSE, listener);
  },
  onEditorShortcut: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, command: unknown) =>
      callback(command as never);
    ipcRenderer.on(IPC_CHANNELS.EDITOR_SHORTCUT, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.EDITOR_SHORTCUT, listener);
  },
  isAppWindowMaximized: () => invokeGuarded(IPC_CHANNELS.IS_APP_WINDOW_MAXIMIZED),
  setNativeWindowFrame: (nativeFrame: boolean) =>
    invokeGuarded(IPC_CHANNELS.SET_NATIVE_WINDOW_FRAME, nativeFrame),
  getEnginePreviewSession: (projectSessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_ENGINE_PREVIEW_SESSION, projectSessionId),
  reloadEnginePreview: (projectSessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RELOAD_ENGINE_PREVIEW, projectSessionId),
  createProject: (request) => invokeGuarded(IPC_CHANNELS.CREATE_PROJECT, request),
  openProject: (projectPath: string) => invokeGuarded(IPC_CHANNELS.OPEN_PROJECT, projectPath),
  closeActiveProject: () => invokeGuarded(IPC_CHANNELS.CLOSE_ACTIVE_PROJECT),
  validateProject: (project: unknown) => ipcRenderer.invoke(IPC_CHANNELS.VALIDATE_PROJECT, project),
  listPlaybackTests: (project: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_PLAYBACK_TESTS, project),
  runPlaybackTest: (project: unknown, testId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUN_PLAYBACK_TEST, project, testId),
  runPlaybackSpec: (project: unknown, spec: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUN_PLAYBACK_SPEC, project, spec),
  runUiPlaybackSpec: (project: unknown, spec: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUN_UI_PLAYBACK_SPEC, project, spec),
  exportPackage: (projectSessionId: string, project: unknown, outputPath: string, options) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_PACKAGE, projectSessionId, project, outputPath, options),
  stagePlatformExport: (projectSessionId: string, request) =>
    ipcRenderer.invoke(IPC_CHANNELS.STAGE_PLATFORM_EXPORT, projectSessionId, request),
  exportProjectToPlatform: (projectSessionId: string, request) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_PROJECT_TO_PLATFORM, projectSessionId, request),
  onPlatformExportProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) =>
      callback(progress as never);
    ipcRenderer.on(IPC_CHANNELS.PLATFORM_EXPORT_PROGRESS_EVENT, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PLATFORM_EXPORT_PROGRESS_EVENT, listener);
  },
  cancelPlatformExport: (projectSessionId: string, operationId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANCEL_PLATFORM_EXPORT, projectSessionId, operationId),
  listPlayerTemplates: (query = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_PLAYER_TEMPLATES, query),
  inspectPlayerTemplate: (templateId, buildId) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSPECT_PLAYER_TEMPLATE, templateId, buildId),
  installPlayerTemplate: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSTALL_PLAYER_TEMPLATE, request),
  downloadPlayerTemplate: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_PLAYER_TEMPLATE, request),
  removePlayerTemplate: (templateId, buildId) =>
    ipcRenderer.invoke(IPC_CHANNELS.REMOVE_PLAYER_TEMPLATE, templateId, buildId),
  resolvePlayerTemplate: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.RESOLVE_PLAYER_TEMPLATE, request),
  compileShaders: (projectSessionId: string, shaderProject: unknown, options = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPILE_SHADERS, projectSessionId, shaderProject, options),
  saveProjectContent: (
    projectSessionId: string,
    expectedWorkspaceRevision: string,
    contentProject: unknown,
    editorState: import('./shared/project-schema/editor-project-state').EditorProjectState,
    scriptSourcePaths: Record<string, string> = {},
    commitOptions?: import('./shared/editor-tooling').ProjectWorkspaceCommitOptions,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SAVE_PROJECT_CONTENT,
      projectSessionId,
      expectedWorkspaceRevision,
      contentProject,
      editorState,
      scriptSourcePaths,
      commitOptions,
    ),
  saveProjectEditorMetadata: (
    projectSessionId: string,
    expectedWorkspaceRevision: string,
    editorState: import('./shared/project-schema/editor-project-state').EditorProjectState,
    expectedFileRevisions: Record<string, `sha256:${string}`> = {},
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SAVE_PROJECT_EDITOR_METADATA,
      projectSessionId,
      expectedWorkspaceRevision,
      editorState,
      expectedFileRevisions,
    ),
  saveProjectCopyAs: (
    projectSessionId: string,
    project: unknown,
    workingProjectAssetPaths: string[] = [],
    scriptSourcePaths: Record<string, string> = {},
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SAVE_PROJECT_COPY_AS,
      projectSessionId,
      project,
      workingProjectAssetPaths,
      scriptSourcePaths,
    ),
  importAssets: (projectSessionId: string, options = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_ASSETS, projectSessionId, options),
  reimportAsset: (projectSessionId: string, projectRelativePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.REIMPORT_ASSET, projectSessionId, projectRelativePath),
  auditProjectAssets: (projectSessionId: string, project: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIT_PROJECT_ASSETS, projectSessionId, project),
  importUntrackedProjectAssets: (projectSessionId: string, projectRelativePaths: string[]) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.IMPORT_UNTRACKED_PROJECT_ASSETS,
      projectSessionId,
      projectRelativePaths,
    ),
  trashProjectAssetFiles: (projectSessionId: string, projectRelativePaths: string[]) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.TRASH_PROJECT_ASSET_FILES,
      projectSessionId,
      projectRelativePaths,
    ),
  restoreProjectAssetFiles: (projectSessionId: string, moves) =>
    ipcRenderer.invoke(IPC_CHANNELS.RESTORE_PROJECT_ASSET_FILES, projectSessionId, moves),
  purgeProjectTrash: (projectSessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PURGE_PROJECT_TRASH, projectSessionId),
  startProjectWorkspaceWatcher: (projectSessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.START_PROJECT_WORKSPACE_WATCHER, projectSessionId),
  stopProjectWorkspaceWatcher: (projectSessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.STOP_PROJECT_WORKSPACE_WATCHER, projectSessionId),
  onProjectWorkspaceChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: unknown) =>
      callback(event as never);
    ipcRenderer.on(IPC_CHANNELS.PROJECT_WORKSPACE_WATCH_EVENT, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PROJECT_WORKSPACE_WATCH_EVENT, listener);
  },
  resolveProjectAssetUrl: (projectFilePath: string, projectRelativePath: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.RESOLVE_PROJECT_ASSET_URL,
      projectFilePath,
      projectRelativePath,
    ),
  requestImageThumbnail: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.REQUEST_IMAGE_THUMBNAIL, request),
  prewarmImageThumbnails: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.PREWARM_IMAGE_THUMBNAILS, request),
  cancelImageThumbnailPrewarm: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANCEL_IMAGE_THUMBNAIL_PREWARM, request),
  clearEditorCache: () => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_EDITOR_CACHE),
  onEditorCacheEpoch: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: unknown) =>
      callback(event as never);
    ipcRenderer.on(IPC_CHANNELS.EDITOR_CACHE_EPOCH_EVENT, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.EDITOR_CACHE_EPOCH_EVENT, listener);
  },
  readProjectTextSources: (request) =>
    invokeGuarded(IPC_CHANNELS.READ_PROJECT_TEXT_SOURCES, request),
  checkComfyUiConnection: (config) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_CHECK_CONNECTION, config),
  getComfyUiQueue: (config) => ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_GET_QUEUE, config),
  listComfyUiWorkflowLibrary: (projectSessionId, request = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_LIST_WORKFLOW_LIBRARY, projectSessionId, request),
  copyComfyUiWorkflow: (projectSessionId, request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_COPY_WORKFLOW, projectSessionId, request),
  deleteComfyUiWorkflow: (projectSessionId, request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_DELETE_WORKFLOW, projectSessionId, request),
  renameComfyUiWorkflow: (projectSessionId, request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_RENAME_WORKFLOW, projectSessionId, request),
  importComfyUiWorkflowToLibrary: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_IMPORT_WORKFLOW_TO_LIBRARY, request),
  repairComfyUiWorkflowInLibrary: (projectSessionId, request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_REPAIR_WORKFLOW_IN_LIBRARY, projectSessionId, request),
  revealComfyUiWorkflow: (projectSessionId, workflowKey) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_REVEAL_WORKFLOW, projectSessionId, workflowKey),
  verifyComfyUiWorkflowLibrary: (projectSessionId, request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_VERIFY_WORKFLOW_LIBRARY, projectSessionId, request),
  analyzeComfyUiWorkflowImport: (projectSessionId, request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_ANALYZE_WORKFLOW_IMPORT, projectSessionId, request),
  generateComfyUiImage: (projectSessionId, config, request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_GENERATE_IMAGE, projectSessionId, config, request),
  editComfyUiImage: (projectSessionId, config, request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_EDIT_IMAGE, projectSessionId, config, request),
  cancelComfyUiJob: (projectSessionId, config) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_CANCEL_JOB, projectSessionId, config),
  onComfyUiProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) =>
      callback(progress as never);
    ipcRenderer.on(IPC_CHANNELS.COMFYUI_PROGRESS_EVENT, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COMFYUI_PROGRESS_EVENT, listener);
  },
};

contextBridge.exposeInMainWorld('noveltea', api);
