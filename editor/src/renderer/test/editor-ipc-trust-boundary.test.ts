import { describe, expect, it, vi } from 'vite-plus/test';
import {
  compileShadersArgumentsSchema,
  createEditorDocumentPolicy,
  createGuardedIpcRegistrar,
  createProjectArgumentsSchema,
  installEditorNavigationPolicy,
  noArgumentsSchema,
  openExternalArgumentsSchema,
  openProjectArgumentsSchema,
  previewSessionArgumentsSchema,
  readProjectTextSourcesArgumentsSchema,
  selectPackageOutputPathArgumentsSchema,
  setNativeWindowFrameArgumentsSchema,
  showItemInFolderArgumentsSchema,
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
    const shaderProject = { schema: 'noveltea.shader-materials.v2', shaders: {}, materials: {} };

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
