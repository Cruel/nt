import { app, BrowserWindow, ipcMain, shell, dialog, Menu, screen, protocol, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { IPC_CHANNELS } from './shared/ipc-channels';
import { EnginePreviewServer } from './main/engine-preview-server';
import { PACKAGE_SMOKE_FLAG, PACKAGE_SMOKE_PREFIX, runPackageSmoke } from './main/package-smoke';
import { importAssets, reimportAsset } from './main/services/asset-import-service';
import { cancelComfyUiJob, checkComfyUiConnection, editComfyUiImage, generateComfyUiImage, getComfyUiQueue } from './main/services/comfyui-service';
import { copyComfyUiWorkflow, deleteComfyUiWorkflow, importComfyUiWorkflowToLibrary, listComfyUiWorkflowLibrary, repairComfyUiWorkflowInLibrary, renameComfyUiWorkflow, revealComfyUiWorkflow, verifyComfyUiWorkflowLibrary } from './main/services/comfyui-workflow-library-service';
import { analyzeComfyUiWorkflowImport } from './main/services/comfyui-workflow-import-service';
import { auditProjectAssets, importUntrackedProjectAssets, purgeProjectTrash, restoreProjectAssetFiles, startProjectAssetWatcher, stopProjectAssetWatcher, trashProjectAssetFiles } from './main/services/project-asset-audit-service';
import { resolveProjectAssetUrl } from './main/services/project-asset-url-service';
import {
  compileShaders,
  exportPackage,
  listPlaybackTests,
  openProject,
  runPlaybackSpec,
  runPlaybackTest,
  runUiPlaybackSpec,
  validateProject,
} from './main/services/editor-tool-service';
import { createProject, saveProject, saveProjectAs } from './main/services/project-file-service';
import { cancelPlatformExport, redactPlatformStageResult, stagePlatformExport } from './main/services/platform-staging-service';
import { configureTemplateRegistryRoot, inspectPlayerTemplate, installPlayerTemplate, listPlayerTemplates, removePlayerTemplate, resolvePlayerTemplate } from './main/services/template-registry-service';
import { parseExportCommandArguments, runExportCommand } from './cli/export-command';
import { exportProjectToPlatform } from './main/services/platform-export-orchestration-service';
import type { PlatformStageRequest } from './shared/project-schema/platform-export-contracts';
import type { AssetImportOptions } from './shared/asset-import';
import type { ComfyUiConfig } from './shared/comfyui';
import type { ComfyUiEditImageRequest, ComfyUiGenerateImageRequest } from './shared/comfyui-generation';
import type { ComfyUiAnalyzeWorkflowImportRequest, ComfyUiImportWorkflowToLibraryRequest, ComfyUiRepairWorkflowInLibraryRequest, ComfyUiVerifyWorkflowLibraryRequest, ComfyUiWorkflowCopyRequest, ComfyUiWorkflowDeleteRequest, ComfyUiWorkflowKey, ComfyUiWorkflowLibraryListRequest, ComfyUiWorkflowRenameRequest } from './shared/comfyui-workflows';
import type { CreateProjectRequest, PackageExportOptions, ShaderCompileOptions } from './shared/editor-tooling';
import { resolveEditorShortcutCommand } from './shared/editor-shortcuts';

if (started) {
  app.quit();
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'noveltea-editor',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

// WSL2 and some remote/Linux GPU stacks blocklist WebGL in Electron even when
// the browser can render the same page. The engine preview is a local dev-only
// iframe, so allow Chromium to use SwiftShader or an unblocked GL path.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

let mainWindow: BrowserWindow | null = null;
const enginePreviewServer = new EnginePreviewServer();

const DEV_SERVER_URL = MAIN_WINDOW_VITE_DEV_SERVER_URL;
const isDev = !!DEV_SERVER_URL;
const EDITOR_SCHEME = 'noveltea-editor';
const ZOOM_STEP = 0.1;
const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 2;
let currentNativeWindowFrame = process.platform === 'linux';
let currentFramelessWindow = !currentNativeWindowFrame;
let appWindowExitConfirmed = false;

const EDITOR_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function registerPackagedEditorProtocol() {
  const rendererRoot = path.resolve(
    __dirname,
    `../renderer/${MAIN_WINDOW_VITE_NAME}`,
  );
  protocol.handle(EDITOR_SCHEME, async (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(rendererRoot, relative);
    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${path.sep}`)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const body = await fs.promises.readFile(filePath);
      return new Response(body, {
        headers: {
          'Content-Type': EDITOR_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function installLocalDocumentIsolationHeaders() {
  // Electron Forge's development server does not consistently expose Vite's
  // configured COOP/COEP headers to Chromium. Limit the fallback to local
  // top-level and iframe documents used by the editor and engine preview.
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://127.0.0.1:*/*', 'http://localhost:*/*'] },
    (details, callback) => {
      if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const responseHeaders = { ...(details.responseHeaders ?? {}) };
      responseHeaders['Cross-Origin-Opener-Policy'] = ['same-origin'];
      responseHeaders['Cross-Origin-Embedder-Policy'] = ['require-corp'];
      callback({ responseHeaders });
    },
  );
}

interface EditorWindowSettings {
  nativeWindowFrame?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
}

function rememberPreviewProjectRoot(result: { projectFilePath?: string; success?: boolean; ok?: boolean } | null | undefined) {
  if (result && result.success !== false && result.ok !== false && result.projectFilePath) {
    enginePreviewServer.setProjectFilePath(result.projectFilePath);
  }
  return result;
}

function getEditorWindowSettingsPath() {
  return path.join(app.getPath('userData'), 'editor-window-settings.json');
}

function defaultNativeWindowFrame() {
  return process.platform === 'linux';
}

function readEditorWindowSettings(): EditorWindowSettings {
  const settingsPath = getEditorWindowSettingsPath();
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as EditorWindowSettings;
  } catch {
    return {};
  }
}

function writeEditorWindowSettings(settings: EditorWindowSettings) {
  const settingsPath = getEditorWindowSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function readNativeWindowFrameSetting() {
  const parsed = readEditorWindowSettings();
  return typeof parsed.nativeWindowFrame === 'boolean'
    ? parsed.nativeWindowFrame
    : defaultNativeWindowFrame();
}

function writeNativeWindowFrameSetting(nativeWindowFrame: boolean) {
  writeEditorWindowSettings({ ...readEditorWindowSettings(), nativeWindowFrame });
}

function validSavedBounds(bounds: EditorWindowSettings['bounds']) {
  if (!bounds) return null;
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
  if (bounds.width < 1000 || bounds.height < 650) return null;
  const nearestDisplay = screen.getDisplayMatching(bounds);
  const area = nearestDisplay.workArea;
  const visibleX = bounds.x + bounds.width > area.x && bounds.x < area.x + area.width;
  const visibleY = bounds.y + bounds.height > area.y && bounds.y < area.y + area.height;
  return visibleX && visibleY ? bounds : null;
}

function saveEditorWindowBounds(window: BrowserWindow) {
  const settings = readEditorWindowSettings();
  const maximized = window.isMaximized();
  const bounds = maximized ? settings.bounds : window.getBounds();
  writeEditorWindowSettings({ ...settings, bounds, maximized });
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
    preferredSystemLanguages: app.getPreferredSystemLanguages(),
    systemLocale: app.getSystemLocale(),
  };
}

function getDefaultProjectDirectory() {
  return path.join(app.getPath('documents'), 'NovelTea');
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

function installWindowShortcuts(window: BrowserWindow) {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt) return;

    const key = input.key.toLowerCase();
    const code = input.code;
    if (code === 'F11' && !input.control && !input.meta && !input.shift) {
      event.preventDefault();
      window.setFullScreen(!window.isFullScreen());
      return;
    }

    if (key === 'i' && input.shift && (input.control || input.meta)) {
      event.preventDefault();
      window.webContents.toggleDevTools();
      return;
    }

    if (!(input.control || input.meta)) return;
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
      return;
    }

    // The renderer document cannot observe key events after focus enters a
    // preview iframe. Intercept only child-frame shortcuts here so normal
    // renderer focus keeps its DOM-aware handling (notably text editing).
    const focusedFrame = window.webContents.focusedFrame;
    if (!focusedFrame || focusedFrame === window.webContents.mainFrame) return;
    const editorCommand = resolveEditorShortcutCommand(input);
    if (editorCommand) {
      event.preventDefault();
      if (!input.isAutoRepeat) {
        window.webContents.send(IPC_CHANNELS.EDITOR_SHORTCUT, editorCommand);
      }
    }
  });
}

function installApplicationMenu() {
  // NovelTea uses the renderer-owned app menu/chrome. Do not expose a native
  // Electron application menu on any platform.
  Menu.setApplicationMenu(null);
}

function createWindow(): BrowserWindow {
  const windowSettings = readEditorWindowSettings();
  const savedBounds = validSavedBounds(windowSettings.bounds);
  currentNativeWindowFrame = readNativeWindowFrameSetting();
  currentFramelessWindow = !currentNativeWindowFrame;

  mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? 1280,
    height: savedBounds?.height ?? 800,
    x: savedBounds?.x,
    y: savedBounds?.y,
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

  if (windowSettings.maximized) mainWindow.maximize();

  let boundsSaveTimer: NodeJS.Timeout | null = null;
  const scheduleBoundsSave = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) saveEditorWindowBounds(mainWindow);
    }, 400);
  };
  mainWindow.on('resize', scheduleBoundsSave);
  mainWindow.on('move', scheduleBoundsSave);
  mainWindow.on('maximize', scheduleBoundsSave);
  mainWindow.on('unmaximize', scheduleBoundsSave);
  mainWindow.on('close', () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    saveEditorWindowBounds(mainWindow!);
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('close', (event) => {
    if (appWindowExitConfirmed || mainWindow?.webContents.isDestroyed()) return;
    event.preventDefault();
    mainWindow?.webContents.send(IPC_CHANNELS.APP_WINDOW_BEFORE_CLOSE);
    setTimeout(() => {
      if (!appWindowExitConfirmed && mainWindow && !mainWindow.isDestroyed()) {
        appWindowExitConfirmed = true;
        mainWindow.close();
      }
    }, 5000);
  });
  installWindowShortcuts(mainWindow);

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL!);
  } else {
    mainWindow.loadURL(`${EDITOR_SCHEME}://app/index.html`);
  }

  return mainWindow;
}

app.whenReady().then(() => {
  if (isDev) installLocalDocumentIsolationHeaders();
  if (!isDev) registerPackagedEditorProtocol();
  configureTemplateRegistryRoot(process.env.NOVELTEA_TEMPLATE_REGISTRY_ROOT ?? path.join(app.getPath('userData'), 'player-templates', 'v1'));
  if (process.argv.includes('--install-player-template')) {
    void (async () => {
      const index = process.argv.indexOf('--template'); const archivePath = index >= 0 ? process.argv[index + 1] : undefined;
      if (!archivePath) { process.stderr.write('Usage: NovelTea Editor --install-player-template --template <archive>\n'); app.exit(64); return; }
      const result = await installPlayerTemplate({ archivePath, origin: 'headless-cli' });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); app.exit(result.success ? 0 : 1);
    })();
    return;
  }
  if (process.argv.includes('--export-project')) {
    void (async () => {
      try {
        const command = await runExportCommand(parseExportCommandArguments(process.argv.slice(2)));
        process.stdout.write(command.output);
        app.exit(command.exitCode);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        app.exit(64);
      }
    })();
    return;
  }
  if (process.argv.includes('--stage-platform-export')) {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { input += chunk; });
    process.stdin.on('end', () => {
      void (async () => {
        try {
          const result = await stagePlatformExport(JSON.parse(input || '{}') as PlatformStageRequest);
          process.stdout.write(`${JSON.stringify(redactPlatformStageResult(result), null, 2)}\n`);
          app.exit(result.success ? 0 : 1);
        } catch (error) {
          process.stdout.write(`${JSON.stringify({ ok: false, success: false, diagnostics: [{ severity: 'error', code: 'invalid-request', path: '/', message: error instanceof Error ? error.message : String(error) }] }, null, 2)}\n`);
          app.exit(1);
        }
      })();
    });
    process.stdin.resume();
    return;
  }
  installApplicationMenu();

  ipcMain.handle(IPC_CHANNELS.GET_APP_INFO, () => getAppInfoPayload());

  ipcMain.handle(IPC_CHANNELS.GET_DEFAULT_PROJECT_DIRECTORY, () => getDefaultProjectDirectory());

  ipcMain.handle(IPC_CHANNELS.SELECT_DIRECTORY, async (_event: Electron.IpcMainInvokeEvent, options: { title?: string; defaultPath?: string | null } = {}) => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title ?? 'Select Directory',
      defaultPath: options.defaultPath ?? undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

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

  ipcMain.handle(IPC_CHANNELS.SELECT_PACKAGE_OUTPUT_PATH, async (_event: Electron.IpcMainInvokeEvent, defaultPath: string | null = null) => {
    if (!mainWindow) return null;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export NovelTea Package',
      defaultPath: defaultPath ?? undefined,
      filters: [
        { name: 'NovelTea Package', extensions: ['ntpkg'] },
        { name: 'Zip Package', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : (result.filePath ?? null);
  });

  ipcMain.handle(IPC_CHANNELS.SELECT_TEMPLATE_ARCHIVE_PATH, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Install NovelTea Player Template',
      properties: ['openFile'],
      filters: [
        { name: 'Template archives', extensions: ['zip', 'tar', 'gz', 'tgz', 'xz'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, (_event: Electron.IpcMainInvokeEvent, itemPath: string) => {
    if (typeof itemPath === 'string' && itemPath.length > 0) shell.showItemInFolder(itemPath);
  });

  ipcMain.handle(IPC_CHANNELS.PREVIEW_EXPORTED_PACKAGE, (_event: Electron.IpcMainInvokeEvent, packagePath: string) => ({
    ok: false,
    success: false,
    packagePath,
    diagnostics: [{ severity: 'warning', category: 'preview', path: packagePath || '/', message: 'Preview from exported package is not wired to the engine preview server yet.' }],
    error: 'Preview from exported package is not wired to the engine preview server yet.',
  }));

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

  ipcMain.handle(IPC_CHANNELS.COMPLETE_APP_WINDOW_EXIT, (event: Electron.IpcMainInvokeEvent) => {
    const window = getEventWindow(event);
    appWindowExitConfirmed = true;
    window?.close();
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
    async (_event: Electron.IpcMainInvokeEvent, projectPath: string) =>
      rememberPreviewProjectRoot(await openProject(projectPath)),
  );

  ipcMain.handle(
    IPC_CHANNELS.CREATE_PROJECT,
    async (_event: Electron.IpcMainInvokeEvent, request: CreateProjectRequest) =>
      rememberPreviewProjectRoot(await createProject(request)),
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
    IPC_CHANNELS.RUN_PLAYBACK_SPEC,
    (_event: Electron.IpcMainInvokeEvent, project: unknown, spec: unknown) =>
      runPlaybackSpec(project, spec),
  );

  ipcMain.handle(
    IPC_CHANNELS.RUN_UI_PLAYBACK_SPEC,
    (_event: Electron.IpcMainInvokeEvent, project: unknown, spec: unknown) =>
      runUiPlaybackSpec(project, spec),
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

  ipcMain.handle(IPC_CHANNELS.STAGE_PLATFORM_EXPORT, (_event: Electron.IpcMainInvokeEvent, request: PlatformStageRequest) => stagePlatformExport(request));
  ipcMain.handle(IPC_CHANNELS.EXPORT_PROJECT_TO_PLATFORM, (event: Electron.IpcMainInvokeEvent, request) => exportProjectToPlatform(
    request,
    (progress) => event.sender.send(IPC_CHANNELS.PLATFORM_EXPORT_PROGRESS_EVENT, progress),
  ));
  ipcMain.handle(IPC_CHANNELS.CANCEL_PLATFORM_EXPORT, (_event: Electron.IpcMainInvokeEvent, operationId: string) => cancelPlatformExport(operationId));
  ipcMain.handle(IPC_CHANNELS.LIST_PLAYER_TEMPLATES, (_event, query = {}) => listPlayerTemplates(query));
  ipcMain.handle(IPC_CHANNELS.INSPECT_PLAYER_TEMPLATE, (_event, templateId: string, buildId: string) => inspectPlayerTemplate(templateId, buildId));
  ipcMain.handle(IPC_CHANNELS.INSTALL_PLAYER_TEMPLATE, (_event, request) => installPlayerTemplate(request));
  ipcMain.handle(IPC_CHANNELS.REMOVE_PLAYER_TEMPLATE, (_event, templateId: string, buildId: string) => removePlayerTemplate(templateId, buildId));
  ipcMain.handle(IPC_CHANNELS.RESOLVE_PLAYER_TEMPLATE, (_event, request) => resolvePlayerTemplate(request));

  ipcMain.handle(
    IPC_CHANNELS.COMPILE_SHADERS,
    (_event: Electron.IpcMainInvokeEvent, shaderProject: unknown, options: unknown) =>
      compileShaders(shaderProject, options as ShaderCompileOptions),
  );

  ipcMain.handle(
    IPC_CHANNELS.SAVE_PROJECT,
    async (_event: Electron.IpcMainInvokeEvent, project: unknown, projectFilePath: string) =>
      rememberPreviewProjectRoot(await saveProject(project, projectFilePath)),
  );

  ipcMain.handle(
    IPC_CHANNELS.SAVE_PROJECT_AS,
    async (_event: Electron.IpcMainInvokeEvent, project: unknown, defaultPath: string | null, currentProjectFilePath: string | null) =>
      rememberPreviewProjectRoot(await saveProjectAs(mainWindow, project, defaultPath, currentProjectFilePath)),
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
    IPC_CHANNELS.AUDIT_PROJECT_ASSETS,
    (_event: Electron.IpcMainInvokeEvent, projectFilePath: string, project: unknown) =>
      auditProjectAssets(projectFilePath, project),
  );

  ipcMain.handle(
    IPC_CHANNELS.IMPORT_UNTRACKED_PROJECT_ASSETS,
    (_event: Electron.IpcMainInvokeEvent, projectFilePath: string, projectRelativePaths: string[]) =>
      importUntrackedProjectAssets(projectFilePath, projectRelativePaths),
  );

  ipcMain.handle(
    IPC_CHANNELS.TRASH_PROJECT_ASSET_FILES,
    (_event: Electron.IpcMainInvokeEvent, projectFilePath: string, projectRelativePaths: string[]) =>
      trashProjectAssetFiles(projectFilePath, projectRelativePaths),
  );

  ipcMain.handle(
    IPC_CHANNELS.RESTORE_PROJECT_ASSET_FILES,
    (_event: Electron.IpcMainInvokeEvent, projectFilePath: string, moves: Parameters<typeof restoreProjectAssetFiles>[1]) =>
      restoreProjectAssetFiles(projectFilePath, moves),
  );

  ipcMain.handle(
    IPC_CHANNELS.PURGE_PROJECT_TRASH,
    (_event: Electron.IpcMainInvokeEvent, projectFilePath: string) =>
      purgeProjectTrash(projectFilePath),
  );

  ipcMain.handle(
    IPC_CHANNELS.START_PROJECT_ASSET_WATCHER,
    (_event: Electron.IpcMainInvokeEvent, projectFilePath: string) =>
      startProjectAssetWatcher(mainWindow, projectFilePath),
  );

  ipcMain.handle(IPC_CHANNELS.STOP_PROJECT_ASSET_WATCHER, () => stopProjectAssetWatcher());

  ipcMain.handle(
    IPC_CHANNELS.RESOLVE_PROJECT_ASSET_URL,
    (_event: Electron.IpcMainInvokeEvent, projectFilePath: string, projectRelativePath: string) =>
      resolveProjectAssetUrl(projectFilePath, projectRelativePath),
  );

  ipcMain.handle(
    IPC_CHANNELS.COMFYUI_CHECK_CONNECTION,
    (_event: Electron.IpcMainInvokeEvent, config: ComfyUiConfig) =>
      checkComfyUiConnection(config),
  );

  ipcMain.handle(
    IPC_CHANNELS.COMFYUI_GET_QUEUE,
    (_event: Electron.IpcMainInvokeEvent, config: ComfyUiConfig) =>
      getComfyUiQueue(config),
  );

  ipcMain.handle(IPC_CHANNELS.COMFYUI_LIST_WORKFLOW_LIBRARY, (_event: Electron.IpcMainInvokeEvent, request: ComfyUiWorkflowLibraryListRequest = {}) =>
    listComfyUiWorkflowLibrary(request),
  );

  ipcMain.handle(IPC_CHANNELS.COMFYUI_COPY_WORKFLOW, (_event: Electron.IpcMainInvokeEvent, request: ComfyUiWorkflowCopyRequest) =>
    copyComfyUiWorkflow(request),
  );

  ipcMain.handle(IPC_CHANNELS.COMFYUI_DELETE_WORKFLOW, (_event: Electron.IpcMainInvokeEvent, request: ComfyUiWorkflowDeleteRequest) =>
    deleteComfyUiWorkflow(request),
  );

  ipcMain.handle(IPC_CHANNELS.COMFYUI_RENAME_WORKFLOW, (_event: Electron.IpcMainInvokeEvent, request: ComfyUiWorkflowRenameRequest) =>
    renameComfyUiWorkflow(request),
  );

  ipcMain.handle(IPC_CHANNELS.COMFYUI_IMPORT_WORKFLOW_TO_LIBRARY, (_event: Electron.IpcMainInvokeEvent, request: ComfyUiImportWorkflowToLibraryRequest) =>
    importComfyUiWorkflowToLibrary(request),
  );

  ipcMain.handle(IPC_CHANNELS.COMFYUI_REPAIR_WORKFLOW_IN_LIBRARY, (_event: Electron.IpcMainInvokeEvent, request: ComfyUiRepairWorkflowInLibraryRequest) =>
    repairComfyUiWorkflowInLibrary(request),
  );

  ipcMain.handle(IPC_CHANNELS.COMFYUI_REVEAL_WORKFLOW, (_event: Electron.IpcMainInvokeEvent, workflowKey: ComfyUiWorkflowKey, projectFilePath?: string | null) =>
    revealComfyUiWorkflow(workflowKey, projectFilePath),
  );

  ipcMain.handle(IPC_CHANNELS.COMFYUI_VERIFY_WORKFLOW_LIBRARY, (_event: Electron.IpcMainInvokeEvent, request: ComfyUiVerifyWorkflowLibraryRequest) =>
    verifyComfyUiWorkflowLibrary(request),
  );

  ipcMain.handle(IPC_CHANNELS.COMFYUI_ANALYZE_WORKFLOW_IMPORT, (_event: Electron.IpcMainInvokeEvent, request: ComfyUiAnalyzeWorkflowImportRequest) =>
    analyzeComfyUiWorkflowImport(request),
  );

  ipcMain.handle(
    IPC_CHANNELS.COMFYUI_GENERATE_IMAGE,
    (_event: Electron.IpcMainInvokeEvent, config: ComfyUiConfig, request: ComfyUiGenerateImageRequest) =>
      generateComfyUiImage(mainWindow, config, request),
  );

  ipcMain.handle(
    IPC_CHANNELS.COMFYUI_EDIT_IMAGE,
    (_event: Electron.IpcMainInvokeEvent, config: ComfyUiConfig, request: ComfyUiEditImageRequest) =>
      editComfyUiImage(mainWindow, config, request),
  );

  ipcMain.handle(
    IPC_CHANNELS.COMFYUI_CANCEL_JOB,
    (_event: Electron.IpcMainInvokeEvent, config: ComfyUiConfig) =>
      cancelComfyUiJob(config),
  );

  const window = createWindow();
  if (process.argv.includes(PACKAGE_SMOKE_FLAG)) {
    void runPackageSmoke(window, enginePreviewServer).then((result) => {
      process.stdout.write(`${PACKAGE_SMOKE_PREFIX}${JSON.stringify(result)}\n`);
      app.exit(result.success ? 0 : 1);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  void stopProjectAssetWatcher();
  void enginePreviewServer.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
