import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  Menu,
  screen,
  protocol,
  session,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC_CHANNELS } from './shared/ipc-channels';
import { NOVELTEA_VERSION } from './shared/product-version';
import { EnginePreviewServer } from './main/engine-preview-server';
import {
  PACKAGE_SMOKE_FLAG,
  PACKAGE_SMOKE_PREFIX,
  runPackageSmoke,
  THUMBNAIL_PROTOCOL_CHARACTERIZATION_SCHEME,
} from './main/package-smoke';
import { importAssets, reimportAsset } from './main/services/asset-import-service';
import { configureSharpPlatformImageService } from './main/services/platform-image-sharp-service';
import {
  cancelComfyUiJob,
  checkComfyUiConnection,
  editComfyUiImage,
  generateComfyUiImage,
  getComfyUiQueue,
} from './main/services/comfyui-service';
import {
  copyComfyUiWorkflow,
  deleteComfyUiWorkflow,
  importComfyUiWorkflowToLibrary,
  listComfyUiWorkflowLibrary,
  repairComfyUiWorkflowInLibrary,
  renameComfyUiWorkflow,
  revealComfyUiWorkflow,
  verifyComfyUiWorkflowLibrary,
} from './main/services/comfyui-workflow-library-service';
import { analyzeComfyUiWorkflowImport } from './main/services/comfyui-workflow-import-service';
import {
  loadComfyUiUserConfig,
  saveComfyUiUserConfig,
} from './main/services/comfyui-user-config-service';
import {
  auditProjectAssets,
  importUntrackedProjectAssets,
  purgeProjectTrash,
  restoreProjectAssetFiles,
  trashProjectAssetFiles,
} from './main/services/project-asset-audit-service';
import {
  startProjectWorkspaceWatcher,
  stopProjectWorkspaceWatcher,
} from './main/services/project-workspace-watcher-service';
import {
  createProjectOriginalAssetProtocolHandler,
  PROJECT_ORIGINAL_ASSET_SCHEME,
  resolveProjectOriginalAssetUrl,
} from './main/services/project-original-asset-service';
import { ActiveProjectSessionService } from './main/services/active-project-session-service';
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
import {
  createProject,
  saveProjectContent,
  saveProjectCopyAs,
  saveProjectEditorMetadata,
} from './main/services/project-file-service';
import {
  cancelPlatformExport,
  stagePlatformExport,
} from './main/services/platform-staging-service';
import {
  configureTemplateRegistryRoot,
  inspectPlayerTemplate,
  installPlayerTemplate,
  listPlayerTemplates,
  removePlayerTemplate,
  resolvePlayerTemplate,
} from './main/services/template-registry-service';
import { exportProjectToPlatform } from './main/services/platform-export-orchestration-service';
import { downloadPlayerTemplateForRelease } from './main/services/template-download-service';
import {
  loadUserExportConfig,
  saveUserExportConfig,
} from './main/services/user-export-config-service';
import {
  loadNovelTeaUserPreferences,
  saveNovelTeaUserPreferences,
} from './main/services/user-config-service';
import type { CreateProjectRequest } from './shared/editor-tooling';
import type { ReadProjectTextSourcesRequest } from './shared/project-text-sources';
import { resolveEditorShortcutCommand } from './shared/editor-shortcuts';
import {
  createImageThumbnailProtocolHandler,
  IMAGE_THUMBNAIL_SCHEME,
} from './main/image-thumbnail-protocol';
import { ImageThumbnailService } from './main/services/image-thumbnail-service';
import {
  isStrictlyContainedPath,
  resolveEditorCacheRoot,
  resolveSystemCachePath,
} from './main/services/image-thumbnail-cache-paths';
import {
  auditProjectAssetsArgumentsSchema,
  cancelImageThumbnailPrewarmArgumentsSchema,
  cancelPlatformExportArgumentsSchema,
  comfyUiAnalyzeWorkflowArgumentsSchema,
  comfyUiCancelJobArgumentsSchema,
  comfyUiConfigArgumentsSchema,
  comfyUiCopyWorkflowArgumentsSchema,
  comfyUiUserConfigArgumentsSchema,
  comfyUiDeleteWorkflowArgumentsSchema,
  comfyUiEditImageArgumentsSchema,
  comfyUiGenerateImageArgumentsSchema,
  comfyUiImportWorkflowArgumentsSchema,
  comfyUiListWorkflowLibraryArgumentsSchema,
  comfyUiRenameWorkflowArgumentsSchema,
  comfyUiRepairWorkflowArgumentsSchema,
  comfyUiRevealWorkflowArgumentsSchema,
  comfyUiVerifyWorkflowArgumentsSchema,
  compileShadersArgumentsSchema,
  createEditorDocumentPolicy,
  createGuardedIpcRegistrar,
  createProjectArgumentsSchema,
  downloadPlayerTemplateArgumentsSchema,
  exportPackageArgumentsSchema,
  exportProjectToPlatformArgumentsSchema,
  imageThumbnailArgumentsSchema,
  imageThumbnailPrewarmArgumentsSchema,
  importAssetsArgumentsSchema,
  inspectPlayerTemplateArgumentsSchema,
  installPlayerTemplateArgumentsSchema,
  listPlaybackTestsArgumentsSchema,
  listPlayerTemplatesArgumentsSchema,
  installEditorNavigationPolicy,
  noArgumentsSchema,
  openExternalArgumentsSchema,
  openProjectArgumentsSchema,
  previewExportedPackageArgumentsSchema,
  previewSessionArgumentsSchema,
  projectAssetPathsArgumentsSchema,
  projectAssetUrlArgumentsSchema,
  projectSessionArgumentsSchema,
  readProjectTextSourcesArgumentsSchema,
  reimportAssetArgumentsSchema,
  removePlayerTemplateArgumentsSchema,
  resolvePlayerTemplateArgumentsSchema,
  runPlaybackSpecArgumentsSchema,
  runPlaybackTestArgumentsSchema,
  saveProjectContentArgumentsSchema,
  saveProjectCopyAsArgumentsSchema,
  saveProjectEditorMetadataArgumentsSchema,
  restoreProjectAssetFilesArgumentsSchema,
  saveUserExportConfigArgumentsSchema,
  saveUserPreferencesArgumentsSchema,
  selectDirectoryArgumentsSchema,
  stagePlatformExportArgumentsSchema,
  selectPackageOutputPathArgumentsSchema,
  setNativeWindowFrameArgumentsSchema,
  showItemInFolderArgumentsSchema,
  validateProjectArgumentsSchema,
} from './main/editor-ipc-trust-boundary';

