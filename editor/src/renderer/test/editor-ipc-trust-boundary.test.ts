import { describe, expect, it, vi } from 'vite-plus/test';
import {
  cancelPlatformExportArgumentsSchema,
  comfyUiConfigArgumentsSchema,
  comfyUiCopyWorkflowArgumentsSchema,
  comfyUiEditImageArgumentsSchema,
  comfyUiGenerateImageArgumentsSchema,
  comfyUiImportWorkflowArgumentsSchema,
  comfyUiListWorkflowLibraryArgumentsSchema,
  comfyUiUserConfigArgumentsSchema,
  comfyUiRepairWorkflowArgumentsSchema,
  compileShadersArgumentsSchema,
  createEditorDocumentPolicy,
  createGuardedIpcRegistrar,
  createProjectArgumentsSchema,
  exportProjectToPlatformArgumentsSchema,
  inspectPlayerTemplateArgumentsSchema,
  installEditorNavigationPolicy,
  installPlayerTemplateArgumentsSchema,
  noArgumentsSchema,
  openExternalArgumentsSchema,
  openProjectArgumentsSchema,
  previewSessionArgumentsSchema,
  projectAssetIdentityArgumentsSchema,
  readProjectTextSourcesArgumentsSchema,
  saveProjectContentArgumentsSchema,
  saveProjectCopyAsArgumentsSchema,
  saveProjectEditorMetadataArgumentsSchema,
  selectPackageOutputPathArgumentsSchema,
  setNativeWindowFrameArgumentsSchema,
  showItemInFolderArgumentsSchema,
  stagePlatformExportArgumentsSchema,
  type EditorIpcEvent,
  type EditorIpcMain,
  type EditorWebContents,
  type EditorWindow,
} from '../../main/editor-ipc-trust-boundary';
import {
  EDITOR_IPC_FAILURE,
  normalizeEditorIpcBoundaryError,
} from '../../shared/editor-ipc-boundary';
import { selectDirectoryArgumentsSchema } from '../../main/editor-ipc-trust-boundary';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { defaultPlatformExportProfile } from '../../shared/project-schema/platform-export-contracts';
import type { ReadProjectTextSourcesRequest } from '../../shared/project-text-sources';

class FakeIpcMain implements EditorIpcMain {
  private readonly handlers = new Map<
    string,
    (event: EditorIpcEvent, ...arguments_: unknown[]) => unknown
  >();

  handle(
    channel: string,
    handler: (event: EditorIpcEvent, ...arguments_: unknown[]) => unknown,
  ): void {
    this.handlers.set(channel, handler);
  }

  invoke(channel: string, event: EditorIpcEvent, ...arguments_: unknown[]) {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`Missing fake handler for ${channel}`);
    return handler(event, ...arguments_);
  }
}

function frame(url: string) {
  return { detached: false, url };
}

function trustedHarness(documentUrl = 'noveltea-editor://app/index.html') {
  const mainFrame = frame(documentUrl);
  const webContents: EditorWebContents & { destroyed: boolean; mainFrame: { url: string } } = {
    destroyed: false,
    mainFrame,
    isDestroyed() {
      return this.destroyed;
    },
  };
  const window: EditorWindow & { destroyed: boolean } = {
    destroyed: false,
    webContents,
    isDestroyed() {
      return this.destroyed;
    },
  };
  return {
    mainFrame,
    webContents,
    window,
    event: { sender: webContents, senderFrame: mainFrame } satisfies EditorIpcEvent,
  };
}

