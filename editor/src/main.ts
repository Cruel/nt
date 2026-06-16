import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { IPC_CHANNELS } from './shared/ipc-channels';
import { EnginePreviewServer } from './main/engine-preview-server';

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