configureSharpPlatformImageService();

const USER_DATA_DIRECTORY_NAME = 'noveltea-editor';

function configureApplicationPaths() {
  const appDataRoot = app.getPath('appData');
  const userDataPath = path.join(appDataRoot, USER_DATA_DIRECTORY_NAME);
  app.setPath('userData', userDataPath);
}

configureApplicationPaths();

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
  {
    scheme: IMAGE_THUMBNAIL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: PROJECT_ORIGINAL_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
  ...(process.argv.includes(PACKAGE_SMOKE_FLAG)
    ? [
        {
          scheme: THUMBNAIL_PROTOCOL_CHARACTERIZATION_SCHEME,
          privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
          },
        },
      ]
    : []),
]);

// WSL2 and some remote/Linux GPU stacks blocklist WebGL in Electron even when
// the browser can render the same page. The engine preview is a local dev-only
// iframe, so allow Chromium to use SwiftShader or an unblocked GL path.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

let mainWindow: BrowserWindow | null = null;
const enginePreviewServer = new EnginePreviewServer();
const packageSmokeCacheRoot = process.argv.includes(PACKAGE_SMOKE_FLAG)
  ? process.env.NOVELTEA_EDITOR_PACKAGE_SMOKE_CACHE_ROOT?.trim()
  : undefined;
const activeProjectSessions = new ActiveProjectSessionService();
const imageThumbnailService = new ImageThumbnailService(
  packageSmokeCacheRoot
    ? path.resolve(packageSmokeCacheRoot)
    : resolveEditorCacheRoot(resolveSystemCachePath(app.getPath('home'))),
  {
    resolveProjectAsset: (source) => {
      const { root, asset } = activeProjectSessions.requireActiveAsset(
        source.projectSessionId,
        source.assetId,
      );
      return {
        root,
        kind: asset.kind,
        sourcePath: asset.sourcePath,
        contentHash: asset.contentHash,
      };
    },
  },
);
imageThumbnailService.cache.onEpochChanged((cacheEpoch) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.EDITOR_CACHE_EPOCH_EVENT, { cacheEpoch });
    }
  }
});

const DEV_SERVER_URL = process.env.NOVELTEA_EDITOR_DEV_SERVER_URL?.trim() || undefined;
const isDev = !!DEV_SERVER_URL;
const editorDocumentPolicy = createEditorDocumentPolicy(DEV_SERVER_URL);
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
  const rendererRoot = path.resolve(__dirname, '../renderer');
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
          'Content-Type':
            EDITOR_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
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

function resolvePreloadPath() {
  return path.resolve(__dirname, '../preload/preload.cjs');
}

