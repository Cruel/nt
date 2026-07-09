import { contextBridge, ipcRenderer } from 'electron';
import type { NovelTeaElectronApi } from './shared/electron-api';
import { IPC_CHANNELS } from './shared/ipc-channels';

const api: NovelTeaElectronApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_INFO),
  getDefaultProjectDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_DEFAULT_PROJECT_DIRECTORY),
  selectDirectory: (options = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.SELECT_DIRECTORY, options),
  selectProjectDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SELECT_PROJECT_DIRECTORY),
  selectPackageOutputPath: (defaultPath: string | null = null) =>
    ipcRenderer.invoke(IPC_CHANNELS.SELECT_PACKAGE_OUTPUT_PATH, defaultPath),
  showItemInFolder: (path: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, path),
  previewExportedPackage: (packagePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_EXPORTED_PACKAGE, packagePath),
  openExternal: (url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),
  zoomIn: () => ipcRenderer.invoke(IPC_CHANNELS.ZOOM_IN),
  zoomOut: () => ipcRenderer.invoke(IPC_CHANNELS.ZOOM_OUT),
  resetZoom: () => ipcRenderer.invoke(IPC_CHANNELS.RESET_ZOOM),
  minimizeAppWindow: () => ipcRenderer.invoke(IPC_CHANNELS.MINIMIZE_APP_WINDOW),
  toggleMaximizeAppWindow: () =>
    ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_MAXIMIZE_APP_WINDOW),
  requestAppWindowExit: () => ipcRenderer.invoke(IPC_CHANNELS.REQUEST_APP_WINDOW_EXIT),
  completeAppWindowExit: () => ipcRenderer.invoke(IPC_CHANNELS.COMPLETE_APP_WINDOW_EXIT),
  onAppWindowBeforeClose: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.APP_WINDOW_BEFORE_CLOSE, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_WINDOW_BEFORE_CLOSE, listener);
  },
  isAppWindowMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.IS_APP_WINDOW_MAXIMIZED),
  setNativeWindowFrame: (nativeFrame: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_NATIVE_WINDOW_FRAME, nativeFrame),
  getEnginePreviewSession: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_ENGINE_PREVIEW_SESSION),
  reloadEnginePreview: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RELOAD_ENGINE_PREVIEW),
  createProject: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.CREATE_PROJECT, request),
  openProject: (projectPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_PROJECT, projectPath),
  importLegacyGame: (source: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_LEGACY_GAME, source),
  validateProject: (project: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.VALIDATE_PROJECT, project),
  listPlaybackTests: (project: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_PLAYBACK_TESTS, project),
  runPlaybackTest: (project: unknown, testId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUN_PLAYBACK_TEST, project, testId),
  runPlaybackSpec: (project: unknown, spec: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUN_PLAYBACK_SPEC, project, spec),
  runUiPlaybackSpec: (project: unknown, spec: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUN_UI_PLAYBACK_SPEC, project, spec),
  exportPackage: (project: unknown, outputPath: string, options = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_PACKAGE, project, outputPath, options),
  compileShaders: (shaderProject: unknown, options = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPILE_SHADERS, shaderProject, options),
  saveProject: (project: unknown, projectFilePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_PROJECT, project, projectFilePath),
  saveProjectAs: (project: unknown, defaultPath: string | null = null, currentProjectFilePath: string | null = null) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_PROJECT_AS, project, defaultPath, currentProjectFilePath),
  importAssets: (projectFilePath: string, options = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_ASSETS, projectFilePath, options),
  reimportAsset: (projectFilePath: string, projectRelativePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.REIMPORT_ASSET, projectFilePath, projectRelativePath),
  auditProjectAssets: (projectFilePath: string, project: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIT_PROJECT_ASSETS, projectFilePath, project),
  importUntrackedProjectAssets: (projectFilePath: string, projectRelativePaths: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_UNTRACKED_PROJECT_ASSETS, projectFilePath, projectRelativePaths),
  trashProjectAssetFiles: (projectFilePath: string, projectRelativePaths: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRASH_PROJECT_ASSET_FILES, projectFilePath, projectRelativePaths),
  restoreProjectAssetFiles: (projectFilePath: string, moves) =>
    ipcRenderer.invoke(IPC_CHANNELS.RESTORE_PROJECT_ASSET_FILES, projectFilePath, moves),
  purgeProjectTrash: (projectFilePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PURGE_PROJECT_TRASH, projectFilePath),
  startProjectAssetWatcher: (projectFilePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.START_PROJECT_ASSET_WATCHER, projectFilePath),
  stopProjectAssetWatcher: () =>
    ipcRenderer.invoke(IPC_CHANNELS.STOP_PROJECT_ASSET_WATCHER),
  onProjectAssetAuditChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: unknown) => callback(event as never);
    ipcRenderer.on(IPC_CHANNELS.PROJECT_ASSET_AUDIT_EVENT, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PROJECT_ASSET_AUDIT_EVENT, listener);
  },
  resolveProjectAssetUrl: (projectFilePath: string, projectRelativePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RESOLVE_PROJECT_ASSET_URL, projectFilePath, projectRelativePath),
  checkComfyUiConnection: (config) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_CHECK_CONNECTION, config),
  getComfyUiQueue: (config) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_GET_QUEUE, config),
  listComfyUiWorkflowLibrary: (request = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_LIST_WORKFLOW_LIBRARY, request),
  listComfyUiWorkflows: (projectFilePath) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_LIST_WORKFLOWS, projectFilePath),
  installComfyUiStarterWorkflows: (projectFilePath) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_INSTALL_STARTER_WORKFLOWS, projectFilePath),
  analyzeComfyUiWorkflowImport: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_ANALYZE_WORKFLOW_IMPORT, request),
  saveImportedComfyUiWorkflow: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_SAVE_IMPORTED_WORKFLOW, request),
  repairComfyUiWorkflowManifest: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_REPAIR_WORKFLOW_MANIFEST, request),
  generateComfyUiImage: (config, request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_GENERATE_IMAGE, config, request),
  editComfyUiImage: (config, request) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_EDIT_IMAGE, config, request),
  cancelComfyUiJob: (config) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMFYUI_CANCEL_JOB, config),
  onComfyUiProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress as never);
    ipcRenderer.on(IPC_CHANNELS.COMFYUI_PROGRESS_EVENT, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COMFYUI_PROGRESS_EVENT, listener);
  },
  setEntityRecord: (project: unknown, collection: string, entityId: string, record: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_ENTITY_RECORD, project, collection, entityId, record),
  eraseEntityRecord: (project: unknown, collection: string, entityId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ERASE_ENTITY_RECORD, project, collection, entityId),
};

contextBridge.exposeInMainWorld('noveltea', api);
