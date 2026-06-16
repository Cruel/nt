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
};

contextBridge.exposeInMainWorld('noveltea', api);
