import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  protocol,
  screen,
  session,
  shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  auditProjectAssetsArgumentsSchema,
  cancelImageThumbnailPrewarmArgumentsSchema,
  cancelPlatformExportArgumentsSchema,
  comfyUiAnalyzeWorkflowArgumentsSchema,
  comfyUiCancelJobArgumentsSchema,
  comfyUiConfigArgumentsSchema,
  comfyUiCopyWorkflowArgumentsSchema,
  comfyUiDeleteWorkflowArgumentsSchema,
  comfyUiEditImageArgumentsSchema,
  comfyUiGenerateImageArgumentsSchema,
  comfyUiImportWorkflowArgumentsSchema,
  comfyUiListWorkflowLibraryArgumentsSchema,
  comfyUiRenameWorkflowArgumentsSchema,
  comfyUiRepairWorkflowArgumentsSchema,
  comfyUiRevealWorkflowArgumentsSchema,
  comfyUiUserConfigArgumentsSchema,
  comfyUiVerifyWorkflowArgumentsSchema,
  compileShadersArgumentsSchema,
  completeProjectImportArgumentsSchema,
  createEditorDocumentPolicy,
  createGuardedIpcRegistrar,
  createProjectArgumentsSchema,
  downloadPlayerTemplateArgumentsSchema,
  exportPackageArgumentsSchema,
  exportProjectToPlatformArgumentsSchema,
  imageThumbnailArgumentsSchema,
  imageThumbnailPrewarmArgumentsSchema,
  importAssetsArgumentsSchema,
  importProjectAttachmentFilesArgumentsSchema,
  inspectPlayerTemplateArgumentsSchema,
  inspectProjectAttachmentFileArgumentsSchema,
  installEditorNavigationPolicy,
  installPlayerTemplateArgumentsSchema,
  listPlayerTemplatesArgumentsSchema,
  listProjectAttachmentFilesArgumentsSchema,
  listProjectSourceFilesArgumentsSchema,
  mutateProjectSourcesArgumentsSchema,
  nativeProjectExportPackageArgumentsSchema,
  nativeProjectPatchArgumentsSchema,
  nativeProjectPrepareExportArgumentsSchema,
  nativeProjectPrepareRuntimeArgumentsSchema,
  nativeProjectReconcileArgumentsSchema,
  nativeProjectRunSuiteArgumentsSchema,
  nativeProjectRunTestArgumentsSchema,
  nativeProjectSaveTextArgumentsSchema,
  nativeProjectSaveUnitArgumentsSchema,
  nativeProjectUseDiskUnitArgumentsSchema,
  nativeProjectValidateArgumentsSchema,
  noArgumentsSchema,
  openExternalArgumentsSchema,
  openProjectArgumentsSchema,
  openProjectAttachmentFileArgumentsSchema,
  organizeUntrackedProjectAssetArgumentsSchema,
  prepareOpaqueVideoArgumentsSchema,
  previewExportedPackageArgumentsSchema,
  previewSessionArgumentsSchema,
  probeVideoTimelineArgumentsSchema,
  projectAssetIdentityArgumentsSchema,
  projectAssetPathsArgumentsSchema,
  projectSessionArgumentsSchema,
  projectSourceUsagesArgumentsSchema,
  readEngineShaderSourceArgumentsSchema,
  readProjectTextSourcesArgumentsSchema,
  reimportAssetArgumentsSchema,
  removePlayerTemplateArgumentsSchema,
  resolvePlayerTemplateArgumentsSchema,
  restoreProjectAssetFilesArgumentsSchema,
  runPlaybackSpecArgumentsSchema,
  runUiPlaybackSpecArgumentsSchema,
  saveProjectCopyAsArgumentsSchema,
  saveProjectEditorMetadataArgumentsSchema,
  saveUserExportConfigArgumentsSchema,
  saveUserPreferencesArgumentsSchema,
  selectDirectoryArgumentsSchema,
  selectPackageOutputPathArgumentsSchema,
  setNativeWindowFrameArgumentsSchema,
  showItemInFolderArgumentsSchema,
  stagePlatformExportArgumentsSchema,
  terminalCloseArgumentsSchema,
  terminalNotificationArgumentsSchema,
  terminalResizeArgumentsSchema,
  terminalSessionArgumentsSchema,
  terminalWriteArgumentsSchema,
  validateDirectoryArgumentsSchema,
} from './main/editor-ipc-trust-boundary';
import { EnginePreviewServer } from './main/engine-preview-server';
import {
  createImageThumbnailProtocolHandler,
  IMAGE_THUMBNAIL_SCHEME,
} from './main/image-thumbnail-protocol';
import {
  PACKAGE_SMOKE_FLAG,
  PACKAGE_SMOKE_PREFIX,
  runPackageSmoke,
  THUMBNAIL_PROTOCOL_CHARACTERIZATION_SCHEME,
} from './main/package-smoke';
import { ActiveProjectSessionService } from './main/services/active-project-session-service';
import { importAssets, reimportAsset } from './main/services/asset-import-service';
import { AssetMetadataInspectionService } from './main/services/asset-metadata-inspection-service';
import {
  cancelComfyUiJob,
  checkComfyUiConnection,
  editComfyUiImage,
  generateComfyUiImage,
  getComfyUiQueue,
} from './main/services/comfyui-service';
import {
  loadComfyUiUserConfig,
  saveComfyUiUserConfig,
} from './main/services/comfyui-user-config-service';
import { analyzeComfyUiWorkflowImport } from './main/services/comfyui-workflow-import-service';
import {
  copyComfyUiWorkflow,
  deleteComfyUiWorkflow,
  importComfyUiWorkflowToLibrary,
  listComfyUiWorkflowLibrary,
  renameComfyUiWorkflow,
  repairComfyUiWorkflowInLibrary,
  revealComfyUiWorkflow,
  verifyComfyUiWorkflowLibrary,
} from './main/services/comfyui-workflow-library-service';
import {
  isStrictlyContainedPath,
  resolveEditorCacheRoot,
  resolveSystemCachePath,
} from './main/services/image-thumbnail-cache-paths';
import { ImageThumbnailService } from './main/services/image-thumbnail-service';
import { NativeAuthoringSessionBridge } from './main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from './main/services/native-authoring-working-project';
import { importNativeDesktopProject } from './main/services/native-desktop-project-import-service';
import {
  exportNativeEditorPackage,
  prepareNativeEditorExportAssessment,
  verifyNativeCleanExportAdmission,
} from './main/services/native-editor-export-service';
import { NativeEditorObserverWatchService } from './main/services/native-editor-observer-watch-service';
import { createNativeEditorProject } from './main/services/native-editor-project-create';
import { NativeEditorProjectHandoff } from './main/services/native-editor-project-handoff';
import { NativeEditorSessionController } from './main/services/native-editor-session-controller';
import { saveNativeProjectCopyAs } from './main/services/native-project-copy-service';
import {
  exportPackage,
  runPlaybackSpec,
  runUiPlaybackSpec,
} from './main/services/native-runtime-tool-service';
import { compileShaders } from './main/services/native-shader-compiler-service';
import { nodeRuntimeArtifactPaths } from './main/services/node-runtime-artifact-adapters';
import { exportProjectToPlatform } from './main/services/platform-export-orchestration-service';
import { configureSharpPlatformImageService } from './main/services/platform-image-sharp-service';
import {
  cancelPlatformExport,
  stagePlatformExport,
} from './main/services/platform-staging-service';
import {
  importProjectAttachmentFiles,
  inspectProjectAttachmentFile,
  listProjectAttachmentFiles,
  openProjectAttachmentFile,
} from './main/services/project-asset-attachment-service';
import {
  auditProjectAssets,
  importUntrackedProjectAssets,
  organizeUntrackedProjectAsset,
  purgeProjectTrash,
} from './main/services/project-asset-audit-service';
import { saveProjectEditorMetadata } from './main/services/project-editor-metadata-service';
import {
  createProjectOriginalAssetProtocolHandler,
  PROJECT_ORIGINAL_ASSET_SCHEME,
  resolveProjectOriginalAssetUrl,
} from './main/services/project-original-asset-service';
import { readEngineShaderSource } from './main/services/project-source-planning-helpers';
import {
  prepareProjectOpaqueVideo,
  probeProjectVideoTimeline,
} from './main/services/project-video-preparation-service';
import { downloadPlayerTemplateForRelease } from './main/services/template-download-service';
import {
  configureTemplateRegistryRoot,
  inspectPlayerTemplate,
  installPlayerTemplate,
  listPlayerTemplates,
  removePlayerTemplate,
  resolvePlayerTemplate,
} from './main/services/template-registry-service';
import { TerminalNotificationService } from './main/services/terminal-notification-service';
import {
  createNodePtyAdapter,
  resolveDefaultTerminalShell,
  TerminalService,
} from './main/services/terminal-service';
import {
  loadNovelTeaUserPreferences,
  saveNovelTeaUserPreferences,
} from './main/services/user-config-service';
import {
  loadUserExportConfig,
  saveUserExportConfig,
} from './main/services/user-export-config-service';
import {
  DEFAULT_EDITOR_LANGUAGE,
  isSupportedEditorLanguage,
  resolveEditorLanguage,
  type EditorLanguage,
} from './renderer/i18n/language-types';
import { editorI18nResources } from './renderer/i18n/resources';
import { resolveEditorShortcutCommand } from './shared/editor-shortcuts';
import type { CreateProjectRequest } from './shared/editor-tooling';
import { IPC_CHANNELS } from './shared/ipc-channels';
import { setNovelTeaNativeOperationObserver } from './shared/noveltea-cli-subprocess';
import { NOVELTEA_VERSION } from './shared/product-version';
import {
  normalizeDesktopProjectImportArgument,
  type DesktopProjectImportRequest,
} from './shared/project-import-handoff';
import type {
  ListProjectSourceFilesRequest,
  ProjectSourceStructuralRequest,
  ProjectSourceUsageRequest,
} from './shared/project-source-files';
import type { ReadProjectTextSourcesRequest } from './shared/project-text-sources';
import { normalizeTerminalPreferences } from './shared/terminal-preferences';

