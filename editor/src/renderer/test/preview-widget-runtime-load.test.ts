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

describe('preview widget runtime project loading', () => {
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
