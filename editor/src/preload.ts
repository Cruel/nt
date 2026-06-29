import { contextBridge, ipcRenderer } from 'electron';
import type { NovelTeaElectronApi } from './shared/electron-api';
import { IPC_CHANNELS } from './shared/ipc-channels';

const api: NovelTeaElectronApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_INFO),
  selectProjectDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SELECT_PROJECT_DIRECTORY),
  openExternal: (url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),
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
  exportPackage: (project: unknown, outputPath: string, options = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_PACKAGE, project, outputPath, options),
  saveProject: (project: unknown, projectFilePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_PROJECT, project, projectFilePath),
  saveProjectAs: (project: unknown, defaultPath: string | null = null) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_PROJECT_AS, project, defaultPath),
  setEntityRecord: (project: unknown, collection: string, entityId: string, record: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_ENTITY_RECORD, project, collection, entityId, record),
  eraseEntityRecord: (project: unknown, collection: string, entityId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ERASE_ENTITY_RECORD, project, collection, entityId),
};

contextBridge.exposeInMainWorld('noveltea', api);
