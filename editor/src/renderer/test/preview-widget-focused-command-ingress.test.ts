import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vite-plus/test';

interface FocusedCommandHarness {
  enqueueCommand(message: Record<string, unknown>): void;
  stagingController(requestId: string): AbortController | undefined;
  applySequence(): number;
  queuedCommands(): Record<string, unknown>[];
}

function createFocusedCommandHarness(): FocusedCommandHarness {
  const widget = fs.readFileSync(path.resolve('../web/widget.html'), 'utf8');
  const start = widget.indexOf('function isFocusedEditorDocumentCommand(');
  const end = widget.indexOf('\n    function rejectSupersededFocusedCommand', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const implementation = widget.slice(start, end);
  const drainCommands = vi.fn();
  const context = {
    focusedApplySequence: 0,
    focusedActiveStagingController: null as AbortController | null,
    focusedStagingControllers: new Map<string, AbortController>(),
    commandQueue: [] as Record<string, unknown>[],
    AbortController,
    drainCommands,
    enqueue: null as FocusedCommandHarness['enqueueCommand'] | null,
    stagingController: null as FocusedCommandHarness['stagingController'] | null,
    applySequence: null as FocusedCommandHarness['applySequence'] | null,
    queuedCommands: null as FocusedCommandHarness['queuedCommands'] | null,
  };
  vm.runInNewContext(
    `${implementation}
enqueue = enqueueCommand;
stagingController = (requestId) => focusedStagingControllers.get(requestId);
applySequence = () => focusedApplySequence;
queuedCommands = () => [...commandQueue];`,
    context,
  );
  if (
    !context.enqueue ||
    !context.stagingController ||
    !context.applySequence ||
    !context.queuedCommands
  )
    throw new Error('Focused command ingress harness did not load.');
  return {
    enqueueCommand: context.enqueue,
    stagingController: context.stagingController,
    applySequence: context.applySequence,
    queuedCommands: context.queuedCommands,
  };
}

describe('preview widget focused command ingress', () => {
  it('passes the native no-audio argument for visual-only preview hosts', () => {
    const widget = fs.readFileSync(path.resolve('../web/widget.html'), 'utf8');
    expect(widget).toContain("args.push('--no-audio')");
  });

  it('supersedes and aborts focused staging as soon as a newer command arrives', () => {
    const harness = createFocusedCommandHarness();
    harness.enqueueCommand({
      version: 1,
      type: 'apply-focused-editor-document',
      requestId: 'layout-request',
      applySequence: 1,
    });
    const layoutController = harness.stagingController('layout-request');
    expect(layoutController?.signal.aborted).toBe(false);

    harness.enqueueCommand({
      version: 1,
      type: 'apply-focused-editor-document',
      requestId: 'room-request',
      applySequence: 2,
    });

    expect(layoutController?.signal.aborted).toBe(true);
    expect(harness.stagingController('room-request')?.signal.aborted).toBe(false);
    expect(harness.applySequence()).toBe(2);
    expect(harness.queuedCommands().map((message) => message.requestId)).toEqual([
      'layout-request',
      'room-request',
    ]);
  });

  it('routes MessageChannel commands through the superseding ingress helper', () => {
    const widget = fs.readFileSync(path.resolve('../web/widget.html'), 'utf8');
    expect(widget).toContain('enqueueCommand(event.data);');
  });
});
