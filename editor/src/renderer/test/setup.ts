import '@testing-library/jest-dom';
import { beforeEach, vi } from 'vitest';
import { DEFAULT_EDITOR_LANGUAGE, editorI18n, initEditorI18n } from '@/i18n';

await initEditorI18n({ language: DEFAULT_EDITOR_LANGUAGE });

beforeEach(() => {
  void editorI18n.changeLanguage(DEFAULT_EDITOR_LANGUAGE);
});

if (!window.PointerEvent) {
  Object.defineProperty(window, 'PointerEvent', { value: MouseEvent, writable: true, configurable: true });
}

if (!HTMLElement.prototype.scrollIntoView) {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: vi.fn(), writable: true, configurable: true });
}

Object.defineProperty(window, 'matchMedia', {
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
  writable: true,
  configurable: true,
});

Object.defineProperty(window, 'noveltea', {
  value: {
    getAppInfo: vi.fn().mockResolvedValue({
      version: '1.0.0',
      electronVersion: '42.0.0',
      platform: 'linux',
      arch: 'x64',
      packaged: false,
      frameless: false,
      nativeFrame: true,
      preferredSystemLanguages: ['en-US'],
      systemLocale: 'en-US',
    }),
    getDefaultProjectDirectory: vi.fn().mockResolvedValue('/home/test/Documents/NovelTea'),
    selectDirectory: vi.fn().mockResolvedValue('/home/test/Documents/NovelTea/custom-project'),
    selectProjectDirectory: vi.fn().mockResolvedValue('/mock/project'),
    selectPackageOutputPath: vi.fn().mockResolvedValue('/mock/project/export.ntpkg'),
    selectTemplateArchivePath: vi.fn().mockResolvedValue('/mock/template.tar.gz'),
    showItemInFolder: vi.fn().mockResolvedValue(undefined),
    previewExportedPackage: vi.fn().mockResolvedValue({ ok: false, success: false, diagnostics: [{ severity: 'warning', category: 'preview', path: '/mock/project/export.ntpkg', message: 'Package preview is not wired yet.' }] }),
    openExternal: vi.fn().mockResolvedValue(undefined),
    zoomIn: vi.fn().mockResolvedValue(1.1),
    zoomOut: vi.fn().mockResolvedValue(0.9),
    resetZoom: vi.fn().mockResolvedValue(1),
    minimizeAppWindow: vi.fn().mockResolvedValue(undefined),
    toggleMaximizeAppWindow: vi.fn().mockResolvedValue(false),
    requestAppWindowExit: vi.fn().mockResolvedValue(undefined),
    completeAppWindowExit: vi.fn().mockResolvedValue(undefined),
    onAppWindowBeforeClose: vi.fn().mockReturnValue(() => {}),
    onEditorShortcut: vi.fn().mockReturnValue(() => {}),
    isAppWindowMaximized: vi.fn().mockResolvedValue(false),
    setNativeWindowFrame: vi.fn().mockImplementation((nativeFrame: boolean) => Promise.resolve({
      version: '1.0.0',
      electronVersion: '42.0.0',
      platform: 'linux',
      arch: 'x64',
      packaged: false,
      frameless: !nativeFrame,
      nativeFrame,
      preferredSystemLanguages: ['en-US'],
      systemLocale: 'en-US',
    })),
    getEnginePreviewSession: vi.fn().mockResolvedValue({
      url: 'http://127.0.0.1:5000/?sessionToken=test-token',
      origin: 'http://127.0.0.1:5000',
      sessionToken: 'test-token',
    }),
    reloadEnginePreview: vi.fn().mockResolvedValue({
      url: 'http://127.0.0.1:5001/?sessionToken=test-token-2',
      origin: 'http://127.0.0.1:5001',
      sessionToken: 'test-token-2',
    }),
    createProject: vi.fn().mockResolvedValue({ ok: true, success: true, projectPath: '/home/test/Documents/NovelTea/new-project', projectFilePath: '/home/test/Documents/NovelTea/new-project/project.json' }),
    openProject: vi.fn().mockResolvedValue({
      ok: true,
      success: true,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
      project: { room: { foyer: ['foyer'] }, object: { lamp: ['lamp'] }, tests: {} },
      diagnostics: [],
    }),
    validateProject: vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [] }),
    listPlaybackTests: vi.fn().mockResolvedValue({ ok: true, tests: [{ id: 'smoke', steps: 1 }], diagnostics: [] }),
    runPlaybackTest: vi.fn().mockResolvedValue({ ok: true, report: { id: 'smoke', passed: true }, diagnostics: [] }),
    runPlaybackSpec: vi.fn().mockResolvedValue({ ok: true, report: { id: 'smoke', passed: true, observations: [] }, diagnostics: [] }),
    runUiPlaybackSpec: vi.fn().mockResolvedValue({ ok: true, report: { id: 'smoke', passed: true, observations: [], trace: [] }, diagnostics: [] }),
    exportPackage: vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [], byteCount: 1, manifest: { format: 'noveltea.runtime-package', entries: [] }, checksums: {} }),
    stagePlatformExport: vi.fn().mockResolvedValue({ ok: true, success: true, cancelled: false, operationId: 'mock', diagnostics: [] }),
    exportProjectToPlatform: vi.fn().mockResolvedValue({ ok: true, success: true, cancelled: false, operationId: 'mock', diagnostics: [] }),
    onPlatformExportProgress: vi.fn().mockReturnValue(() => undefined),
    cancelPlatformExport: vi.fn().mockResolvedValue({ cancelled: true }),
    listPlayerTemplates: vi.fn().mockResolvedValue([]),
    inspectPlayerTemplate: vi.fn().mockResolvedValue(null),
    installPlayerTemplate: vi.fn().mockResolvedValue({ success: false, diagnostics: [] }),
    removePlayerTemplate: vi.fn().mockResolvedValue({ removed: false }),
    resolvePlayerTemplate: vi.fn().mockResolvedValue({ success: false, diagnostics: [] }),
    compileShaders: vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [], outputs: [] }),
    saveProject: vi.fn().mockResolvedValue({ ok: true, success: true, projectPath: '/mock/project', projectFilePath: '/mock/project/game.json' }),
    saveProjectAs: vi.fn().mockResolvedValue({ ok: true, success: true, projectPath: '/mock/project', projectFilePath: '/mock/project/game.json' }),
    importAssets: vi.fn().mockResolvedValue({ success: true, assets: [], diagnostics: [] }),
    reimportAsset: vi.fn().mockResolvedValue({ success: true, asset: null, diagnostics: [] }),
    auditProjectAssets: vi.fn().mockResolvedValue({ ok: true, success: true, untrackedFiles: [], skippedUnstableFiles: [], diagnostics: [] }),
    importUntrackedProjectAssets: vi.fn().mockResolvedValue({ ok: true, success: true, assets: [], diagnostics: [] }),
    trashProjectAssetFiles: vi.fn().mockResolvedValue({ ok: true, success: true, moved: [], diagnostics: [] }),
    restoreProjectAssetFiles: vi.fn().mockResolvedValue({ ok: true, success: true, restored: [], diagnostics: [] }),
    purgeProjectTrash: vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [] }),
    startProjectAssetWatcher: vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [] }),
    stopProjectAssetWatcher: vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [] }),
    onProjectAssetAuditChanged: vi.fn().mockReturnValue(() => {}),
    resolveProjectAssetUrl: vi.fn().mockResolvedValue({ url: 'data:image/png;base64,bW9jaw==', absolutePath: '/mock/project/assets/images/logo.png' }),
    checkComfyUiConnection: vi.fn().mockResolvedValue({ state: 'ready', serverUrl: 'http://127.0.0.1:8000', checkedAt: 'now', message: 'ComfyUI ready', queueRemaining: 0 }),
    getComfyUiQueue: vi.fn().mockResolvedValue({ promptId: null, workflowId: null, state: 'idle', queueRemaining: 0, currentNode: null, progressValue: null, progressMax: null, message: 'ComfyUI queue idle' }),
    listComfyUiWorkflowLibrary: vi.fn().mockResolvedValue({
      ok: true,
      success: true,
      diagnostics: [],
      entries: [],
      activeWorkflows: [],
      overriddenEntries: [],
      summary: { sources: [], totalCount: 0, activeCount: 0, overriddenCount: 0, invalidCount: 0, verifiedCount: 0, failedVerificationCount: 0 },
    }),
    copyComfyUiWorkflow: vi.fn().mockResolvedValue({ ok: true, success: true, action: 'copied', diagnostics: [] }),
    deleteComfyUiWorkflow: vi.fn().mockResolvedValue({ ok: true, success: true, deleted: [], diagnostics: [] }),
    renameComfyUiWorkflow: vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [] }),
    importComfyUiWorkflowToLibrary: vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [], workflowKey: 'editor:mock.manifest.json', workflowFile: 'mock.workflow.json', manifestFile: 'mock.manifest.json' }),
    repairComfyUiWorkflowInLibrary: vi.fn().mockResolvedValue({ ok: true, success: true, diagnostics: [], workflowKey: 'editor:mock.manifest.json', workflowFile: 'mock.workflow.json', manifestFile: 'mock.manifest.json' }),
    revealComfyUiWorkflow: vi.fn().mockResolvedValue(true),
    verifyComfyUiWorkflowLibrary: vi.fn().mockResolvedValue({ ok: true, success: true, checkedAt: 'now', verified: [], failed: [], skipped: [], entries: [], diagnostics: [] }),
    analyzeComfyUiWorkflowImport: vi.fn().mockResolvedValue({ ok: true, diagnostics: [], roleCandidates: {} }),
    generateComfyUiImage: vi.fn().mockResolvedValue({ ok: true, success: true, promptId: 'prompt-1', diagnostics: [], assets: [{ asset: { originalPath: 'comfyui:generated.png', originalName: 'generated.png', projectRelativePath: 'assets/generated/generated.png', kind: 'image', extension: '.png', mimeType: 'image/png', byteSize: 4, contentHash: 'sha256:mock', importedAt: 'now' }, previewUrl: 'data:image/png;base64,bW9jaw==', absolutePath: '/mock/project/assets/generated/generated.png', projectRelativePath: 'assets/generated/generated.png', promptId: 'prompt-1', workflowId: 'flux2-klein-text-to-image', seed: 1, prompt: 'mock prompt', createdAt: 'now' }] }),
    editComfyUiImage: vi.fn().mockResolvedValue({ ok: true, success: true, promptId: 'prompt-2', diagnostics: [], assets: [{ asset: { originalPath: 'comfyui:edit.png', originalName: 'edit.png', projectRelativePath: 'assets/generated/edit.png', kind: 'image', extension: '.png', mimeType: 'image/png', byteSize: 4, contentHash: 'sha256:mock-edit', importedAt: 'now' }, previewUrl: 'data:image/png;base64,ZWRpdA==', absolutePath: '/mock/project/assets/generated/edit.png', projectRelativePath: 'assets/generated/edit.png', promptId: 'prompt-2', workflowId: 'flux2-klein-image-edit', seed: 2, prompt: 'edit prompt', createdAt: 'now' }] }),
    cancelComfyUiJob: vi.fn().mockResolvedValue({ ok: true, success: true }),
    onComfyUiProgress: vi.fn().mockReturnValue(() => {}),
  },
  writable: true,
  configurable: true,
});