configureSharpPlatformImageService();

const USER_DATA_DIRECTORY_NAME = 'noveltea-editor';

function configureApplicationPaths() {
  const appDataRoot = app.getPath('appData');
  const userDataPath = path.join(appDataRoot, USER_DATA_DIRECTORY_NAME);
  app.setPath('userData', userDataPath);
}

configureApplicationPaths();

if (!app.requestSingleInstanceLock()) app.quit();

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

function emitToolingActivity(record: import('./shared/tooling-activity').ToolingActivityRecord) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(IPC_CHANNELS.TOOLING_ACTIVITY_EVENT, record);
}

setNovelTeaNativeOperationObserver(emitToolingActivity);
const pendingProjectImports: DesktopProjectImportRequest[] = [];

function queueProjectImportArgument(argument: string, workingDirectory = process.cwd()): boolean {
  const request = normalizeDesktopProjectImportArgument(argument, workingDirectory);
  if (!request) return false;
  pendingProjectImports.push(request);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(IPC_CHANNELS.PROJECT_IMPORT_REQUESTED_EVENT);
  }
  return true;
}

for (const argument of process.argv.slice(1)) queueProjectImportArgument(argument);

app.on('open-file', (event, filePath) => {
  if (queueProjectImportArgument(filePath)) event.preventDefault();
});
app.on('open-url', (event, url) => {
  if (queueProjectImportArgument(url)) event.preventDefault();
});
app.on('second-instance', (_event, commandLine, workingDirectory) => {
  for (const argument of commandLine.slice(1))
    queueProjectImportArgument(argument, workingDirectory);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

const enginePreviewServer = new EnginePreviewServer();
const packageSmokeCacheRoot = process.argv.includes(PACKAGE_SMOKE_FLAG)
  ? process.env.NOVELTEA_EDITOR_PACKAGE_SMOKE_CACHE_ROOT?.trim()
  : undefined;
const activeProjectSessions = new ActiveProjectSessionService();
// Native Project authority is unconditional in the production editor. Each
// admitted Project owns one main-process worker; the CLI owns a separate
// native session and cannot substitute for the editor's working revision.
const nativeEditorObservers = new WeakMap<
  NativeEditorSessionController,
  NativeEditorObserverWatchService
>();
function createNativeEditorController(): NativeEditorSessionController {
  const addonPath =
    process.env.NOVELTEA_AUTHORING_NODE_ADDON?.trim() ||
    path.join(process.resourcesPath, 'authoring', 'noveltea-authoring-node.node');
  const bridge = new NativeAuthoringSessionBridge(activeProjectSessions, { addonPath });
  const controller = new NativeEditorSessionController(
    activeProjectSessions,
    bridge,
    new NativeAuthoringWorkingProject(bridge),
  );
  nativeEditorObservers.set(
    controller,
    new NativeEditorObserverWatchService(bridge, activeProjectSessions, (event) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
        mainWindow.webContents.send(IPC_CHANNELS.PROJECT_WORKSPACE_WATCH_EVENT, event);
    }),
  );
  return controller;
}
const nativeEditorHandoff = new NativeEditorProjectHandoff(
  activeProjectSessions,
  createNativeEditorController,
);
const nativeTestCatalogArgumentsSchema = {
  parse(arguments_: unknown[]): [unknown] {
    // Renderer display values are never another authoritative TypeScript
    // Project. Validate only the IPC envelope, not its record data.
    if (
      arguments_.length !== 1 ||
      !arguments_[0] ||
      typeof arguments_[0] !== 'object' ||
      Array.isArray(arguments_[0])
    )
      throw new Error('Native Test catalog request must carry one view-only object.');
    return [null];
  },
};
function closeNativeEditorHandoff(): void {
  const controller = nativeEditorHandoff?.current();
  if (controller) nativeEditorObservers.get(controller)?.close();
  nativeEditorHandoff?.close();
}
async function refreshNativeCandidateCapabilities(projectSessionId: string): Promise<void> {
  const controller = nativeEditorHandoff.current();
  if (!controller?.isAdmitted(projectSessionId))
    throw new Error('Native Asset and source inventory requires the admitted Project.');
  const current = await controller.currentWorkingProject(projectSessionId);
  if (!controller.isAdmitted(projectSessionId))
    throw new Error('Native Project changed during source authority refresh.');
  await activeProjectSessions.acceptNativeProject(projectSessionId, current);
}
let nativeEditorAdmission: NativeEditorSessionController | null = null;
const terminalService = new TerminalService({
  pty: createNodePtyAdapter(),
  resolveProjectRoot: () => activeProjectSessions.currentProjectRoot(),
  resolveProjectOrigin: () => activeProjectSessions.currentProjectIdentity(),
  resolveFallbackCwd: resolveConfiguredTerminalFallbackCwd,
  resolveDefaultProjectDirectory: resolveEffectiveDefaultProjectDirectory,
  resolveShell: resolveDefaultTerminalShell,
  emit: (event) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.TERMINAL_EVENT, event);
    }
  },
});
const terminalNotificationService = new TerminalNotificationService({
  isSupported: () => Notification.isSupported(),
  isWindowFocused: () => mainWindow?.isFocused() ?? true,
  resolveSessionLabel: (sessionId) => terminalService.sessionLabel(sessionId),
  resolveContent: resolveTerminalNotificationContent,
  createNotification: (options) => {
    const notification = new Notification(options);
    return {
      show: () => notification.show(),
      onClick: (callback) => notification.on('click', callback),
      onClose: (callback) => notification.on('close', callback),
    };
  },
  restoreWindow: () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
  },
  showWindow: () => mainWindow?.show(),
  focusWindow: () => mainWindow?.focus(),
  emitClick: (event) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.TERMINAL_NOTIFICATION_CLICK, event);
    }
  },
});
const assetMetadataInspectionService = new AssetMetadataInspectionService(activeProjectSessions);
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
let operatingSystemShutdown = false;

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

