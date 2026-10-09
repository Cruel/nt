import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vite-plus/test';

function createRuntimeLoadHarness() {
  const widget = fs.readFileSync(path.resolve('../web/widget.html'), 'utf8');
  const start = widget.indexOf('async function loadCompiledProject(message) {');
  const end = widget.indexOf('\n    function invokeNativeCommand', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const implementation = widget.slice(start, end);

  const messages: Record<string, unknown>[] = [];
  const stagedFiles: Array<[string, string]> = [];
  const removedFiles: string[] = [];
  const context = {
    protocolVersion: 1,
    latestNativeErrorDiagnostic: null as null | Record<string, unknown>,
    nativeExportAvailable: () => true,
    moduleFileSystem: () => ({
      mkdirTree() {},
      writeFile(file: string, contents: string) {
        stagedFiles.push([file, contents]);
      },
      unlink(file: string) {
        removedFiles.push(file);
      },
    }),
    safeProjectAssetPath: () => true,
    stageProjectAsset: async () => true,
    editorCompiledProjectPath: '/assets/project/compiled-project.json',
    editorCompiledProjectLogicalPath: 'project:/compiled-project.json',
    Module: {
      ccall() {
        const diagnostic = {
          severity: 'error',
          category: 'runtime',
          message:
            'compiled_project.hotspot_source_image_required: Interactable hotspots require a sprite image Asset.',
        };
        context.send({ version: 1, type: 'preview-diagnostic', diagnostic });
        return 0;
      },
    },
    send(message: Record<string, unknown>) {
      messages.push(message);
      if (
        message.type === 'preview-diagnostic' &&
        (message.diagnostic as { severity?: string } | undefined)?.severity === 'error'
      )
        context.latestNativeErrorDiagnostic = message.diagnostic as Record<string, unknown>;
    },
    displayedFailure: '',
    failCommand(_message: unknown, reason: string) {
      context.displayedFailure = reason;
    },
    showFailure(reason: string) {
      context.displayedFailure = reason;
    },
    hideFailure() {},
    emitRuntimeDebugSnapshot() {},
    loadCompiledProject: null as null | ((message: Record<string, unknown>) => Promise<void>),
  };

  vm.runInNewContext(`${implementation}\nloadCompiledProject = loadCompiledProject;`, context);
  if (!context.loadCompiledProject) throw new Error('Runtime load harness did not load.');
  return {
    context,
    messages,
    stagedFiles,
    removedFiles,
    loadCompiledProject: context.loadCompiledProject,
  };
}

function createRuntimeDebugHarness() {
  const widget = fs.readFileSync(path.resolve('../web/widget.html'), 'utf8');
  const start = widget.indexOf('function readRuntimeDebugSnapshot(message, failOnError) {');
  const end = widget.indexOf('\n    function canonicalUnsignedDecimal', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const implementation = widget.slice(start, end);
  const diagnostics: Record<string, unknown>[] = [];
  const context = {
    nativeExportAvailable: () => true,
    Module: { ccall: () => '' },
    failCommand() {},
    emitDiagnostic(_message: unknown, diagnostic: Record<string, unknown>) {
      diagnostics.push(diagnostic);
    },
    port: {},
    engineReady: true,
    runtimeReady: true,
    previewActivityActive: true,
    previewActivityVisible: true,
    lastRuntimeDebugFingerprint: '',
    runtimeDebugFingerprint: null as null | ((snapshot: Record<string, unknown>) => string),
    send() {},
    readRuntimeDebugSnapshot: null as null | ((message: unknown, failOnError: boolean) => unknown),
    publishRuntimeDebugSnapshotIfChanged: null as null | (() => void),
  };
  vm.runInNewContext(
    `${implementation}\nthis.readRuntimeDebugSnapshot = readRuntimeDebugSnapshot; this.runtimeDebugFingerprint = runtimeDebugFingerprint; this.publishRuntimeDebugSnapshotIfChanged = publishRuntimeDebugSnapshotIfChanged;`,
    context,
  );
  if (
    !context.readRuntimeDebugSnapshot ||
    !context.runtimeDebugFingerprint ||
    !context.publishRuntimeDebugSnapshotIfChanged
  )
    throw new Error('Runtime debug harness did not load.');
  return { context, diagnostics };
}

function createDevtoolsHarness() {
  const widget = fs.readFileSync(path.resolve('../web/widget.html'), 'utf8');
  const start = widget.indexOf('function readDevtoolsCapabilities() {');
  const end = widget.indexOf('\n    function runtimeDebugFingerprint', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const implementation = widget.slice(start, end);
  const messages: Record<string, unknown>[] = [];
  const snapshot = {
    host: {
      platform: 'SDL3',
      renderer: 'WebGL',
      hostGeneration: 2,
      surface: {
        logicalWidth: 640,
        logicalHeight: 360,
        framebufferWidth: 640,
        framebufferHeight: 360,
        framebufferScaleX: 1,
        framebufferScaleY: 1,
      },
    },
    input: {
      referenceX: 100,
      referenceY: 80,
      pointerValid: true,
      lastEvent: 'mouse-motion',
      debugProcessed: false,
      debugConsumed: false,
      runtimeUiProcessed: true,
      runtimeUiConsumed: false,
      runtimeUiWantsPointer: false,
      gameplayEvent: true,
      gameplayAdmitted: true,
      gameplayBlockReason: 'none',
      governingLayout: null,
      governingLayoutMode: 'none',
    },
    rmlui: [],
    rmluiDebugger: { available: true, visible: false, context: 'runtime-ui' },
    world: {
      referenceX: 100,
      referenceY: 80,
      pointerValid: true,
      captureActive: false,
      underPointer: null,
      hovered: null,
      pressed: null,
      hotspots: [],
    },
    tooling: {
      previewRunning: true,
      renderPerfLogging: false,
      nativeDebugUiAvailable: false,
      nativeDebugUiEnabled: false,
    },
    runtime: null,
  };
  const context = {
    protocolVersion: 1,
    nativeExportAvailable: (name: string): boolean =>
      name === 'noveltea_devtools_set_rmlui_debugger' ||
      name === 'noveltea_devtools_capabilities' ||
      name === 'noveltea_devtools_snapshot' ||
      name === 'noveltea_devtools_debug_report' ||
      name === 'noveltea_devtools_console_delta' ||
      name === 'noveltea_devtools_console_clear' ||
      name === 'noveltea_devtools_trace_delta' ||
      name === 'noveltea_devtools_trace_clear',
    Module: {
      ccall(name: string, _returnType?: string, _argTypes?: string[], args?: unknown[]) {
        if (name === 'noveltea_devtools_capabilities')
          return JSON.stringify([
            'devtools-snapshot-v1',
            'devtools-console-v1',
            'devtools-trace-v1',
            'devtools-debug-report-v1',
            'runtime-debug-snapshot-v1',
          ]);
        if (name === 'noveltea_devtools_set_rmlui_debugger') {
          if (args?.[1] !== 'runtime-ui') return 0;
          snapshot.rmluiDebugger.visible = args[0] === 1;
          return 1;
        }
        if (name === 'noveltea_devtools_snapshot') return JSON.stringify(snapshot);
        if (name === 'noveltea_devtools_debug_report')
          return JSON.stringify({
            formatVersion: 1,
            build: {
              engineVersion: '1.0.0',
              buildConfiguration: 'RelWithDebInfo',
              targetPlatform: 'Emscripten',
              hostPlatform: 'SDL3',
              renderer: 'WebGL',
            },
            capabilities: [
              'devtools-snapshot-v1',
              'devtools-console-v1',
              'devtools-trace-v1',
              'devtools-debug-report-v1',
            ],
            snapshot,
            diagnostics: [],
            rmlui: { contexts: snapshot.rmlui, debugger: snapshot.rmluiDebugger },
            console: {
              afterSequence: '0',
              earliestRetainedSequence: '2',
              latestSequence: '4',
              lostRecordCount: '1',
              historyGap: true,
              records: [],
            },
            trace: {
              afterSequence: '0',
              earliestRetainedSequence: '1',
              latestSequence: '5',
              lostRecordCount: '0',
              historyGap: false,
              records: [],
            },
          });
        if (name === 'noveltea_devtools_console_delta')
          return JSON.stringify({
            afterSequence: args?.[0] ?? '0',
            earliestRetainedSequence: '1',
            latestSequence: '2',
            lostRecordCount: '0',
            historyGap: false,
            records: [
              {
                sequence: '2',
                globalSequence: '6',
                hostGeneration: '1',
                runtimeGeneration: '4',
                frame: '9',
                severity: 'info',
                category: 'lua',
                message: 'hello',
                source: { chunk: 'test.lua', line: 3 },
                generationMarker: false,
              },
            ],
          });
        if (name === 'noveltea_devtools_console_clear')
          return JSON.stringify({ latestSequence: '2' });
        if (name === 'noveltea_devtools_trace_delta')
          return JSON.stringify({
            afterSequence: args?.[0] ?? '0',
            earliestRetainedSequence: '1',
            latestSequence: '5',
            lostRecordCount: '0',
            historyGap: false,
            records: [
              {
                sequence: '5',
                firstSequence: '4',
                globalSequence: '7',
                firstGlobalSequence: '6',
                hostGeneration: '1',
                runtimeGeneration: '4',
                kind: 'input-routing',
                category: 'input',
                repeatCount: 2,
                firstFrame: '10',
                lastFrame: '11',
                input: null,
                debuggerMutation: null,
                detail: '',
                generationMarker: false,
              },
            ],
          });
        if (name === 'noveltea_devtools_trace_clear')
          return JSON.stringify({ latestSequence: '5' });
        return '';
      },
    },
    port: {},
    engineReady: true,
    runtimeReady: true,
    previewActivityActive: true,
    previewActivityVisible: true,
    lastDevtoolsConsoleSequence: '0',
    lastDevtoolsTraceSequence: '0',
    failCommand() {},
    send(message: Record<string, unknown>) {
      messages.push(message);
    },
    readDevtoolsCapabilities: null as null | (() => string[]),
    emitDevtoolsSnapshot: null as null | ((message: Record<string, unknown>) => boolean),
    emitDevtoolsDebugReport: null as null | ((message: Record<string, unknown>) => boolean),
    publishDevtoolsConsoleDelta: null as null | (() => void),
    clearDevtoolsConsole: null as null | ((message: Record<string, unknown>) => void),
    publishDevtoolsTraceDelta: null as null | (() => void),
    clearDevtoolsTrace: null as null | ((message: Record<string, unknown>) => void),
    setRmlUiDebugger: null as null | ((message: Record<string, unknown>) => void),
  };
  vm.runInNewContext(
    `${implementation}\nthis.readDevtoolsCapabilities = readDevtoolsCapabilities; this.emitDevtoolsSnapshot = emitDevtoolsSnapshot; this.emitDevtoolsDebugReport = emitDevtoolsDebugReport; this.publishDevtoolsConsoleDelta = publishDevtoolsConsoleDelta; this.clearDevtoolsConsole = clearDevtoolsConsole; this.publishDevtoolsTraceDelta = publishDevtoolsTraceDelta; this.clearDevtoolsTrace = clearDevtoolsTrace; this.setRmlUiDebugger = setRmlUiDebugger;`,
    context,
  );
  if (
    !context.readDevtoolsCapabilities ||
    !context.emitDevtoolsSnapshot ||
    !context.emitDevtoolsDebugReport ||
    !context.publishDevtoolsConsoleDelta ||
    !context.clearDevtoolsConsole ||
    !context.publishDevtoolsTraceDelta ||
    !context.clearDevtoolsTrace
  )
    throw new Error('Devtools harness did not load.');
  return { context, messages, snapshot };
}

describe('preview widget runtime project loading', () => {
  it('advertises engine-owned devtools capabilities and emits the canonical Devtools Snapshot', () => {
    const harness = createDevtoolsHarness();

    expect(harness.context.readDevtoolsCapabilities!()).toEqual([
      'devtools-snapshot-v1',
      'devtools-console-v1',
      'devtools-trace-v1',
      'devtools-debug-report-v1',
      'runtime-debug-snapshot-v1',
    ]);
    expect(harness.context.emitDevtoolsSnapshot!({ requestId: 'snapshot-1' })).toBe(true);
    expect(harness.messages).toEqual([
      {
        version: 1,
        type: 'devtools-snapshot',
        requestId: 'snapshot-1',
        snapshot: harness.snapshot,
      },
    ]);
  });

  it('exports one structured debug report from the native devtools data plane', () => {
    const harness = createDevtoolsHarness();

    expect(harness.context.emitDevtoolsDebugReport!({ requestId: 'report-1' })).toBe(true);
    expect(harness.messages.at(-1)).toMatchObject({
      version: 1,
      type: 'devtools-debug-report',
      requestId: 'report-1',
      report: {
        formatVersion: 1,
        console: { afterSequence: '0', historyGap: true, lostRecordCount: '1' },
        trace: { afterSequence: '0', historyGap: false, lostRecordCount: '0' },
      },
    });
  });

  it('controls the native RmlUi debugger and publishes accepted state without ImGui', () => {
    const harness = createDevtoolsHarness();
    harness.context.setRmlUiDebugger!({ requestId: 'show', visible: true, context: 'runtime-ui' });
    expect(harness.snapshot.rmluiDebugger.visible).toBe(true);
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'command-result',
      requestId: 'show',
      ok: true,
    });
    harness.context.setRmlUiDebugger!({ requestId: 'hide', visible: false, context: 'runtime-ui' });
    expect(harness.snapshot.rmluiDebugger.visible).toBe(false);
    const messageCount = harness.messages.length;
    harness.context.setRmlUiDebugger!({ requestId: 'missing', visible: true, context: 'missing' });
    expect(harness.messages.length).toBe(messageCount);
    expect(harness.snapshot.rmluiDebugger.visible).toBe(false);
    harness.context.nativeExportAvailable = () => false;
    harness.context.setRmlUiDebugger!({
      requestId: 'disabled',
      visible: true,
      context: 'runtime-ui',
    });
    expect(harness.snapshot.rmluiDebugger.visible).toBe(false);
  });

  it('pushes sequenced Trace deltas and advances the native clear cursor', () => {
    const harness = createDevtoolsHarness();

    harness.context.publishDevtoolsTraceDelta!();
    expect(harness.messages.at(-1)).toEqual({
      version: 1,
      type: 'devtools-trace-delta',
      delta: expect.objectContaining({ latestSequence: '5' }),
    });
    expect(harness.context.lastDevtoolsTraceSequence).toBe('5');

    harness.context.clearDevtoolsTrace!({ requestId: 'clear-trace-1' });
    expect(harness.context.lastDevtoolsTraceSequence).toBe('5');
    expect(harness.messages.at(-1)).toEqual({
      version: 1,
      type: 'command-result',
      requestId: 'clear-trace-1',
      ok: true,
    });
  });

  it('pushes sequenced Console deltas and advances the native clear cursor', () => {
    const harness = createDevtoolsHarness();

    harness.context.publishDevtoolsConsoleDelta!();
    expect(harness.messages.at(-1)).toEqual({
      version: 1,
      type: 'devtools-console-delta',
      delta: expect.objectContaining({ latestSequence: '2' }),
    });
    expect(harness.context.lastDevtoolsConsoleSequence).toBe('2');

    harness.context.clearDevtoolsConsole!({ requestId: 'clear-1' });
    expect(harness.context.lastDevtoolsConsoleSequence).toBe('2');
    expect(harness.messages.at(-1)).toEqual({
      version: 1,
      type: 'command-result',
      requestId: 'clear-1',
      ok: true,
    });
  });

  it('does not spam diagnostics when passive runtime-debug polling has no snapshot yet', () => {
    const harness = createRuntimeDebugHarness();

    harness.context.publishRuntimeDebugSnapshotIfChanged!();
    harness.context.publishRuntimeDebugSnapshotIfChanged!();

    expect(harness.diagnostics).toEqual([]);
    harness.context.readRuntimeDebugSnapshot!({ requestId: 'explicit' }, false);
    expect(harness.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        category: 'runtime-debug-snapshot',
        message: 'Runtime debug snapshot is unavailable for the current preview session.',
      }),
    ]);
  });

  it('fingerprints checkpoint semantics immediately but quantizes replay time to whole seconds', () => {
    const harness = createRuntimeDebugHarness();
    const base = {
      loaded: true,
      running: true,
      waiting: {},
      availableInputs: {},
      variables: [],
      inventory: [],
      selectedSubjects: [],
      diagnostics: [],
      dialoguePresentation: {},
      saveSnapshot: {
        readinessRevision: 1,
        canCapture: false,
        issues: [{ reason: 5, code: 'barrier', message: 'barrier', hasBarrier: true }],
        retained: { revision: 1 },
        replayDistance: { structuralGenerations: 0, timeGenerations: 1, playTimeMs: 1200 },
      },
    };

    const fingerprint = harness.context.runtimeDebugFingerprint!;
    expect(
      fingerprint({
        ...base,
        saveSnapshot: {
          ...base.saveSnapshot,
          replayDistance: { ...base.saveSnapshot.replayDistance, playTimeMs: 1900 },
        },
      }),
    ).toBe(fingerprint(base));
    expect(
      fingerprint({
        ...base,
        saveSnapshot: {
          ...base.saveSnapshot,
          replayDistance: { ...base.saveSnapshot.replayDistance, playTimeMs: 2200 },
        },
      }),
    ).not.toBe(fingerprint(base));
    expect(
      fingerprint({
        ...base,
        saveSnapshot: { ...base.saveSnapshot, canCapture: true, issues: [] },
      }),
    ).not.toBe(fingerprint(base));
  });

  it('shows the native load diagnostic instead of replacing it with a generic failure', async () => {
    const harness = createRuntimeLoadHarness();

    await harness.loadCompiledProject({
      requestId: 'load-project',
      compiledProject: {},
      assets: [],
    });

    expect(harness.context.displayedFailure).toBe(
      'compiled_project.hotspot_source_image_required: Interactable hotspots require a sprite image Asset.',
    );
  });

  it('stages the prepared Project notice index into the native preview Asset namespace and clears stale indexes', async () => {
    const harness = createRuntimeLoadHarness();
    const noticeIndexText = '{"schema":"noveltea.project-notices","notices":[]}';
    await harness.loadCompiledProject({
      requestId: 'with-notices',
      compiledProject: {},
      noticeIndexText,
    });
    expect(harness.stagedFiles).toContainEqual([
      '/assets/project/licenses/index.json',
      noticeIndexText,
    ]);
    await harness.loadCompiledProject({ requestId: 'without-notices', compiledProject: {} });
    expect(harness.removedFiles).toContain('/assets/project/licenses/index.json');
  });
});
