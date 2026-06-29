import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { IPC_CHANNELS } from './shared/ipc-channels';
import { EnginePreviewServer } from './main/engine-preview-server';
import { importAssets, reimportAsset } from './main/services/asset-import-service';
import {
  eraseEntityRecord,
  exportPackage,
  importLegacyGame,
  listPlaybackTests,
  openProject,
  runPlaybackTest,
  setEntityRecord,
  validateProject,
} from './main/services/editor-tool-service';
import { saveProject, saveProjectAs } from './main/services/project-file-service';
import type { AssetImportOptions } from './shared/asset-import';
import type { PackageExportOptions } from './shared/editor-tooling';

if (started) {
  app.quit();
}

// WSL2 and some remote/Linux GPU stacks blocklist WebGL in Electron even when
// the browser can render the same page. The engine preview is a local dev-only
// iframe, so allow Chromium to use SwiftShader or an unblocked GL path.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

let mainWindow: BrowserWindow | null = null;
const enginePreviewServer = new EnginePreviewServer();

const DEV_SERVER_URL = MAIN_WINDOW_VITE_DEV_SERVER_URL;
const isDev = !!DEV_SERVER_URL;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

app.whenReady().then(() => {
  ipcMain.handle(IPC_CHANNELS.GET_APP_INFO, () => ({
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  }));

  ipcMain.handle(IPC_CHANNELS.SELECT_PROJECT_DIRECTORY, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(
    IPC_CHANNELS.OPEN_EXTERNAL,
    async (_event: Electron.IpcMainInvokeEvent, url: string) => {
      if (
        typeof url === 'string' &&
        (url.startsWith('https:') || url.startsWith('http:'))
      ) {
        await shell.openExternal(url);
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.GET_ENGINE_PREVIEW_SESSION, () =>
    enginePreviewServer.getSession(),
  );

  ipcMain.handle(IPC_CHANNELS.RELOAD_ENGINE_PREVIEW, () =>
    enginePreviewServer.reload(),
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_PROJECT,
    (_event: Electron.IpcMainInvokeEvent, projectPath: string) =>
      openProject(projectPath),
  );

  ipcMain.handle(
    IPC_CHANNELS.IMPORT_LEGACY_GAME,
    (_event: Electron.IpcMainInvokeEvent, source: string) =>
      importLegacyGame(source),
  );

  ipcMain.handle(
    IPC_CHANNELS.VALIDATE_PROJECT,
    (_event: Electron.IpcMainInvokeEvent, project: unknown) =>
      validateProject(project),
  );

  ipcMain.handle(
    IPC_CHANNELS.LIST_PLAYBACK_TESTS,
    (_event: Electron.IpcMainInvokeEvent, project: unknown) =>
      listPlaybackTests(project),
  );

  ipcMain.handle(
    IPC_CHANNELS.RUN_PLAYBACK_TEST,
    (_event: Electron.IpcMainInvokeEvent, project: unknown, testId: string) =>
      runPlaybackTest(project, testId),
  );

  ipcMain.handle(
    IPC_CHANNELS.EXPORT_PACKAGE,
    (
      _event: Electron.IpcMainInvokeEvent,
      project: unknown,
      outputPath: string,
      options: unknown,
    ) => exportPackage(project, outputPath, options as PackageExportOptions),
  );

  ipcMain.handle(
    IPC_CHANNELS.SAVE_PROJECT,
    (_event: Electron.IpcMainInvokeEvent, project: unknown, projectFilePath: string) =>
      saveProject(project, projectFilePath),
  );

  ipcMain.handle(
    IPC_CHANNELS.SAVE_PROJECT_AS,
    (_event: Electron.IpcMainInvokeEvent, project: unknown, defaultPath: string | null) =>
      saveProjectAs(mainWindow, project, defaultPath),
  );

  ipcMain.handle(
    IPC_CHANNELS.IMPORT_ASSETS,
    (_event: Electron.IpcMainInvokeEvent, projectFilePath: string, options: unknown) =>
      importAssets(mainWindow, projectFilePath, options as AssetImportOptions),
  );

  ipcMain.handle(
    IPC_CHANNELS.REIMPORT_ASSET,
    (_event: Electron.IpcMainInvokeEvent, projectFilePath: string, projectRelativePath: string) =>
      reimportAsset(mainWindow, projectFilePath, projectRelativePath),
  );

  ipcMain.handle(
    IPC_CHANNELS.SET_ENTITY_RECORD,
    (
      _event: Electron.IpcMainInvokeEvent,
      project: unknown,
      collection: string,
      entityId: string,
      record: unknown,
    ) => setEntityRecord(project, collection, entityId, record),
  );

  ipcMain.handle(
    IPC_CHANNELS.ERASE_ENTITY_RECORD,
    (
      _event: Electron.IpcMainInvokeEvent,
      project: unknown,
      collection: string,
      entityId: string,
    ) => eraseEntityRecord(project, collection, entityId),
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  void enginePreviewServer.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
