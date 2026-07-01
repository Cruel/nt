import { contextBridge, ipcRenderer } from 'electron';
import type { NovelTeaElectronApi } from './shared/electron-api';
import { IPC_CHANNELS } from './shared/ipc-channels';

const api: NovelTeaElectronApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_INFO),
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
  exportPackage: (project: unknown, outputPath: string, options = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_PACKAGE, project, outputPath, options),
  compileShaders: (shaderProject: unknown, options = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPILE_SHADERS, shaderProject, options),
  saveProject: (project: unknown, projectFilePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_PROJECT, project, projectFilePath),
  saveProjectAs: (project: unknown, defaultPath: string | null = null) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_PROJECT_AS, project, defaultPath),
  importAssets: (projectFilePath: string, options = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_ASSETS, projectFilePath, options),
  reimportAsset: (projectFilePath: string, projectRelativePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.REIMPORT_ASSET, projectFilePath, projectRelativePath),
  setEntityRecord: (project: unknown, collection: string, entityId: string, record: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_ENTITY_RECORD, project, collection, entityId, record),
  eraseEntityRecord: (project: unknown, collection: string, entityId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ERASE_ENTITY_RECORD, project, collection, entityId),
};

contextBridge.exposeInMainWorld('noveltea', api);