function installLocalDocumentIsolationHeaders() {
  // Keep local top-level and iframe documents isolated even if a development
  // proxy or intermediary strips Vite's configured COOP/COEP headers.
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://127.0.0.1:*/*', 'http://localhost:*/*'] },
    (details, callback) => {
      if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const responseHeaders = { ...details.responseHeaders };
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

function rememberPreviewProjectRoot<
  Result extends { projectFilePath?: string; success?: boolean; ok?: boolean } | null | undefined,
>(result: Result): Result {
  if (result && result.success !== false && result.ok !== false && result.projectFilePath) {
    enginePreviewServer.setProjectFilePath(result.projectFilePath);
  }
  return result;
}

function requireProjectContainedPath(projectRoot: string, candidate: string, label: string): void {
  const resolved = path.resolve(candidate);
  if (!isStrictlyContainedPath(projectRoot, resolved)) {
    throw new Error(`${label} must stay within the active Project.`);
  }
}

function assertPackageProjectAuthority(
  projectRoot: string,
  options: {
    shaderAssetRoot?: string;
    assetRoots?: Array<{ root: string }>;
    fileEntries?: Array<{ source: string }>;
  },
): void {
  if (options.shaderAssetRoot)
    requireProjectContainedPath(projectRoot, options.shaderAssetRoot, 'Shader asset root');
  for (const assetRoot of options.assetRoots ?? [])
    requireProjectContainedPath(projectRoot, assetRoot.root, 'Asset root');
  for (const entry of options.fileEntries ?? [])
    requireProjectContainedPath(projectRoot, entry.source, 'Package file source');
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
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  )
    return null;
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
    version: NOVELTEA_VERSION,
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
      preload: resolvePreloadPath(),
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
  const sessionOwner = mainWindow;
  mainWindow.on('closed', () => {
    activeProjectSessions.dispose();
    if (mainWindow === sessionOwner) mainWindow = null;
  });

  const navigationOwner = mainWindow;
  installEditorNavigationPolicy(
    {
      onWillNavigate: (listener) => {
        navigationOwner.webContents.on('will-navigate', listener);
      },
      onWillRedirect: (listener) => {
        navigationOwner.webContents.on('will-redirect', listener);
      },
      setWindowOpenHandler: (handler) => {
        navigationOwner.webContents.setWindowOpenHandler(handler);
      },
    },
    editorDocumentPolicy,
  );
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
    void mainWindow.loadURL(DEV_SERVER_URL!);
  } else {
    void mainWindow.loadURL(`${EDITOR_SCHEME}://app/index.html`);
  }

  return mainWindow;
}