async function resolveEffectiveDefaultProjectDirectory(): Promise<string> {
  try {
    const preferences = await loadNovelTeaUserPreferences();
    const configured = preferences.defaultProjectDirectory;
    if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured);
  } catch {
    // Invalid/unavailable user configuration falls back to the built-in Documents/NovelTea default.
  }
  return getDefaultProjectDirectory();
}

async function resolveTerminalNotificationContent(
  label: string,
  kind: 'command-completed' | 'bell',
): Promise<{ title: string; body: string }> {
  let preference: EditorLanguage = 'system';
  try {
    const configured = (await loadNovelTeaUserPreferences()).language;
    if (
      configured === 'system' ||
      (typeof configured === 'string' && isSupportedEditorLanguage(configured))
    ) {
      preference = configured;
    }
  } catch {
    preference = 'system';
  }
  const language = resolveEditorLanguage(preference, app.getPreferredSystemLanguages());
  const terminalMessages =
    editorI18nResources[language]?.workspace.terminal ??
    editorI18nResources[DEFAULT_EDITOR_LANGUAGE].workspace.terminal;
  const template =
    kind === 'command-completed'
      ? terminalMessages.notificationCommandCompleted
      : terminalMessages.notificationNeedsAttention;
  return { title: 'NovelTea', body: template.replace('{{label}}', label) };
}