function rejectionCode(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

describe('guarded editor IPC registrar', () => {
  it('admits named asset-memory policies at the guarded platform-stage boundary', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const request = {
      operationId: 'stage-1',
      profile: defaultPlatformExportProfile('linux'),
      assetMemoryPolicies: [
        {
          id: 'streaming',
          label: 'Streaming',
          basePreset: 'balanced',
          overrides: { gpuBytes: 192 * 1024 * 1024 },
        },
      ],
      templateToken: 'linux/build-1',
      outputDirectory: '/tmp/out',
      packagePath: '/tmp/game.ntpkg',
      runtimePackageEvidence: {
        sourceFingerprint: 'fnv1a:12345678',
        packageSha256: 'a'.repeat(64),
      },
      identity: {
        displayName: 'Game',
        applicationId: 'org.example.game',
        saveNamespace: 'org.example.game',
        versionName: '1.0.0',
      },
      display: {
        aspectRatio: { width: 16, height: 9 },
        orientation: 'landscape',
        barColor: '#000000',
      },
      runtimeDisplay: {
        referenceResolution: { width: 1920, height: 1080 },
        worldRasterPolicy: 'capped',
        barColor: '#000000',
      },
      accessibility: {
        uiScale: { enabled: true, minimum: 1, maximum: 2 },
        textScale: { enabled: true, minimum: 1, maximum: 2 },
      },
      playerRuntimeApiVersion: 1,
    };

    expect(stagePlatformExportArgumentsSchema.parse([sessionId, request])[1]).toMatchObject({
      assetMemoryPolicies: [{ id: 'streaming', basePreset: 'balanced' }],
    });
  });

  it('strictly admits Project open and creation lifecycle arguments', async () => {
    const ipcMain = new FakeIpcMain();
    const harness = trustedHarness();
    const openService = vi.fn((projectPath: string) => projectPath);
    const createService = vi.fn((request: { projectName: string; projectDirectory: string }) =>
      structuredClone(request),
    );
    const registrar = createGuardedIpcRegistrar({
      ipcMain,
      getOwner: () => harness.window,
      documentPolicy: createEditorDocumentPolicy(),
    });
    registrar.handle(
      'open-project',
      (arguments_) => openProjectArgumentsSchema.parse(arguments_),
      openService,
    );
    registrar.handle(
      'create-project',
      (arguments_) => createProjectArgumentsSchema.parse(arguments_),
      createService,
    );

    await expect(ipcMain.invoke('open-project', harness.event, '/projects/story')).resolves.toBe(
      '/projects/story',
    );
    await expect(
      ipcMain.invoke('create-project', harness.event, {
        projectName: 'Story',
        projectDirectory: '/projects/story',
      }),
    ).resolves.toEqual({ projectName: 'Story', projectDirectory: '/projects/story' });

    for (const [channel, arguments_] of [
      ['open-project', []],
      ['open-project', ['/projects/story', 'extra']],
      ['create-project', [{ projectName: 'Story', projectDirectory: '/projects/story', extra: 1 }]],
      ['create-project', [{ projectName: '', projectDirectory: '/projects/story' }]],
    ] as const) {
      openService.mockClear();
      createService.mockClear();
      await expect(ipcMain.invoke(channel, harness.event, ...arguments_)).rejects.toSatisfy(
        (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.INVALID_REQUEST,
      );
      expect(openService).not.toHaveBeenCalled();
      expect(createService).not.toHaveBeenCalled();
    }

    const other = trustedHarness();
    await expect(ipcMain.invoke('open-project', other.event, '/projects/story')).rejects.toSatisfy(
      (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.UNTRUSTED_SENDER,
    );
    expect(openService).not.toHaveBeenCalled();
  });

  it('strictly admits bounded Project text-source requests before calling the service', async () => {
    const ipcMain = new FakeIpcMain();
    const harness = trustedHarness();
    const service = vi.fn((_request: ReadProjectTextSourcesRequest) => ({ entries: [] }));
    const registrar = createGuardedIpcRegistrar({
      ipcMain,
      getOwner: () => harness.window,
      documentPolicy: createEditorDocumentPolicy(),
    });
    registrar.handle(
      'read-project-text-sources',
      (arguments_) => readProjectTextSourcesArgumentsSchema.parse(arguments_),
      service,
    );
    const request = {
      projectSessionId: 'opaque-session',
      entries: [
        {
          readKey: 'source',
          projectRelativePath: 'assets/source.lua',
          expectedContentHash: `sha256:${'a'.repeat(64)}`,
        },
      ],
    };

    await expect(
      ipcMain.invoke('read-project-text-sources', harness.event, request),
    ).resolves.toEqual({ entries: [] });
    expect(service).toHaveBeenCalledWith(request);

    for (const arguments_ of [
      [{ ...request, unexpected: true }],
      [{ ...request, entries: [{ ...request.entries[0], unexpected: true }] }],
      [request, 'extra'],
    ]) {
      service.mockClear();
      await expect(
        ipcMain.invoke('read-project-text-sources', harness.event, ...arguments_),
      ).rejects.toSatisfy(
        (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.INVALID_REQUEST,
      );
      expect(service).not.toHaveBeenCalled();
    }

    const other = trustedHarness();
    await expect(
      ipcMain.invoke('read-project-text-sources', other.event, request),
    ).rejects.toSatisfy(
      (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.UNTRUSTED_SENDER,
    );
    expect(service).not.toHaveBeenCalled();
  });

  it('guards original Asset URL requests before Project filesystem work', async () => {
    const ipcMain = new FakeIpcMain();
    const harness = trustedHarness();
    const service = vi.fn(
      (projectSessionId: string, assetId: string) => `${projectSessionId}:${assetId}`,
    );
    const registrar = createGuardedIpcRegistrar({
      ipcMain,
      getOwner: () => harness.window,
      documentPolicy: createEditorDocumentPolicy(),
    });
    registrar.handle(
      'original-asset',
      (arguments_) => projectAssetIdentityArgumentsSchema.parse(arguments_),
      service,
    );
    const sessionId = '11111111-1111-4111-8111-111111111111';

    await expect(ipcMain.invoke('original-asset', harness.event, sessionId, 'logo')).resolves.toBe(
      `${sessionId}:logo`,
    );
    for (const arguments_ of [
      [sessionId],
      ['not-a-session', 'logo'],
      [sessionId, ''],
      [sessionId, 'x'.repeat(513)],
      [sessionId, 'logo', '/alternate/project/path'],
    ] as const) {
      service.mockClear();
      await expect(
        ipcMain.invoke('original-asset', harness.event, ...arguments_),
      ).rejects.toSatisfy(
        (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.INVALID_REQUEST,
      );
      expect(service).not.toHaveBeenCalled();
    }

    const other = trustedHarness();
    service.mockClear();
    await expect(
      ipcMain.invoke('original-asset', other.event, sessionId, 'logo'),
    ).rejects.toSatisfy(
      (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.UNTRUSTED_SENDER,
    );
    expect(service).not.toHaveBeenCalled();
  });

  it('guards preview and shader requests before active-Project side effects', async () => {
    const ipcMain = new FakeIpcMain();
    const harness = trustedHarness();
    const previewService = vi.fn((projectSessionId: string) => projectSessionId);
    const shaderService = vi.fn(
      (projectSessionId: string, _shaderProject: unknown, _options: unknown) => projectSessionId,
    );
    const registrar = createGuardedIpcRegistrar({
      ipcMain,
      getOwner: () => harness.window,
      documentPolicy: createEditorDocumentPolicy(),
    });
    registrar.handle(
      'preview-session',
      (arguments_) => previewSessionArgumentsSchema.parse(arguments_),
      previewService,
    );
    registrar.handle(
      'compile-shaders',
      (arguments_) => compileShadersArgumentsSchema.parse(arguments_),
      shaderService,
    );
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const shaderProject = { schema: 'noveltea.shader-materials', shaders: {}, materials: {} };

    await expect(ipcMain.invoke('preview-session', harness.event, sessionId)).resolves.toBe(
      sessionId,
    );
    await expect(
      ipcMain.invoke('compile-shaders', harness.event, sessionId, shaderProject, {
        forceRebuild: true,
        shaderVariants: ['glsl-120'],
      }),
    ).resolves.toBe(sessionId);

    for (const [channel, arguments_] of [
      ['preview-session', []],
      ['preview-session', [sessionId, 'extra']],
      ['compile-shaders', [sessionId, shaderProject, { projectRoot: '/alternate' }]],
      ['compile-shaders', [sessionId, { ...shaderProject, extra: true }, {}]],
      ['compile-shaders', [sessionId, shaderProject, { shaderVariants: ['x'.repeat(257)] }]],
      ['compile-shaders', [sessionId, shaderProject, {}, 'extra']],
    ] as const) {
      previewService.mockClear();
      shaderService.mockClear();
      await expect(ipcMain.invoke(channel, harness.event, ...arguments_)).rejects.toSatisfy(
        (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.INVALID_REQUEST,
      );
      expect(previewService).not.toHaveBeenCalled();
      expect(shaderService).not.toHaveBeenCalled();
    }

    const other = trustedHarness();
    await expect(
      ipcMain.invoke('compile-shaders', other.event, sessionId, shaderProject, {}),
    ).rejects.toSatisfy(
      (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.UNTRUSTED_SENDER,
    );
    expect(shaderService).not.toHaveBeenCalled();
  });

  it('guards Project export authority and bounds template operations before side effects', async () => {
    const ipcMain = new FakeIpcMain();
    const harness = trustedHarness();
    const exportService = vi.fn((projectSessionId: string, _request: unknown) => projectSessionId);
    const cancelService = vi.fn(
      (projectSessionId: string, _operationId: string) => projectSessionId,
    );
    const inspectService = vi.fn((templateId: string, _buildId: string) => templateId);
    const installService = vi.fn((request: unknown) => request);
    const registrar = createGuardedIpcRegistrar({
      ipcMain,
      getOwner: () => harness.window,
      documentPolicy: createEditorDocumentPolicy(),
    });
    registrar.handle(
      'platform-export',
      (arguments_) => exportProjectToPlatformArgumentsSchema.parse(arguments_),
      exportService,
    );
    registrar.handle(
      'cancel-export',
      (arguments_) => cancelPlatformExportArgumentsSchema.parse(arguments_),
      cancelService,
    );
    registrar.handle(
      'inspect-template',
      (arguments_) => inspectPlayerTemplateArgumentsSchema.parse(arguments_),
      inspectService,
    );
    registrar.handle(
      'install-template',
      (arguments_) => installPlayerTemplateArgumentsSchema.parse(arguments_),
      installService,
    );
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const request = {
      project: createAuthoringProject({ name: 'Export' }),
      profileId: 'linux-release',
      outputDirectory: '/exports/story',
    };

    await expect(
      ipcMain.invoke('platform-export', harness.event, sessionId, request),
    ).resolves.toBe(sessionId);
    await expect(
      ipcMain.invoke('cancel-export', harness.event, sessionId, 'editor-export-1'),
    ).resolves.toBe(sessionId);
    await expect(
      ipcMain.invoke('inspect-template', harness.event, 'linux-x64', 'build-1'),
    ).resolves.toBe('linux-x64');
    await expect(
      ipcMain.invoke('install-template', harness.event, { archivePath: '/tmp/template.tar' }),
    ).resolves.toEqual({ archivePath: '/tmp/template.tar' });

    for (const [channel, arguments_] of [
      ['platform-export', [sessionId, { ...request, projectRoot: '/alternate-project' }]],
      ['platform-export', [sessionId, { ...request, projectPath: '/alternate/project.json' }]],
      ['cancel-export', ['not-a-session', 'editor-export-1']],
      ['inspect-template', ['x'.repeat(513), 'build-1']],
      ['install-template', [{ archivePath: '/tmp/template.tar', unexpected: true }]],
      ['install-template', [{ archivePath: 'x'.repeat(32_769) }]],
    ] as const) {
      exportService.mockClear();
      cancelService.mockClear();
      inspectService.mockClear();
      installService.mockClear();
      await expect(ipcMain.invoke(channel, harness.event, ...arguments_)).rejects.toSatisfy(
        (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.INVALID_REQUEST,
      );
      expect(exportService).not.toHaveBeenCalled();
      expect(cancelService).not.toHaveBeenCalled();
      expect(inspectService).not.toHaveBeenCalled();
      expect(installService).not.toHaveBeenCalled();
    }

    const other = trustedHarness();
    await expect(
      ipcMain.invoke('platform-export', other.event, sessionId, request),
    ).rejects.toSatisfy(
      (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.UNTRUSTED_SENDER,
    );
    expect(exportService).not.toHaveBeenCalled();
  });

  it('strictly guards ComfyUI control, workflow, and generation requests before side effects', async () => {
    const ipcMain = new FakeIpcMain();
    const harness = trustedHarness();
    const configService = vi.fn((config: unknown) => config);
    const listService = vi.fn(
      (projectSessionId: string | null, _request: unknown) => projectSessionId,
    );
    const generateService = vi.fn(
      (projectSessionId: string, _config: unknown, _request: unknown) => projectSessionId,
    );
    const editService = vi.fn(
      (projectSessionId: string, _config: unknown, _request: unknown) => projectSessionId,
    );
    const registrar = createGuardedIpcRegistrar({
      ipcMain,
      getOwner: () => harness.window,
      documentPolicy: createEditorDocumentPolicy(),
    });
    registrar.handle(
      'comfy-config',
      (arguments_) => comfyUiConfigArgumentsSchema.parse(arguments_),
      configService,
    );
    registrar.handle(
      'comfy-list',
      (arguments_) => comfyUiListWorkflowLibraryArgumentsSchema.parse(arguments_),
      listService,
    );
    registrar.handle(
      'comfy-generate',
      (arguments_) => comfyUiGenerateImageArgumentsSchema.parse(arguments_),
      generateService,
    );
    registrar.handle(
      'comfy-edit',
      (arguments_) => comfyUiEditImageArgumentsSchema.parse(arguments_),
      editService,
    );

    const sessionId = '11111111-1111-4111-8111-111111111111';
    const config = {
      enabled: true,
      serverUrl: 'http://127.0.0.1:8188',
      defaultWorkflows: { 'image.generate': 'image-generate' },
      requestTimeoutMs: 15_000,
      connectionCheckIntervalMs: 10_000,
    };

    await expect(ipcMain.invoke('comfy-config', harness.event, config)).resolves.toEqual(config);
    await expect(
      ipcMain.invoke('comfy-list', harness.event, sessionId, { includeOverridden: true }),
    ).resolves.toBe(sessionId);
    await expect(
      ipcMain.invoke('comfy-generate', harness.event, sessionId, config, {
        workflowId: 'image-generate',
        prompt: 'tea house',
        width: 1024,
        height: 1024,
        steps: 20,
        cfg: 7.5,
      }),
    ).resolves.toBe(sessionId);
    await expect(
      ipcMain.invoke('comfy-edit', harness.event, sessionId, config, {
        workflowId: 'image-edit',
        sourceAssetId: 'source-image',
        prompt: 'make it night',
        steps: 4,
      }),
    ).resolves.toBe(sessionId);

    for (const [channel, arguments_] of [
      ['comfy-config', [{ ...config, serverUrl: 'file:///tmp/comfy' }]],
      ['comfy-config', [{ ...config, requestTimeoutMs: Number.POSITIVE_INFINITY }]],
      ['comfy-list', [sessionId, { includeOverridden: true, projectFilePath: '/alternate' }]],
      [
        'comfy-generate',
        [sessionId, config, { workflowId: 'image-generate', prompt: 'tea', cfg: Number.NaN }],
      ],
      [
        'comfy-generate',
        [sessionId, config, { workflowId: 'image-generate', prompt: 'x'.repeat(65_537) }],
      ],
      ['comfy-generate', [sessionId, config, { workflowId: 'é'.repeat(129), prompt: 'tea' }]],
      [
        'comfy-generate',
        [sessionId, config, { workflowId: 'image-generate', prompt: 'é'.repeat(32_769) }],
      ],
      [
        'comfy-generate',
        [
          sessionId,
          config,
          { workflowId: 'image-generate', prompt: 'tea', projectFilePath: '/alternate' },
        ],
      ],
      [
        'comfy-edit',
        [
          sessionId,
          config,
          {
            workflowId: 'image-edit',
            sourceAssetId: 'source-image',
            sourceProjectRelativePath: 'assets/images/source.png',
            prompt: 'night',
          },
        ],
      ],
      [
        'comfy-edit',
        [
          sessionId,
          { ...config, serverUrl: 'http://192.168.1.50:8188' },
          {
            workflowId: 'image-edit',
            sourceAssetId: 'source-image',
            projectFilePath: '/alternate/project.json',
            prompt: 'night',
          },
        ],
      ],
    ] as const) {
      configService.mockClear();
      listService.mockClear();
      generateService.mockClear();
      editService.mockClear();
      await expect(ipcMain.invoke(channel, harness.event, ...arguments_)).rejects.toSatisfy(
        (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.INVALID_REQUEST,
      );
      expect(configService).not.toHaveBeenCalled();
      expect(listService).not.toHaveBeenCalled();
      expect(generateService).not.toHaveBeenCalled();
      expect(editService).not.toHaveBeenCalled();
    }

    const other = trustedHarness();
    await expect(
      ipcMain.invoke('comfy-generate', other.event, sessionId, config, {
        workflowId: 'image-generate',
        prompt: 'tea house',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.UNTRUSTED_SENDER,
    );
    expect(generateService).not.toHaveBeenCalled();
  });

  it('admits current shared-user ComfyUI workflow keys and rejects the retired editor source', () => {
    expect(
      comfyUiCopyWorkflowArgumentsSchema.safeParse([
        null,
        { workflowKey: 'user:custom.manifest.json', targetSource: 'project' },
      ]).success,
    ).toBe(true);
    expect(
      comfyUiCopyWorkflowArgumentsSchema.safeParse([
        null,
        { workflowKey: 'editor:custom.manifest.json', targetSource: 'project' },
      ]).success,
    ).toBe(false);
  });

  it('admits only shared ComfyUI machine settings through the user-config IPC contract', () => {
    const shared = {
      serverUrl: 'http://127.0.0.1:8188',
      requestTimeoutMs: 15_000,
      defaultWorkflows: {
        'image.generate': 'image-generate',
        'audio.generate': 'audio-generate',
      },
    };
    expect(comfyUiUserConfigArgumentsSchema.safeParse([shared]).success).toBe(true);
    expect(
      comfyUiUserConfigArgumentsSchema.safeParse([{ ...shared, defaultWorkflowId: 'retired' }])
        .success,
    ).toBe(false);
    expect(comfyUiUserConfigArgumentsSchema.safeParse([{ ...shared, enabled: true }]).success).toBe(
      false,
    );
    expect(
      comfyUiUserConfigArgumentsSchema.safeParse([{ ...shared, connectionCheckIntervalMs: 10_000 }])
        .success,
    ).toBe(false);
  });

  it('rejects malformed or oversized nested ComfyUI workflow manifests at the IPC parser', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    expect(
      comfyUiImportWorkflowArgumentsSchema.safeParse([
        {
          workflowFileName: 'custom.workflow.json',
          manifestFileName: 'custom.manifest.json',
          workflowJsonText: '{}',
          manifest: {},
          overwrite: false,
        },
      ]).success,
    ).toBe(false);
    expect(
      comfyUiRepairWorkflowArgumentsSchema.safeParse([
        sessionId,
        {
          workflowKey: 'project:custom.manifest.json',
          manifest: { unexpected: 'x'.repeat(1024 * 1024) },
          overwrite: true,
        },
      ]).success,
    ).toBe(false);
  });

  it('strictly admits bounded app, window, dialog, and shell requests before side effects', async () => {
    const ipcMain = new FakeIpcMain();
    const harness = trustedHarness();
    const noArgumentService = vi.fn(() => 'app-info');
    const revealService = vi.fn((itemPath: string) => itemPath);
    const externalService = vi.fn((url: string) => url);
    const packageDialogService = vi.fn((defaultPath: string | null) => defaultPath);
    const frameService = vi.fn((nativeFrame: boolean) => nativeFrame);
    const registrar = createGuardedIpcRegistrar({
      ipcMain,
      getOwner: () => harness.window,
      documentPolicy: createEditorDocumentPolicy(),
    });

    registrar.handle(
      'app-info',
      (arguments_) => noArgumentsSchema.parse(arguments_),
      noArgumentService,
    );
    registrar.handle(
      'show-item',
      (arguments_) => showItemInFolderArgumentsSchema.parse(arguments_),
      revealService,
    );
    registrar.handle(
      'open-external',
      (arguments_) => openExternalArgumentsSchema.parse(arguments_),
      externalService,
    );
    registrar.handle(
      'package-dialog',
      (arguments_) => selectPackageOutputPathArgumentsSchema.parse(arguments_),
      packageDialogService,
    );
    registrar.handle(
      'set-frame',
      (arguments_) => setNativeWindowFrameArgumentsSchema.parse(arguments_),
      frameService,
    );

    await expect(ipcMain.invoke('app-info', harness.event)).resolves.toBe('app-info');
    await expect(
      ipcMain.invoke('show-item', harness.event, '/projects/story/image.png'),
    ).resolves.toBe('/projects/story/image.png');
    await expect(
      ipcMain.invoke('open-external', harness.event, 'https://example.com/docs'),
    ).resolves.toBe('https://example.com/docs');
    await expect(ipcMain.invoke('package-dialog', harness.event, null)).resolves.toBeNull();
    await expect(ipcMain.invoke('set-frame', harness.event, true)).resolves.toBe(true);

    for (const [channel, arguments_] of [
      ['app-info', [NaN]],
      ['app-info', [Number.POSITIVE_INFINITY]],
      ['show-item', ['']],
      ['show-item', ['x'.repeat(32_769)]],
      ['show-item', ['/projects/story/image.png', 'extra']],
      ['open-external', ['not a url']],
      ['open-external', ['file:///tmp/secret.txt']],
      ['open-external', ['javascript:alert(1)']],
      ['open-external', ['mailto:user@example.com']],
      ['open-external', ['https://example.com/', 'extra']],
      ['package-dialog', []],
      ['package-dialog', ['x'.repeat(32_769)]],
      ['set-frame', [1]],
      ['set-frame', [true, false]],
    ] as const) {
      noArgumentService.mockClear();
      revealService.mockClear();
      externalService.mockClear();
      packageDialogService.mockClear();
      frameService.mockClear();

      await expect(ipcMain.invoke(channel, harness.event, ...arguments_)).rejects.toSatisfy(
        (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.INVALID_REQUEST,
      );
      expect(noArgumentService).not.toHaveBeenCalled();
      expect(revealService).not.toHaveBeenCalled();
      expect(externalService).not.toHaveBeenCalled();
      expect(packageDialogService).not.toHaveBeenCalled();
      expect(frameService).not.toHaveBeenCalled();
    }

    const other = trustedHarness();
    await expect(
      ipcMain.invoke('open-external', other.event, 'https://example.com/docs'),
    ).rejects.toSatisfy(
      (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.UNTRUSTED_SENDER,
    );
    expect(externalService).not.toHaveBeenCalled();
  });

  it('accepts the owning live packaged top-level frame and parses before calling the service', async () => {
    const ipcMain = new FakeIpcMain();
    const harness = trustedHarness();
    const parse = vi.fn((arguments_: unknown[]) =>
      selectDirectoryArgumentsSchema.parse(arguments_),
    );
    const service = vi.fn((options: { title?: string; defaultPath?: string | null }) => options);
    const registrar = createGuardedIpcRegistrar({
      ipcMain,
      getOwner: () => harness.window,
      documentPolicy: createEditorDocumentPolicy(),
    });
    registrar.handle('select-directory', parse, service);

    await expect(
      ipcMain.invoke('select-directory', harness.event, {
        title: 'Choose a Project folder',
        defaultPath: null,
      }),
    ).resolves.toEqual({ title: 'Choose a Project folder', defaultPath: null });
    expect(parse).toHaveBeenCalledOnce();
    expect(service).toHaveBeenCalledOnce();
  });

  it('accepts only the explicitly configured development origin', async () => {
    const ipcMain = new FakeIpcMain();
    const harness = trustedHarness('http://localhost:5174/workbench');
    const service = vi.fn((_options: { title?: string; defaultPath?: string | null }) => 'ok');
    createGuardedIpcRegistrar({
      ipcMain,
      getOwner: () => harness.window,
      documentPolicy: createEditorDocumentPolicy('http://localhost:5174/'),
    }).handle(
      'dev-call',
      (arguments_) => selectDirectoryArgumentsSchema.parse(arguments_),
      service,
    );

    await expect(ipcMain.invoke('dev-call', harness.event, {})).resolves.toBe('ok');

    harness.mainFrame.url = 'http://localhost:5175/workbench';
    await expect(ipcMain.invoke('dev-call', harness.event, {})).rejects.toSatisfy(
      (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.UNTRUSTED_SENDER,
    );
    expect(service).toHaveBeenCalledOnce();
  });

  it.each(['https://example.test/', 'http://example.test:5174/', 'file:///tmp/editor/'])(
    'rejects a configured non-loopback development document: %s',
    (developmentUrl: string) => {
      expect(() => createEditorDocumentPolicy(developmentUrl)).toThrow(
        'Invalid configured editor development URL',
      );
    },
  );

  it.each([
    'different WebContents',
    'destroyed owner window',
    'destroyed owning WebContents',
    'detached current frame',
    'same-origin child frame',
    'remote child frame',
    'stale top-level frame',
    'wrong packaged host',
    'file URL',
    'malformed URL',
  ])('rejects an untrusted sender: %s', async (scenario: string) => {
    const ipcMain = new FakeIpcMain();
    const harness = trustedHarness();
    const parse = vi.fn((arguments_: unknown[]) => arguments_ as []);
    const service = vi.fn(() => 'should not run');
    createGuardedIpcRegistrar({
      ipcMain,
      getOwner: () => harness.window,
      documentPolicy: createEditorDocumentPolicy(),
    }).handle('privileged-call', parse, service);

    let event = harness.event;
    if (scenario === 'different WebContents') {
      const other = trustedHarness();
      event = other.event;
    } else if (scenario === 'destroyed owner window') {
      harness.window.destroyed = true;
    } else if (scenario === 'destroyed owning WebContents') {
      harness.webContents.destroyed = true;
    } else if (scenario === 'detached current frame') {
      harness.mainFrame.detached = true;
    } else if (scenario === 'same-origin child frame') {
      event = { ...event, senderFrame: frame('noveltea-editor://app/embedded.html') };
    } else if (scenario === 'remote child frame') {
      event = { ...event, senderFrame: frame('https://example.com/embedded.html') };
    } else if (scenario === 'stale top-level frame') {
      harness.webContents.mainFrame = frame('noveltea-editor://app/index.html');
    } else if (scenario === 'wrong packaged host') {
      harness.mainFrame.url = 'noveltea-editor://evil/index.html';
    } else if (scenario === 'file URL') {
      harness.mainFrame.url = 'file:///tmp/index.html';
    } else {
      harness.mainFrame.url = 'not a URL';
    }

    await expect(ipcMain.invoke('privileged-call', event)).rejects.toSatisfy(
      (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.UNTRUSTED_SENDER,
    );
    expect(parse).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
  });

  it.each([
    ['missing options', []],
    ['malformed options', [{ title: 42 }]],
    ['extra object field', [{ title: 'Choose', unexpected: true }]],
    ['extra positional argument', [{}, 'unexpected']],
  ])(
    'rejects invalid request arguments before the service runs: %s',
    async (_name: string, arguments_: unknown[]) => {
      const ipcMain = new FakeIpcMain();
      const harness = trustedHarness();
      const service = vi.fn(
        (_options: { title?: string; defaultPath?: string | null }) => 'should not run',
      );
      createGuardedIpcRegistrar({
        ipcMain,
        getOwner: () => harness.window,
        documentPolicy: createEditorDocumentPolicy(),
      }).handle(
        'select-directory',
        (input) => selectDirectoryArgumentsSchema.parse(input),
        service,
      );

      await expect(
        ipcMain.invoke('select-directory', harness.event, ...arguments_),
      ).rejects.toSatisfy(
        (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.INVALID_REQUEST,
      );
      expect(service).not.toHaveBeenCalled();
    },
  );
});

describe('editor top-level navigation policy', () => {
  it.each([
    [undefined, 'noveltea-editor://app/index.html'],
    ['http://localhost:5174/', 'http://localhost:5174/'],
  ])(
    'allows the exact approved editor document',
    (developmentUrl: string | undefined, target: string) => {
      let listener: ((event: { url: string; preventDefault(): void }) => void) | undefined;
      const webContents = {
        onWillNavigate: vi.fn((next: (event: { url: string; preventDefault(): void }) => void) => {
          listener = next;
        }),
        onWillRedirect: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      };
      installEditorNavigationPolicy(webContents, createEditorDocumentPolicy(developmentUrl));
      const navigation = { isMainFrame: true, url: target, preventDefault: vi.fn() };

      listener?.(navigation);

      expect(navigation.preventDefault).not.toHaveBeenCalled();
    },
  );

  it.each([
    'noveltea-editor://evil/index.html',
    'noveltea-editor://app/other.html',
    'noveltea-editor://app/index.html?redirected=true',
    'https://example.com/',
    'javascript:alert(1)',
    'data:text/html,unexpected',
    'file:///tmp/index.html',
  ])('prevents navigation away from the packaged editor document: %s', (target: string) => {
    let listener: ((event: { url: string; preventDefault(): void }) => void) | undefined;
    const webContents = {
      onWillNavigate: vi.fn((next: (event: { url: string; preventDefault(): void }) => void) => {
        listener = next;
      }),
      onWillRedirect: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    installEditorNavigationPolicy(webContents, createEditorDocumentPolicy());
    const navigation = { isMainFrame: true, url: target, preventDefault: vi.fn() };

    listener?.(navigation);

    expect(navigation.preventDefault).toHaveBeenCalledOnce();
  });

  it('strictly guards Project persistence requests before persistence side effects', async () => {
    const ipcMain = new FakeIpcMain();
    const harness = trustedHarness();
    const saveContent = vi.fn((..._arguments: unknown[]) => 'content-saved');
    const saveMetadata = vi.fn((..._arguments: unknown[]) => 'metadata-saved');
    const saveCopy = vi.fn((..._arguments: unknown[]) => 'copy-saved');
    const registrar = createGuardedIpcRegistrar({
      ipcMain,
      getOwner: () => harness.window,
      documentPolicy: createEditorDocumentPolicy(),
    });
    registrar.handle(
      'save-content',
      (arguments_) => saveProjectContentArgumentsSchema.parse(arguments_),
      saveContent,
    );
    registrar.handle(
      'save-metadata',
      (arguments_) => saveProjectEditorMetadataArgumentsSchema.parse(arguments_),
      saveMetadata,
    );
    registrar.handle(
      'save-copy',
      (arguments_) => saveProjectCopyAsArgumentsSchema.parse(arguments_),
      saveCopy,
    );

    const sessionId = '11111111-1111-4111-8111-111111111111';
    const project = createAuthoringProject({ name: 'Persistence Boundary' });
    const editorState = emptyEditorProjectState();
    const contentRequest = {
      saveUnitIds: ['project:settings'],
      affectedPaths: ['/project/name'],
      baseValueByPath: { '/project/name': { exists: true, value: 'Before' } },
      localValueByPath: { '/project/name': { exists: true, value: 'Persistence Boundary' } },
      operationLabel: 'save project settings',
    };

    await expect(
      ipcMain.invoke('save-content', harness.event, sessionId, contentRequest, editorState),
    ).resolves.toBe('content-saved');
    await expect(
      ipcMain.invoke('save-metadata', harness.event, sessionId, editorState, {}),
    ).resolves.toBe('metadata-saved');
    await expect(
      ipcMain.invoke('save-copy', harness.event, sessionId, project, [], {}),
    ).resolves.toBe('copy-saved');

    for (const [channel, arguments_] of [
      ['save-content', [sessionId, contentRequest, editorState, 'extra']],
      ['save-metadata', [sessionId, { ...editorState, unexpected: true }, {}]],
      ['save-copy', [sessionId, project, ['../escape.png'], {}]],
    ] as const) {
      saveContent.mockClear();
      saveMetadata.mockClear();
      saveCopy.mockClear();
      await expect(ipcMain.invoke(channel, harness.event, ...arguments_)).rejects.toSatisfy(
        (error: unknown) => rejectionCode(error) === EDITOR_IPC_FAILURE.INVALID_REQUEST,
      );
      expect(saveContent).not.toHaveBeenCalled();
      expect(saveMetadata).not.toHaveBeenCalled();
      expect(saveCopy).not.toHaveBeenCalled();
    }
  });

  it('denies every new-window request', () => {
    const webContents = {
      onWillNavigate: vi.fn(),
      onWillRedirect: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    installEditorNavigationPolicy(webContents, createEditorDocumentPolicy());

    const handler = webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(handler?.()).toEqual({ action: 'deny' });
  });

  it('prevents redirects away from the approved editor document', () => {
    let redirectListener: ((event: { url: string; preventDefault(): void }) => void) | undefined;
    const webContents = {
      onWillNavigate: vi.fn(),
      onWillRedirect: vi.fn(
        (listener: (event: { url: string; preventDefault(): void }) => void) => {
          redirectListener = listener;
        },
      ),
      setWindowOpenHandler: vi.fn(),
    };
    installEditorNavigationPolicy(webContents, createEditorDocumentPolicy());
    const redirect = {
      isMainFrame: true,
      url: 'https://example.com/',
      preventDefault: vi.fn(),
    };

    redirectListener?.(redirect);

    expect(redirect.preventDefault).toHaveBeenCalledOnce();
  });

  it('allows redirects in child frames', () => {
    let redirectListener:
      | ((event: { isMainFrame: boolean; url: string; preventDefault(): void }) => void)
      | undefined;
    const webContents = {
      onWillNavigate: vi.fn(),
      onWillRedirect: vi.fn(
        (
          listener: (event: { isMainFrame: boolean; url: string; preventDefault(): void }) => void,
        ) => {
          redirectListener = listener;
        },
      ),
      setWindowOpenHandler: vi.fn(),
    };
    installEditorNavigationPolicy(webContents, createEditorDocumentPolicy());
    const redirect = {
      isMainFrame: false,
      url: 'http://127.0.0.1:9000/preview/',
      preventDefault: vi.fn(),
    };

    redirectListener?.(redirect);

    expect(redirect.preventDefault).not.toHaveBeenCalled();
  });
});

describe('renderer-visible IPC failures', () => {
  it.each(
    Object.values(EDITOR_IPC_FAILURE).flatMap((code) => [
      [code, `Error invoking remote method 'noveltea:select-directory': Error: ${code}`],
      [
        code,
        `Error invoking remote method 'noveltea:select-directory': EditorIpcBoundaryError: ${code}`,
      ],
    ]),
  )('normalizes Electron serialized boundary failure %s', (code, serializedMessage) => {
    const serialized = new Error(serializedMessage);

    const normalized = normalizeEditorIpcBoundaryError(serialized);

    expect(normalized).toMatchObject({ name: 'EditorIpcBoundaryError', code, message: code });
  });

  it('does not replace unrelated service failures', () => {
    const failure = new Error('service failed');
    expect(normalizeEditorIpcBoundaryError(failure)).toBe(failure);
  });
});
