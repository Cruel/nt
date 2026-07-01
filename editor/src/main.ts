import { app, BrowserWindow, ipcMain, shell, dialog, Menu } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { IPC_CHANNELS } from './shared/ipc-channels';
import { EnginePreviewServer } from './main/engine-preview-server';
import { importAssets, reimportAsset } from './main/services/asset-import-service';
import {
  compileShaders,
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
import type { PackageExportOptions, ShaderCompileOptions } from './shared/editor-tooling';

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
const ZOOM_STEP = 0.1;
const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 2;
let currentNativeWindowFrame = process.platform === 'linux';
let currentFramelessWindow = !currentNativeWindowFrame;
function getEditorWindowSettingsPath() {
  return path.join(app.getPath('userData'), 'editor-window-settings.json');
}

function defaultNativeWindowFrame() {
  return process.platform === 'linux';
}

function readNativeWindowFrameSetting() {
  const settingsPath = getEditorWindowSettingsPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { nativeWindowFrame?: unknown };
    return typeof parsed.nativeWindowFrame === 'boolean'
      ? parsed.nativeWindowFrame
      : defaultNativeWindowFrame();
  } catch {
    return defaultNativeWindowFrame();
  }
}

function writeNativeWindowFrameSetting(nativeWindowFrame: boolean) {
  const settingsPath = getEditorWindowSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify({ nativeWindowFrame }, null, 2)}\n`, 'utf8');
}

function getAppInfoPayload() {
  return {
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    frameless: currentFramelessWindow,
    nativeFrame: currentNativeWindowFrame,
  };
}

function clampZoomFactor(value: number) {
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, value));
}

function setWindowZoom(window: BrowserWindow, zoomFactor: number) {
  const nextZoomFactor = clampZoomFactor(zoomFactor);
  window.webContents.setZoomFactor(nextZoomFactor);
  return nextZoomFactor;
}

function getEventWindow(event: Electron.IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
}

function installZoomShortcuts(window: BrowserWindow) {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || !(input.control || input.meta)) return;

    const key = input.key.toLowerCase();
    const code = input.code;
    const zoomFactor = window.webContents.getZoomFactor();

    if (key === '+' || key === '=' || code === 'NumpadAdd') {
      event.preventDefault();
      setWindowZoom(window, zoomFactor + ZOOM_STEP);
      return;
    }

    if (key === '-' || code === 'Minus' || code === 'NumpadSubtract') {
      event.preventDefault();
      setWindowZoom(window, zoomFactor - ZOOM_STEP);
      return;
    }

    if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
      event.preventDefault();
      setWindowZoom(window, 1);
    }
  });
}

function installApplicationMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { role: 'close' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(isDev ? [
          { role: 'forceReload' as const },
          { role: 'toggleDevTools' as const },
          { type: 'separator' as const },
        ] : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
  ];

  Menu.setApplicationMenu(
    process.platform === 'darwin' ? Menu.buildFromTemplate(template) : null,
  );
}

function createWindow() {
  currentNativeWindowFrame = readNativeWindowFrameSetting();
  currentFramelessWindow = !currentNativeWindowFrame;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 650,
    frame: currentNativeWindowFrame,
    backgroundColor: '#09090b',
    ...(currentFramelessWindow && process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  installZoomShortcuts(mainWindow);

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
  installApplicationMenu();

  ipcMain.handle(IPC_CHANNELS.GET_APP_INFO, () => getAppInfoPayload());

  ipcMain.handle(IPC_CHANNELS.SELECT_PROJECT_DIRECTORY, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open NovelTea Project',
      properties: ['openFile'],
      filters: [
        { name: 'NovelTea Project', extensions: ['json', 'game'] },
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
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

  ipcMain.handle(IPC_CHANNELS.ZOOM_IN, (event: Electron.IpcMainInvokeEvent) => {
    const window = getEventWindow(event);
    return window ? setWindowZoom(window, window.webContents.getZoomFactor() + ZOOM_STEP) : 1;
  });

  ipcMain.handle(IPC_CHANNELS.ZOOM_OUT, (event: Electron.IpcMainInvokeEvent) => {
    const window = getEventWindow(event);
    return window ? setWindowZoom(window, window.webContents.getZoomFactor() - ZOOM_STEP) : 1;
  });

  ipcMain.handle(IPC_CHANNELS.RESET_ZOOM, (event: Electron.IpcMainInvokeEvent) => {
    const window = getEventWindow(event);
    return window ? setWindowZoom(window, 1) : 1;
  });

  ipcMain.handle(IPC_CHANNELS.MINIMIZE_APP_WINDOW, (event: Electron.IpcMainInvokeEvent) => {
    const window = getEventWindow(event);
    window?.minimize();
  });

  ipcMain.handle(IPC_CHANNELS.TOGGLE_MAXIMIZE_APP_WINDOW, (event: Electron.IpcMainInvokeEvent) => {
    const window = getEventWindow(event);
    if (!window) return false;
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    return window.isMaximized();
  });

  ipcMain.handle(IPC_CHANNELS.REQUEST_APP_WINDOW_EXIT, (event: Electron.IpcMainInvokeEvent) => {
    getEventWindow(event)?.close();
  });

  ipcMain.handle(IPC_CHANNELS.IS_APP_WINDOW_MAXIMIZED, (event: Electron.IpcMainInvokeEvent) => {
    return getEventWindow(event)?.isMaximized() ?? false;
  });

  ipcMain.handle(IPC_CHANNELS.SET_NATIVE_WINDOW_FRAME, (_event: Electron.IpcMainInvokeEvent, nativeFrame: boolean) => {
    writeNativeWindowFrameSetting(nativeFrame);
    currentNativeWindowFrame = nativeFrame;
    currentFramelessWindow = !nativeFrame;
    return getAppInfoPayload();
  });

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
    IPC_CHANNELS.COMPILE_SHADERS,
    (_event: Electron.IpcMainInvokeEvent, shaderProject: unknown, options: unknown) =>
      compileShaders(shaderProject, options as ShaderCompileOptions),
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