async function resolveConfiguredTerminalFallbackCwd(): Promise<string | null> {
  try {
    const preferences = await loadNovelTeaUserPreferences();
    const candidate = normalizeTerminalPreferences(preferences.terminal).fallbackCwd;
    if (!candidate || candidate.trim() === '') return null;
    const real = await fs.promises.realpath(path.resolve(candidate));
    return (await fs.promises.stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
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
  appWindowExitConfirmed = false;
  operatingSystemShutdown = false;
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
    terminalService.dispose();
    closeNativeEditorHandoff();
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
  mainWindow.on('query-session-end', () => {
    operatingSystemShutdown = true;
    terminalService.dispose();
  });
  mainWindow.on('close', (event) => {
    if (
      operatingSystemShutdown ||
      appWindowExitConfirmed ||
      mainWindow?.webContents.isDestroyed()
    ) {
      return;
    }
    const terminalRiskCount = terminalService.shutdownRiskCount();
    event.preventDefault();
    mainWindow?.webContents.send(IPC_CHANNELS.APP_WINDOW_BEFORE_CLOSE, { terminalRiskCount });
    if (terminalRiskCount === 0) {
      setTimeout(() => {
        if (!appWindowExitConfirmed && mainWindow && !mainWindow.isDestroyed()) {
          appWindowExitConfirmed = true;
          mainWindow.close();
        }
      }, 5000);
    }
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
  if (process.platform !== 'win32') {
    powerMonitor.on('shutdown', () => {
      operatingSystemShutdown = true;
      terminalService.dispose();
    });
  }
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
    onInvocation: emitToolingActivity,
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
    IPC_CHANNELS.VALIDATE_DIRECTORY,
    (arguments_) => validateDirectoryArgumentsSchema.parse(arguments_),
    async (candidate) => {
      try {
        return (await fs.promises.stat(path.resolve(candidate))).isDirectory();
      } catch {
        return false;
      }
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
      terminalService.dispose();
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
    IPC_CHANNELS.TERMINAL_ENSURE_STATE,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => terminalService.ensureState(),
  );

  guardedIpc.handle(
    IPC_CHANNELS.TERMINAL_CREATE_SESSION,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => terminalService.createSession(),
  );

  guardedIpc.handle(
    IPC_CHANNELS.TERMINAL_SELECT_SESSION,
    (arguments_) => terminalSessionArgumentsSchema.parse(arguments_),
    (sessionId) => terminalService.selectSession(sessionId),
  );

  guardedIpc.handle(
    IPC_CHANNELS.TERMINAL_CLOSE_SESSION,
    (arguments_) => terminalCloseArgumentsSchema.parse(arguments_),
    (request) => terminalService.closeSession(request.sessionId, request.force),
  );

  guardedIpc.handle(
    IPC_CHANNELS.TERMINAL_RELAUNCH_SESSION,
    (arguments_) => terminalSessionArgumentsSchema.parse(arguments_),
    (sessionId) => terminalService.relaunchSession(sessionId),
  );

  guardedIpc.handle(
    IPC_CHANNELS.TERMINAL_WRITE,
    (arguments_) => terminalWriteArgumentsSchema.parse(arguments_),
    (sessionId, data) => terminalService.write(sessionId, data),
  );

  guardedIpc.handle(
    IPC_CHANNELS.TERMINAL_RESIZE,
    (arguments_) => terminalResizeArgumentsSchema.parse(arguments_),
    (request) => terminalService.resize(request.sessionId, request.columns, request.rows),
  );

  guardedIpc.handle(
    IPC_CHANNELS.TERMINAL_SHOW_NOTIFICATION,
    (arguments_) => terminalNotificationArgumentsSchema.parse(arguments_),
    (request) => terminalNotificationService.show(request),
  );

  guardedIpc.handle(
    IPC_CHANNELS.GET_ENGINE_PREVIEW_SESSION,
    (arguments_) => previewSessionArgumentsSchema.parse(arguments_),
    (projectSessionId) => {
      const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      enginePreviewServer.setProjectFilePath(path.join(projectRoot, 'project.yaml'));
      return enginePreviewServer.getSession();
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.RELOAD_ENGINE_PREVIEW,
    (arguments_) => previewSessionArgumentsSchema.parse(arguments_),
    (projectSessionId) => {
      const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      enginePreviewServer.setProjectFilePath(path.join(projectRoot, 'project.yaml'));
      return enginePreviewServer.reload();
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.OPEN_PROJECT,
    (arguments_) => openProjectArgumentsSchema.parse(arguments_),
    async (projectPath: string) => {
      const incumbent = nativeEditorHandoff.current();
      const result = await nativeEditorHandoff.open(projectPath);
      if (result.success) {
        if (incumbent && incumbent !== nativeEditorHandoff.current())
          nativeEditorObservers.get(incumbent)?.close();
        nativeEditorAdmission = nativeEditorHandoff.current();
      }
      return rememberPreviewProjectRoot(result);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.CREATE_PROJECT,
    (arguments_) => createProjectArgumentsSchema.parse(arguments_),
    async (request: CreateProjectRequest) => {
      return createNativeEditorProject(request);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.TAKE_PENDING_PROJECT_IMPORT,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    () => pendingProjectImports.shift() ?? null,
  );

  guardedIpc.handle(
    IPC_CHANNELS.COMPLETE_PROJECT_IMPORT,
    (arguments_) => completeProjectImportArgumentsSchema.parse(arguments_),
    (request) => {
      return importNativeDesktopProject(request);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.CLOSE_ACTIVE_PROJECT,
    (arguments_) => noArgumentsSchema.parse(arguments_),
    async () => {
      closeNativeEditorHandoff();
      nativeEditorAdmission = null;
      return;
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_PATCH,
    (arguments_) => nativeProjectPatchArgumentsSchema.parse(arguments_),
    (...[projectSessionId, expectedRevision, patches, layoutCopySources]) => {
      // The main-owned worker alone performs revisioned mutations and Save;
      // never expose a path to a parallel Project writer.
      if (!nativeEditorAdmission)
        throw new Error('Native Project mutation is not enabled for this editor.');
      return nativeEditorAdmission.applyRevisionedPatches(
        projectSessionId,
        expectedRevision,
        patches,
        layoutCopySources,
      );
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_SAVE_UNIT,
    (arguments_) => nativeProjectSaveUnitArgumentsSchema.parse(arguments_),
    (projectSessionId, expectedRevision, saveUnitIds, options) => {
      if (!nativeEditorAdmission)
        throw new Error('Native Project Save is not enabled for this editor.');
      return nativeEditorAdmission.saveUnit(
        projectSessionId,
        expectedRevision,
        saveUnitIds,
        options,
      );
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_SAVE_TEXT,
    (arguments_) => nativeProjectSaveTextArgumentsSchema.parse(arguments_),
    (projectSessionId, expectedRevision, path, diskRevision, text) => {
      if (!nativeEditorAdmission)
        throw new Error('Native Project text Save is not enabled for this editor.');
      return nativeEditorAdmission.saveText(
        projectSessionId,
        expectedRevision,
        path,
        diskRevision,
        text,
      );
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_STAGE_TEXT,
    (arguments_) => nativeProjectSaveTextArgumentsSchema.parse(arguments_),
    (projectSessionId, expectedRevision, path, diskRevision, text) => {
      if (!nativeEditorAdmission)
        throw new Error('Native Project text staging is not enabled for this editor.');
      return nativeEditorAdmission.stageText(
        projectSessionId,
        expectedRevision,
        path,
        diskRevision,
        text,
      );
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_RECONCILE,
    (arguments_) => nativeProjectReconcileArgumentsSchema.parse(arguments_),
    (projectSessionId, expectedRevision, owner) => {
      if (!nativeEditorAdmission)
        throw new Error('Native Project reconciliation is not enabled for this editor.');
      return nativeEditorAdmission.reconcile(projectSessionId, expectedRevision, owner);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_USE_DISK_UNIT,
    (arguments_) => nativeProjectUseDiskUnitArgumentsSchema.parse(arguments_),
    (projectSessionId, expectedRevision, saveUnitId) => {
      if (!nativeEditorAdmission)
        throw new Error('Native Project Use Disk is not enabled for this editor.');
      return nativeEditorAdmission.useDiskUnit(projectSessionId, expectedRevision, saveUnitId);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_VALIDATE,
    (arguments_) => nativeProjectValidateArgumentsSchema.parse(arguments_),
    (projectSessionId, expectedRevision) => {
      if (!nativeEditorAdmission)
        throw new Error('Native Project validation is not enabled for this editor.');
      return nativeEditorAdmission.validate(projectSessionId, expectedRevision);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_SEMANTIC_GRAPH,
    (arguments_) => nativeProjectValidateArgumentsSchema.parse(arguments_),
    (projectSessionId, expectedRevision) => {
      if (!nativeEditorAdmission)
        throw new Error('Native Project graph queries are not enabled for this editor.');
      return nativeEditorAdmission.semanticGraph(projectSessionId, expectedRevision);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_PREPARE_RUNTIME,
    (arguments_) => nativeProjectPrepareRuntimeArgumentsSchema.parse(arguments_),
    (projectSessionId, expectedRevision, shaderVariant) => {
      if (!nativeEditorAdmission)
        throw new Error('Native runtime preparation is not enabled for this editor.');
      return nativeEditorAdmission.prepareRuntime(
        projectSessionId,
        expectedRevision,
        shaderVariant,
      );
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_TEST_READINESS,
    (arguments_) => nativeProjectRunTestArgumentsSchema.parse(arguments_),
    (projectSessionId, expectedRevision, testId) => {
      if (!nativeEditorAdmission) throw new Error('No native Project is admitted.');
      return nativeEditorAdmission.testReadiness(projectSessionId, expectedRevision, testId);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_RUN_TEST,
    (arguments_) => nativeProjectRunTestArgumentsSchema.parse(arguments_),
    (projectSessionId, expectedRevision, testId) => {
      if (!nativeEditorAdmission)
        throw new Error('Native authored Tests are not enabled for this editor.');
      return nativeEditorAdmission.runTest(projectSessionId, expectedRevision, testId);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_RUN_SUITE,
    (arguments_) => nativeProjectRunSuiteArgumentsSchema.parse(arguments_),
    (projectSessionId, expectedRevision) => {
      if (!nativeEditorAdmission)
        throw new Error('Native authored Test suite is not enabled for this editor.');
      return nativeEditorAdmission.runSuite(projectSessionId, expectedRevision);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_PREPARE_EXPORT,
    (arguments_) => nativeProjectPrepareExportArgumentsSchema.parse(arguments_),
    (projectSessionId, expectedRevision, mode, profileId) => {
      if (!nativeEditorAdmission)
        throw new Error('Native export assessment is not enabled for this editor.');
      const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      return prepareNativeEditorExportAssessment(
        nativeEditorAdmission,
        projectSessionId,
        expectedRevision,
        projectRoot,
        mode,
        profileId,
      );
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.NATIVE_PROJECT_EXPORT_PACKAGE,
    (arguments_) => nativeProjectExportPackageArgumentsSchema.parse(arguments_),
    (projectSessionId, expectedRevision, outputPath) => {
      if (!nativeEditorAdmission)
        throw new Error('Native package export is not enabled for this editor.');
      const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      return exportNativeEditorPackage(
        nativeEditorAdmission,
        projectSessionId,
        projectRoot,
        outputPath,
        {
          publish: exportPackage,
          authorizePackageOptions: (options) => assertPackageProjectAuthority(projectRoot, options),
        },
        expectedRevision,
      );
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.LIST_PLAYBACK_TESTS,
    (arguments_) => nativeTestCatalogArgumentsSchema.parse(arguments_),
    async (_project) => {
      const sessionId = activeProjectSessions.currentSessionId();
      const controller = nativeEditorHandoff?.current() ?? nativeEditorAdmission;
      if (!sessionId || !controller?.isAdmitted(sessionId))
        throw new Error('Native Test catalog requires an admitted Project.');
      const native = await controller.currentWorkingProject(sessionId);
      return {
        ok: true,
        tests: Object.entries(native.tests).map(([id, record]) => ({
          id,
          steps: record.data.steps.length,
        })),
        diagnostics: [],
      };
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.RUN_PLAYBACK_SPEC,
    (arguments_) => runPlaybackSpecArgumentsSchema.parse(arguments_),
    (project, spec) => runPlaybackSpec(project, spec),
  );

  guardedIpc.handle(
    IPC_CHANNELS.RUN_UI_PLAYBACK_SPEC,
    (arguments_) => runUiPlaybackSpecArgumentsSchema.parse(arguments_),
    (projectSessionId, project, spec, shaderMaterialMetadata) => {
      const projectRoot = projectSessionId
        ? activeProjectSessions.requireActiveProjectRoot(projectSessionId)
        : null;
      return runUiPlaybackSpec(project, spec, projectRoot, shaderMaterialMetadata);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.EXPORT_PACKAGE,
    (arguments_) => exportPackageArgumentsSchema.parse(arguments_),
    async (projectSessionId, project, outputPath, options) => {
      const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      assertPackageProjectAuthority(projectRoot, options);

      if (!nativeEditorAdmission)
        throw new Error('Native runtime package export requires an admitted Project.');
      return exportNativeEditorPackage(
        nativeEditorAdmission,
        projectSessionId,
        projectRoot,
        outputPath,
        {
          publish: exportPackage,
          authorizePackageOptions: (options) => assertPackageProjectAuthority(projectRoot, options),
        },
      );
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.STAGE_PLATFORM_EXPORT,
    (arguments_) => stagePlatformExportArgumentsSchema.parse(arguments_),
    async (projectSessionId, request) => {
      const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      requireProjectContainedPath(projectRoot, request.packagePath, 'Runtime package source');
      if (request.iconSourcePath)
        requireProjectContainedPath(projectRoot, request.iconSourcePath, 'Platform icon source');
      if (request.systemAssetsRoot)
        requireProjectContainedPath(projectRoot, request.systemAssetsRoot, 'System assets root');
      await nativeEditorAdmission!.prepareCleanExport(projectSessionId);
      return stagePlatformExport(request);
    },
  );
  guardedIpc.handle(
    IPC_CHANNELS.EXPORT_PROJECT_TO_PLATFORM,
    (arguments_) => exportProjectToPlatformArgumentsSchema.parse(arguments_),
    async (projectSessionId, request) => {
      const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
      if (request.preparedRuntimeArtifact)
        assertPackageProjectAuthority(projectRoot, request.preparedRuntimeArtifact.packageOptions);

      if (!nativeEditorAdmission)
        throw new Error('Native platform export requires an admitted Project.');
      const controller = nativeEditorAdmission;
      const admission = await controller.prepareCleanExportAdmission(projectSessionId);
      return exportProjectToPlatform(
        {
          ...request,
          project: admission.project,
          preparedRuntimeArtifact: undefined,
          projectPath: path.join(projectRoot, 'project.yaml'),
          projectRoot,
        },
        (progress) =>
          mainWindow?.webContents.send(IPC_CHANNELS.PLATFORM_EXPORT_PROGRESS_EVENT, progress),
        undefined,
        async () => {
          try {
            await verifyNativeCleanExportAdmission(controller, projectSessionId, admission);
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
        undefined,
        nodeRuntimeArtifactPaths,
        {
          project: admission.project,
          diagnostics: admission.diagnostics,
          runtimeAssetReferences: admission.runtimeAssetReferences,
        },
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
    IPC_CHANNELS.PROBE_VIDEO_TIMELINE,
    (arguments_) => probeVideoTimelineArgumentsSchema.parse(arguments_),
    (projectSessionId, request) =>
      probeProjectVideoTimeline(activeProjectSessions, projectSessionId, request),
  );

  guardedIpc.handle(
    IPC_CHANNELS.PREPARE_OPAQUE_VIDEO,
    (arguments_) => prepareOpaqueVideoArgumentsSchema.parse(arguments_),
    (projectSessionId, request) =>
      prepareProjectOpaqueVideo(activeProjectSessions, projectSessionId, request),
  );

  guardedIpc.handle(
    IPC_CHANNELS.SAVE_PROJECT_EDITOR_METADATA,
    (arguments_) => saveProjectEditorMetadataArgumentsSchema.parse(arguments_),
    async (projectSessionId, editorState, _recoveryFileOwnershipHints) => {
      try {
        // This writes only .noveltea/editor/state.json, never tracked source or
        // the native working Project. Native replay remains authoritative.
        return await saveProjectEditorMetadata(
          activeProjectSessions.requireActiveProjectRoot(projectSessionId),
          editorState,
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
    IPC_CHANNELS.SAVE_PROJECT_COPY_AS,
    (arguments_) => saveProjectCopyAsArgumentsSchema.parse(arguments_),
    async (projectSessionId, project, _workingProjectAssetPaths, _scriptSourcePaths) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);

        if (!nativeEditorAdmission?.isAdmitted(projectSessionId))
          throw new Error('Native Project Copy requires an admitted Project.');
        const controller = nativeEditorAdmission;
        return await saveNativeProjectCopyAs(mainWindow, projectRoot, project, () =>
          controller.verifySavedCopySources(projectSessionId),
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
        return await importAssets(
          mainWindow,
          path.join(projectRoot, 'project.yaml'),
          options,
          () => activeProjectSessions.requireActiveProjectRoot(projectSessionId),
          (assetPath, bytes) =>
            nativeEditorAdmission!.stageAsset(projectSessionId, assetPath, bytes),
          (paths) => nativeEditorAdmission!.discardStagedAssets(projectSessionId, paths),
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
          path.join(projectRoot, 'project.yaml'),
          projectRelativePath,
          () => activeProjectSessions.requireActiveProjectRoot(projectSessionId),
          (assetPath, bytes) =>
            nativeEditorAdmission!.stageAsset(projectSessionId, assetPath, bytes),
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
    async (projectSessionId, _project) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        return await auditProjectAssets(
          path.join(projectRoot, 'project.yaml'),
          await nativeEditorAdmission!.currentWorkingProject(projectSessionId),
          () => activeProjectSessions.requireActiveProjectRoot(projectSessionId),
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
          path.join(projectRoot, 'project.yaml'),
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
    IPC_CHANNELS.ORGANIZE_UNTRACKED_PROJECT_ASSET,
    (arguments_) => organizeUntrackedProjectAssetArgumentsSchema.parse(arguments_),
    async (projectSessionId, project, projectRelativePath, action) => {
      try {
        const projectRoot = activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        return await organizeUntrackedProjectAsset(
          path.join(projectRoot, 'project.yaml'),
          await nativeEditorAdmission!.currentWorkingProject(projectSessionId),
          projectRelativePath,
          action,
          () => activeProjectSessions.requireActiveProjectRoot(projectSessionId),
          (fromPath, toPath) =>
            nativeEditorAdmission!.organizeUntrackedAsset(projectSessionId, fromPath, toPath),
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
    IPC_CHANNELS.LIST_PROJECT_ATTACHMENT_FILES,
    (arguments_) => listProjectAttachmentFilesArgumentsSchema.parse(arguments_),
    async (projectSessionId) => ({
      files: await listProjectAttachmentFiles(
        activeProjectSessions.requireActiveProjectRoot(projectSessionId),
      ),
    }),
  );
  guardedIpc.handle(
    IPC_CHANNELS.IMPORT_PROJECT_ATTACHMENT_FILES,
    (arguments_) => importProjectAttachmentFilesArgumentsSchema.parse(arguments_),
    async (request) => {
      const root = activeProjectSessions.requireActiveProjectRoot(request.projectSessionId);
      return importProjectAttachmentFiles(
        mainWindow,
        root,
        request,
        () => activeProjectSessions.requireActiveProjectRoot(request.projectSessionId),
        (files) => nativeEditorAdmission!.publishAttachments(request.projectSessionId, files),
      );
    },
  );
  guardedIpc.handle(
    IPC_CHANNELS.INSPECT_PROJECT_ATTACHMENT_FILE,
    (arguments_) => inspectProjectAttachmentFileArgumentsSchema.parse(arguments_),
    (projectSessionId, relativePath) =>
      inspectProjectAttachmentFile(
        activeProjectSessions.requireActiveProjectRoot(projectSessionId),
        relativePath,
      ),
  );
  guardedIpc.handle(
    IPC_CHANNELS.OPEN_PROJECT_ATTACHMENT_FILE,
    (arguments_) => openProjectAttachmentFileArgumentsSchema.parse(arguments_),
    (projectSessionId, relativePath, action) =>
      openProjectAttachmentFile(
        activeProjectSessions.requireActiveProjectRoot(projectSessionId),
        relativePath,
        action,
      ),
  );

  guardedIpc.handle(
    IPC_CHANNELS.TRASH_PROJECT_ASSET_FILES,
    (arguments_) => projectAssetPathsArgumentsSchema.parse(arguments_),
    async (projectSessionId, projectRelativePaths) => {
      try {
        activeProjectSessions.requireActiveProjectRoot(projectSessionId);

        return nativeEditorAdmission!.trashOrDiscardAssetFiles(
          projectSessionId,
          projectRelativePaths,
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
        activeProjectSessions.requireActiveProjectRoot(projectSessionId);

        await nativeEditorAdmission!.transitionAssetFiles(projectSessionId, {
          kind: 'restore',
          moves,
        });
        return { ok: true, success: true, diagnostics: [], restored: moves };
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
        return await purgeProjectTrash(path.join(projectRoot, 'project.yaml'), () =>
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
        activeProjectSessions.requireActiveProjectRoot(projectSessionId);
        const controller = nativeEditorHandoff.current();
        if (!controller?.isAdmitted(projectSessionId))
          throw new Error('Native Project observer requires the current admitted session.');
        nativeEditorObservers.get(controller)!.start(projectSessionId);
        return { ok: true, success: true, diagnostics: [] };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Project session is stale or unknown.';
        return {
          ok: false,
          success: false,
          diagnostics: [{ severity: 'error' as const, path: '/project.yaml', message }],
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

        nativeEditorObservers.get(nativeEditorHandoff.current()!)?.close();
        return { ok: true, success: true, diagnostics: [] };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Project session is stale or unknown.';
        return {
          ok: false,
          success: false,
          diagnostics: [{ severity: 'error' as const, path: '/project.yaml', message }],
          error: message,
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.RESOLVE_PROJECT_ORIGINAL_ASSET_URL,
    (arguments_) => projectAssetIdentityArgumentsSchema.parse(arguments_),
    async (projectSessionId, assetId) => {
      await refreshNativeCandidateCapabilities(projectSessionId);
      return resolveProjectOriginalAssetUrl(activeProjectSessions, projectSessionId, assetId);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.INSPECT_PROJECT_ASSET_METADATA,
    (arguments_) => projectAssetIdentityArgumentsSchema.parse(arguments_),
    async (projectSessionId, assetId) => {
      await refreshNativeCandidateCapabilities(projectSessionId);
      return assetMetadataInspectionService.inspect(projectSessionId, assetId);
    },
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
    IPC_CHANNELS.LIST_PROJECT_SOURCE_FILES,
    (arguments_) => listProjectSourceFilesArgumentsSchema.parse(arguments_),
    async (request: ListProjectSourceFilesRequest) => {
      await refreshNativeCandidateCapabilities(request.projectSessionId);
      return activeProjectSessions.listProjectSourceFiles(request);
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.PROJECT_SOURCE_USAGES,
    (arguments_) => projectSourceUsagesArgumentsSchema.parse(arguments_),
    (request: ProjectSourceUsageRequest) =>
      nativeEditorAdmission!.sourceUsages(request.projectSessionId, request.path),
  );

  guardedIpc.handle(
    IPC_CHANNELS.MUTATE_PROJECT_SOURCES,
    (arguments_) => mutateProjectSourcesArgumentsSchema.parse(arguments_),
    async (request: ProjectSourceStructuralRequest) => {
      try {
        return await nativeEditorAdmission!.mutateProjectSources(request);
      } catch (error) {
        return {
          ok: false,
          success: false,
          error: error instanceof Error ? error.message : 'Project source operation failed.',
        };
      }
    },
  );

  guardedIpc.handle(
    IPC_CHANNELS.READ_PROJECT_TEXT_SOURCES,
    (arguments_) => readProjectTextSourcesArgumentsSchema.parse(arguments_),
    (request: ReadProjectTextSourcesRequest) => activeProjectSessions.read(request),
  );

  guardedIpc.handle(
    IPC_CHANNELS.READ_ENGINE_SHADER_SOURCE,
    (arguments_) => readEngineShaderSourceArgumentsSchema.parse(arguments_),
    (sourceIdentity: string) => readEngineShaderSource(sourceIdentity),
  );

  const comfyUiProjectFilePath = (projectSessionId: string | null) =>
    projectSessionId
      ? path.join(activeProjectSessions.requireActiveProjectRoot(projectSessionId), 'project.yaml')
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
  closeNativeEditorHandoff();
  activeProjectSessions.dispose();
  void enginePreviewServer.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