void app.whenReady().then(async () => {
  await imageThumbnailService.removeObsoleteCacheVersions();
  protocol.handle(
    IMAGE_THUMBNAIL_SCHEME,
    createImageThumbnailProtocolHandler(imageThumbnailService.imageCacheRoot),
  );
  protocol.handle(
    PROJECT_ORIGINAL_ASSET_SCHEME,
    createProjectOriginalAssetProtocolHandler(activeProjectSessions),
  );
  if (isDev) installLocalDocumentIsolationHeaders();
  if (!isDev) registerPackagedEditorProtocol();
  configureTemplateRegistryRoot(
    process.env.NOVELTEA_TEMPLATE_REGISTRY_ROOT ??
      path.join(app.getPath('home'), '.noveltea', 'templates'),
  );
  installApplicationMenu();

  const guardedIpc = createGuardedIpcRegistrar({
    ipcMain: {
      handle: (channel, handler) => {
        ipcMain.handle(channel, (event, ...arguments_) => handler(event, ...arguments_));
      },
    },
    getOwner: () => mainWindow,
    documentPolicy: editorDocumentPolicy,
  });

  guardedIpc.handle(
    IPC_CHANNELS.GET_APP_INFO,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => getAppInfoPayload(),
  );

  guardedIpc.handle(
    IPC_CHANNELS.GET_DEFAULT_PROJECT_DIRECTORY,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => getDefaultProjectDirectory(),
  );

  guardedIpc.handle(
    IPC_CHANNELS.LOAD_USER_EXPORT_CONFIG,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => loadUserExportConfig(),
  );

  guardedIpc.handle(
    IPC_CHANNELS.SAVE_USER_EXPORT_CONFIG,
    (arguments_) => saveUserExportConfigArgumentsSchema.parse(arguments_),
    (config) => saveUserExportConfig(config),
  );

  guardedIpc.handle(
    IPC_CHANNELS.LOAD_USER_PREFERENCES,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => loadNovelTeaUserPreferences(),
  );

  guardedIpc.handle(
    IPC_CHANNELS.SAVE_USER_PREFERENCES,
    (arguments_) => saveUserPreferencesArgumentsSchema.parse(arguments_),
    (preferences) => saveNovelTeaUserPreferences(preferences),
  );

  guardedIpc.handle(
    IPC_CHANNELS.SELECT_DIRECTORY,
    (arguments_) => selectDirectoryArgumentsSchema.parse(arguments_),
    async (options) => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: options.title ?? 'Select Directory',
        defaultPath: options.defaultPath ?? undefined,
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.SELECT_PROJECT_DIRECTORY,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    async () => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Open NovelTea Project',
        properties: ['openDirectory'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.SELECT_PACKAGE_OUTPUT_PATH,
    (arguments_) => selectPackageOutputPathArgumentsSchema.parse(arguments_),
    async (defaultPath: string | null) => {
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
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.SELECT_TEMPLATE_ARCHIVE_PATH,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    async () => {
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
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.SHOW_ITEM_IN_FOLDER,
    (arguments_) => showItemInFolderArgumentsSchema.parse(arguments_),
    (itemPath: string) => shell.showItemInFolder(itemPath),
  );

  guardedIpc.handle(
    IPC_CHANNELS.PREVIEW_EXPORTED_PACKAGE,
    (arguments_) => previewExportedPackageArgumentsSchema.parse(arguments_),
    (projectSessionId, packagePath) => {
      activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      return {
        ok: false,
        success: false,
        packagePath,
        diagnostics: [
          {
            severity: 'warning' as const,
            category: 'preview',
            path: packagePath,
            message: 'Preview from exported package is not wired to the engine preview server yet.',
          },
        ],
        error: 'Preview from exported package is not wired to the engine preview server yet.',
      };
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.OPEN_EXTERNAL,
    (arguments_) => openExternalArgumentsSchema.parse(arguments_),
    async (url: string) => shell.openExternal(url),
  );

  guardedIpc.handle(
    IPC_CHANNELS.ZOOM_IN,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () =>
      mainWindow
        ? setWindowZoom(mainWindow, mainWindow.webContents.getZoomFactor() + ZOOM_STEP)
        : 1,
  );

  guardedIpc.handle(
    IPC_CHANNELS.ZOOM_OUT,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () =>
      mainWindow
        ? setWindowZoom(mainWindow, mainWindow.webContents.getZoomFactor() - ZOOM_STEP)
        : 1,
  );

  guardedIpc.handle(
    IPC_CHANNELS.RESET_ZOOM,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => (mainWindow ? setWindowZoom(mainWindow, 1) : 1),
  );

  guardedIpc.handle(
    IPC_CHANNELS.MINIMIZE_APP_WINDOW,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => mainWindow?.minimize(),
  );

  guardedIpc.handle(
    IPC_CHANNELS.TOGGLE_MAXIMIZE_APP_WINDOW,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => {
      const window = mainWindow;
      if (!window) return false;
      if (window.isMaximized()) {
        window.unmaximize();
      } else {
        window.maximize();
      }
      return window.isMaximized();
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.REQUEST_APP_WINDOW_EXIT,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => mainWindow?.close(),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMPLETE_APP_WINDOW_EXIT,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => {
      appWindowExitConfirmed = true;
      mainWindow?.close();
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.IS_APP_WINDOW_MAXIMIZED,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => mainWindow?.isMaximized() ?? false,
  );

  guardedIpc.handle(
    IPC_CHANNELS.SET_NATIVE_WINDOW_FRAME,
    (arguments_) => setNativeWindowFrameArgumentsSchema.parse(arguments_),
    (nativeFrame: boolean) => {
      writeNativeWindowFrameSetting(nativeFrame);
      currentNativeWindowFrame = nativeFrame;
      currentFramelessWindow = !nativeFrame;
      return getAppInfoPayload();
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.GET_ENGINE_PREVIEW_SESSION,
    (arguments_) => previewSessionArgumentsSchema.parse(arguments_),
    (projectSessionId) => {
      const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      enginePreviewServer.setProjectFilePath(path.join(projectRoot, 'project.json'));
      return enginePreviewServer.getSession();
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.RELOAD_ENGINE_PREVIEW,
    (arguments_) => previewSessionArgumentsSchema.parse(arguments_),
    (projectSessionId) => {
      const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      enginePreviewServer.setProjectFilePath(path.join(projectRoot, 'project.json'));
      return enginePreviewServer.reload();
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.OPEN_PROJECT,
    (arguments_) => openProjectArgumentsSchema.parse(arguments_),
    async (projectPath: string) => {
      const activationGeneration = activeProjectSessions.beginProjectActivation();
      const result = await activeProjectSessions.attachToSuccessfulResult(
        await openProject(projectPath),
        activationGeneration,
      );
      return rememberPreviewProjectRoot(result);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.CREATE_PROJECT,
    (arguments_) => createProjectArgumentsSchema.parse(arguments_),
    async (request: CreateProjectRequest) => {
      const activationGeneration = activeProjectSessions.beginProjectActivation();
      const result = await activeProjectSessions.attachToSuccessfulResult(
        await createProject(request),
        activationGeneration,
      );
      return rememberPreviewProjectRoot(result);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.CLOSE_ACTIVE_PROJECT,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    async () => {
      await stopProjectWorkspaceWatcher();
      activeProjectSessions.closeActiveProject();
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.VALIDATE_PROJECT,
    (arguments_) => validateProjectArgumentsSchema.parse(arguments_),
    (project) => validateProject(project),
  );

  guardedIpc.handle(
    IPC_CHANNELS.LIST_PLAYBACK_TESTS,
    (arguments_) => listPlaybackTestsArgumentsSchema.parse(arguments_),
    (project) => listPlaybackTests(project),
  );

  guardedIpc.handle(
    IPC_CHANNELS.RUN_PLAYBACK_TEST,
    (arguments_) => runPlaybackTestArgumentsSchema.parse(arguments_),
    (project, testId) => runPlaybackTest(project, testId),
  );

  guardedIpc.handle(
    IPC_CHANNELS.RUN_PLAYBACK_SPEC,
    (arguments_) => runPlaybackSpecArgumentsSchema.parse(arguments_),
    (project, spec) => runPlaybackSpec(project, spec),
  );

  guardedIpc.handle(
    IPC_CHANNELS.RUN_UI_PLAYBACK_SPEC,
    (arguments_) => runPlaybackSpecArgumentsSchema.parse(arguments_),
    (project, spec) => runUiPlaybackSpec(project, spec),
  );

  guardedIpc.handle(
    IPC_CHANNELS.EXPORT_PACKAGE,
    (arguments_) => exportPackageArgumentsSchema.parse(arguments_),
    (projectSessionId, project, outputPath, options) => {
      const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      assertPackageProjectAuthority(projectRoot, options);
      return exportPackage(project, outputPath, options);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.STAGE_PLATFORM_EXPORT,
    (arguments_) => stagePlatformExportArgumentsSchema.parse(arguments_),
    (projectSessionId, request) => {
      const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      requireProjectContainedPath(projectRoot, request.packagePath, 'Runtime package source');
      if (request.iconSourcePath)
        requireProjectContainedPath(projectRoot, request.iconSourcePath, 'Platform icon source');
      if (request.systemAssetsRoot)
        requireProjectContainedPath(projectRoot, request.systemAssetsRoot, 'System assets root');
      return stagePlatformExport(request);
    },
  );
  guardedIpc.handle(
    IPC_CHANNELS.EXPORT_PROJECT_TO_PLATFORM,
    (arguments_) => exportProjectToPlatformArgumentsSchema.parse(arguments_),
    (projectSessionId, request) => {
      const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      if (request.preparedRuntimeArtifact)
        assertPackageProjectAuthority(projectRoot, request.preparedRuntimeArtifact.packageOptions);
      return exportProjectToPlatform(
        {
          ...request,
          projectPath: path.join(projectRoot, 'project.json'),
          projectRoot,
        },
        (progress) =>
          mainWindow?.webContents.send(IPC_CHANNELS.PLATFORM_EXPORT_PROGRESS_EVENT, progress),
      );
    },
  );
  guardedIpc.handle(
    IPC_CHANNELS.CANCEL_PLATFORM_EXPORT,
    (arguments_) => cancelPlatformExportArgumentsSchema.parse(arguments_),
    (projectSessionId, operationId) => {
      activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      return cancelPlatformExport(operationId);
    },
  );
  guardedIpc.handle(
    IPC_CHANNELS.LIST_PLAYER_TEMPLATES,
    (arguments_) => listPlayerTemplatesArgumentsSchema.parse(arguments_),
    (query) => listPlayerTemplates(query),
  );
  guardedIpc.handle(
    IPC_CHANNELS.INSPECT_PLAYER_TEMPLATE,
    (arguments_) => inspectPlayerTemplateArgumentsSchema.parse(arguments_),
    (templateId, buildId) => inspectPlayerTemplate(templateId, buildId),
  );
  guardedIpc.handle(
    IPC_CHANNELS.INSTALL_PLAYER_TEMPLATE,
    (arguments_) => installPlayerTemplateArgumentsSchema.parse(arguments_),
    (request) => installPlayerTemplate(request),
  );
  guardedIpc.handle(
    IPC_CHANNELS.DOWNLOAD_PLAYER_TEMPLATE,
    (arguments_) => downloadPlayerTemplateArgumentsSchema.parse(arguments_),
    (request) => downloadPlayerTemplateForRelease(`v${NOVELTEA_VERSION}`, request),
  );
  guardedIpc.handle(
    IPC_CHANNELS.REMOVE_PLAYER_TEMPLATE,
    (arguments_) => removePlayerTemplateArgumentsSchema.parse(arguments_),
    (templateId, buildId) => removePlayerTemplate(templateId, buildId),
  );
  guardedIpc.handle(
    IPC_CHANNELS.RESOLVE_PLAYER_TEMPLATE,
    (arguments_) => resolvePlayerTemplateArgumentsSchema.parse(arguments_),
    (request) => resolvePlayerTemplate(request),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMPILE_SHADERS,
    (arguments_) => compileShadersArgumentsSchema.parse(arguments_),
    (projectSessionId, shaderProject, options) => {
      const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      return compileShaders(shaderProject, {
        ...options,
        projectRoot,
        outputRoot: path.join(projectRoot, '.noveltea', 'build'),
        cacheRoot: path.join(projectRoot, '.noveltea', 'cache'),
      });
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.SAVE_PROJECT_CONTENT,
    (arguments_) => saveProjectContentArgumentsSchema.parse(arguments_),
    async (
      projectSessionId,
      expectedWorkspaceRevision,
      contentProject,
      editorState,
      scriptSourcePaths,
      commitOptions,
    ) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        const result = await saveProjectContent(
          projectRoot,
          expectedWorkspaceRevision,
          contentProject,
          editorState,
          scriptSourcePaths,
          commitOptions,
          () => activeProjectSessions.requireActiveProjectRoot(projectSessionId),
        );
        const refreshed = await activeProjectSessions.refreshSuccessfulSessionResult(
          projectSessionId,
          result,
        );
        return rememberPreviewProjectRoot(refreshed);
      } catch (error) {
        return {
          ok: false,
          success: false,
          diagnostics: [],
          error: error instanceof Error ? error.message : 'Project session is stale or unknown.',
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.SAVE_PROJECT_EDITOR_METADATA,
    (arguments_) => saveProjectEditorMetadataArgumentsSchema.parse(arguments_),
    async (projectSessionId, expectedWorkspaceRevision, editorState, expectedFileRevisions) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        const result = await saveProjectEditorMetadata(
          projectRoot,
          expectedWorkspaceRevision,
          editorState,
          expectedFileRevisions,
          () => activeProjectSessions.requireActiveProjectRoot(projectSessionId),
        );
        if (result.success) {
          await activeProjectSessions.refreshActiveProject(
            projectSessionId,
            path.join(projectRoot, 'project.json'),
          );
        }
        return result;
      } catch (error) {
        return {
          ok: false,
          success: false,
          diagnostics: [],
          error: error instanceof Error ? error.message : 'Project session is stale or unknown.',
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.SAVE_PROJECT_COPY_AS,
    (arguments_) => saveProjectCopyAsArgumentsSchema.parse(arguments_),
    async (projectSessionId, project, workingProjectAssetPaths, scriptSourcePaths) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        return await saveProjectCopyAs(
          mainWindow,
          projectRoot,
          project,
          workingProjectAssetPaths,
          scriptSourcePaths,
          () => activeProjectSessions.requireActiveProjectRoot(projectSessionId),
        );
      } catch (error) {
        return {
          ok: false,
          success: false,
          diagnostics: [],
          error: error instanceof Error ? error.message : 'Project session is stale or unknown.',
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.IMPORT_ASSETS,
    (arguments_) => importAssetsArgumentsSchema.parse(arguments_),
    async (projectSessionId, options) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        return await importAssets(mainWindow, path.join(projectRoot, 'project.json'), options, () =>
          activeProjectSessions.requireActiveProjectRoot(projectSessionId),
        );
      } catch (error) {
        return {
          ok: false,
          success: false,
          assets: [],
          diagnostics: [],
          error: error instanceof Error ? error.message : 'Project session is stale or unknown.',
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.REIMPORT_ASSET,
    (arguments_) => reimportAssetArgumentsSchema.parse(arguments_),
    async (projectSessionId, projectRelativePath) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        return await reimportAsset(
          mainWindow,
          path.join(projectRoot, 'project.json'),
          projectRelativePath,
          () => activeProjectSessions.requireActiveProjectRoot(projectSessionId),
        );
      } catch (error) {
        return {
          ok: false,
          success: false,
          diagnostics: [],
          error: error instanceof Error ? error.message : 'Project session is stale or unknown.',
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.AUDIT_PROJECT_ASSETS,
    (arguments_) => auditProjectAssetsArgumentsSchema.parse(arguments_),
    async (projectSessionId, project) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        return await auditProjectAssets(path.join(projectRoot, 'project.json'), project, () =>
          activeProjectSessions.requireActiveProjectRoot(projectSessionId),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Project session is stale or unknown.';
        return {
          ok: false,
          success: false,
          untrackedFiles: [],
          skippedUnstableFiles: [],
          diagnostics: [{ severity: 'error' as const, path: '/assets', message }],
          error: message,
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.IMPORT_UNTRACKED_PROJECT_ASSETS,
    (arguments_) => projectAssetPathsArgumentsSchema.parse(arguments_),
    async (projectSessionId, projectRelativePaths) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        return await importUntrackedProjectAssets(
          path.join(projectRoot, 'project.json'),
          projectRelativePaths,
          () => activeProjectSessions.requireActiveProjectRoot(projectSessionId),
        );
      } catch (error) {
        return {
          ok: false,
          success: false,
          diagnostics: [],
          error: error instanceof Error ? error.message : 'Project session is stale or unknown.',
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.TRASH_PROJECT_ASSET_FILES,
    (arguments_) => projectAssetPathsArgumentsSchema.parse(arguments_),
    async (projectSessionId, projectRelativePaths) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        return await trashProjectAssetFiles(
          path.join(projectRoot, 'project.json'),
          projectRelativePaths,
          () => activeProjectSessions.requireActiveProjectRoot(projectSessionId),
        );
      } catch (error) {
        return {
          ok: false,
          success: false,
          diagnostics: [],
          error: error instanceof Error ? error.message : 'Project session is stale or unknown.',
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.RESTORE_PROJECT_ASSET_FILES,
    (arguments_) => restoreProjectAssetFilesArgumentsSchema.parse(arguments_),
    async (projectSessionId, moves) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        return await restoreProjectAssetFiles(path.join(projectRoot, 'project.json'), moves, () =>
          activeProjectSessions.requireActiveProjectRoot(projectSessionId),
        );
      } catch (error) {
        return {
          ok: false,
          success: false,
          diagnostics: [],
          error: error instanceof Error ? error.message : 'Project session is stale or unknown.',
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.PURGE_PROJECT_TRASH,
    (arguments_) => projectSessionArgumentsSchema.parse(arguments_),
    async (projectSessionId) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        return await purgeProjectTrash(path.join(projectRoot, 'project.json'), () =>
          activeProjectSessions.requireActiveProjectRoot(projectSessionId),
        );
      } catch (error) {
        return {
          ok: false,
          success: false,
          diagnostics: [],
          error: error instanceof Error ? error.message : 'Project session is stale or unknown.',
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.START_PROJECT_WORKSPACE_WATCHER,
    (arguments_) => projectSessionArgumentsSchema.parse(arguments_),
    (projectSessionId) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        return startProjectWorkspaceWatcher(
          mainWindow,
          projectSessionId,
          projectRoot,
          (sessionId) => activeProjectSessions.isCurrent(sessionId),
          async (sessionId, projectFilePath, project) => {
            await activeProjectSessions.refreshActiveProject(sessionId, projectFilePath, project);
          },
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Project session is stale or unknown.';
        return {
          ok: false,
          success: false,
          diagnostics: [{ severity: 'error' as const, path: '/project.json', message }],
          error: message,
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.STOP_PROJECT_WORKSPACE_WATCHER,
    (arguments_) => projectSessionArgumentsSchema.parse(arguments_),
    (projectSessionId) => {
      try {
        activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        return stopProjectWorkspaceWatcher(projectSessionId);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Project session is stale or unknown.';
        return {
          ok: false,
          success: false,
          diagnostics: [{ severity: 'error' as const, path: '/project.json', message }],
          error: message,
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.RESOLVE_PROJECT_ORIGINAL_ASSET_URL,
    (arguments_) => projectAssetUrlArgumentsSchema.parse(arguments_),
    (projectSessionId, assetId) =>
      resolveProjectOriginalAssetUrl(activeProjectSessions, projectSessionId, assetId),
  );

  guardedIpc.handle(
    IPC_CHANNELS.REQUEST_IMAGE_THUMBNAIL,
    (arguments_) => imageThumbnailArgumentsSchema.parse(arguments_),
    (request) => imageThumbnailService.request(request, 'interactive'),
  );

  guardedIpc.handle(
    IPC_CHANNELS.PREWARM_IMAGE_THUMBNAILS,
    (arguments_) => imageThumbnailPrewarmArgumentsSchema.parse(arguments_),
    (request) => imageThumbnailService.prewarm(request),
  );

  guardedIpc.handle(
    IPC_CHANNELS.CANCEL_IMAGE_THUMBNAIL_PREWARM,
    (arguments_) => cancelImageThumbnailPrewarmArgumentsSchema.parse(arguments_),
    (request) => imageThumbnailService.cancelPrewarm(request),
  );

  guardedIpc.handle(
    IPC_CHANNELS.CLEAR_EDITOR_CACHE,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => imageThumbnailService.clearEditorCache(),
  );

  guardedIpc.handle(
    IPC_CHANNELS.READ_PROJECT_TEXT_SOURCES,
    (arguments_) => readProjectTextSourcesArgumentsSchema.parse(arguments_),
    (request: ReadProjectTextSourcesRequest) => activeProjectSessions.read(request),
  );

  const comfyUiProjectFilePath = (projectSessionId: string | null) =>
    projectSessionId
      ? path.join(activeProjectSessions.requireActiveProjectRoot(projectSessionId), 'project.json')
      : undefined;
  const requireComfyUiProjectFilePath = (projectSessionId: string | null) => {
    if (!projectSessionId)
      throw new Error('ComfyUI Project operation requires an active Project session.');
    return comfyUiProjectFilePath(projectSessionId)!;
  };

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_LOAD_USER_CONFIG,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => loadComfyUiUserConfig(),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_SAVE_USER_CONFIG,
    (arguments_) => comfyUiUserConfigArgumentsSchema.parse(arguments_),
    (config) => saveComfyUiUserConfig(config),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_CHECK_CONNECTION,
    (arguments_) => comfyUiConfigArgumentsSchema.parse(arguments_),
    (config) => checkComfyUiConnection(config),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_GET_QUEUE,
    (arguments_) => comfyUiConfigArgumentsSchema.parse(arguments_),
    (config) => getComfyUiQueue(config),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_LIST_WORKFLOW_LIBRARY,
    (arguments_) => comfyUiListWorkflowLibraryArgumentsSchema.parse(arguments_),
    (projectSessionId, request) =>
      listComfyUiWorkflowLibrary({
        ...request,
        projectFilePath: comfyUiProjectFilePath(projectSessionId),
      }),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_COPY_WORKFLOW,
    (arguments_) => comfyUiCopyWorkflowArgumentsSchema.parse(arguments_),
    (projectSessionId, request) => {
      const requiresProject =
        request.targetSource === 'project' || request.workflowKey.startsWith('project:');
      return copyComfyUiWorkflow({
        ...request,
        projectFilePath: requiresProject
          ? requireComfyUiProjectFilePath(projectSessionId)
          : comfyUiProjectFilePath(projectSessionId),
      });
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_DELETE_WORKFLOW,
    (arguments_) => comfyUiDeleteWorkflowArgumentsSchema.parse(arguments_),
    (projectSessionId, request) =>
      deleteComfyUiWorkflow({
        ...request,
        projectFilePath: request.workflowKey.startsWith('project:')
          ? requireComfyUiProjectFilePath(projectSessionId)
          : comfyUiProjectFilePath(projectSessionId),
      }),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_RENAME_WORKFLOW,
    (arguments_) => comfyUiRenameWorkflowArgumentsSchema.parse(arguments_),
    (projectSessionId, request) =>
      renameComfyUiWorkflow({
        ...request,
        projectFilePath: request.workflowKey.startsWith('project:')
          ? requireComfyUiProjectFilePath(projectSessionId)
          : comfyUiProjectFilePath(projectSessionId),
      }),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_IMPORT_WORKFLOW_TO_LIBRARY,
    (arguments_) => comfyUiImportWorkflowArgumentsSchema.parse(arguments_),
    (request) => importComfyUiWorkflowToLibrary(request),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_REPAIR_WORKFLOW_IN_LIBRARY,
    (arguments_) => comfyUiRepairWorkflowArgumentsSchema.parse(arguments_),
    (projectSessionId, request) =>
      repairComfyUiWorkflowInLibrary({
        ...request,
        projectFilePath: request.workflowKey.startsWith('project:')
          ? requireComfyUiProjectFilePath(projectSessionId)
          : comfyUiProjectFilePath(projectSessionId),
      }),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_REVEAL_WORKFLOW,
    (arguments_) => comfyUiRevealWorkflowArgumentsSchema.parse(arguments_),
    (projectSessionId, workflowKey) =>
      revealComfyUiWorkflow(
        workflowKey,
        workflowKey.startsWith('project:')
          ? requireComfyUiProjectFilePath(projectSessionId)
          : comfyUiProjectFilePath(projectSessionId),
        { showItemInFolder: (itemPath) => shell.showItemInFolder(itemPath) },
      ),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_VERIFY_WORKFLOW_LIBRARY,
    (arguments_) => comfyUiVerifyWorkflowArgumentsSchema.parse(arguments_),
    (projectSessionId, request) =>
      verifyComfyUiWorkflowLibrary({
        ...request,
        projectFilePath: comfyUiProjectFilePath(projectSessionId),
      }),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_ANALYZE_WORKFLOW_IMPORT,
    (arguments_) => comfyUiAnalyzeWorkflowArgumentsSchema.parse(arguments_),
    (projectSessionId, request) =>
      analyzeComfyUiWorkflowImport({
        ...request,
        projectFilePath: comfyUiProjectFilePath(projectSessionId),
      }),
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_GENERATE_IMAGE,
    (arguments_) => comfyUiGenerateImageArgumentsSchema.parse(arguments_),
    (projectSessionId, config, request) => {
      const projectFilePath = requireComfyUiProjectFilePath(projectSessionId);
      return generateComfyUiImage(
        mainWindow,
        config,
        { ...request, projectFilePath },
        () => activeProjectSessions.isCurrent(projectSessionId),
        projectSessionId,
      );
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_EDIT_IMAGE,
    (arguments_) => comfyUiEditImageArgumentsSchema.parse(arguments_),
    (projectSessionId, config, request) => {
      const projectFilePath = requireComfyUiProjectFilePath(projectSessionId);
      return editComfyUiImage(
        mainWindow,
        activeProjectSessions,
        projectSessionId,
        projectFilePath,
        config,
        request,
        () => activeProjectSessions.isCurrent(projectSessionId),
      );
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMFYUI_CANCEL_JOB,
    (arguments_) => comfyUiCancelJobArgumentsSchema.parse(arguments_),
    (projectSessionId, config) => {
      activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      return cancelComfyUiJob(config, projectSessionId);
    },
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
  activeProjectSessions.dispose();
  void stopProjectWorkspaceWatcher();
  void enginePreviewServer.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
