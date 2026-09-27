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
  const context = {
    protocolVersion: 1,
    latestNativeErrorDiagnostic: null as null | Record<string, unknown>,
    nativeExportAvailable: () => true,
    moduleFileSystem: () => ({
      mkdirTree() {},
      writeFile() {},
      unlink() {},
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
  return { context, messages, loadCompiledProject: context.loadCompiledProject };
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
    runtimeDebugFingerprint: () => '',
    send() {},
    readRuntimeDebugSnapshot: null as null | ((message: unknown, failOnError: boolean) => unknown),
    publishRuntimeDebugSnapshotIfChanged: null as null | (() => void),
  };
  vm.runInNewContext(
    `${implementation}\nthis.readRuntimeDebugSnapshot = readRuntimeDebugSnapshot; this.publishRuntimeDebugSnapshotIfChanged = publishRuntimeDebugSnapshotIfChanged;`,
    context,
  );
  if (!context.readRuntimeDebugSnapshot || !context.publishRuntimeDebugSnapshotIfChanged)
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
    nativeExportAvailable: (name: string) =>
      name === 'noveltea_devtools_capabilities' || name === 'noveltea_devtools_snapshot',
    Module: {
      ccall(name: string) {
        if (name === 'noveltea_devtools_capabilities')
          return JSON.stringify(['devtools-snapshot-v1', 'runtime-debug-snapshot-v1']);
        if (name === 'noveltea_devtools_snapshot') return JSON.stringify(snapshot);
        return '';
      },
    },
    failCommand() {},
    send(message: Record<string, unknown>) {
      messages.push(message);
    },
    readDevtoolsCapabilities: null as null | (() => string[]),
    emitDevtoolsSnapshot: null as null | ((message: Record<string, unknown>) => boolean),
  };
  vm.runInNewContext(
    `${implementation}\nthis.readDevtoolsCapabilities = readDevtoolsCapabilities; this.emitDevtoolsSnapshot = emitDevtoolsSnapshot;`,
    context,
  );
  if (!context.readDevtoolsCapabilities || !context.emitDevtoolsSnapshot)
    throw new Error('Devtools harness did not load.');
  return { context, messages, snapshot };
}

describe('preview widget runtime project loading', () => {
  it('advertises engine-owned devtools capabilities and emits the canonical Devtools Snapshot', () => {
    const harness = createDevtoolsHarness();

    expect(harness.context.readDevtoolsCapabilities!()).toEqual([
      'devtools-snapshot-v1',
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
});
