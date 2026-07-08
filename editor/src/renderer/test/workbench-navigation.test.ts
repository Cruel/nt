import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSettingsTab } from '@/workbench/editor-registry';
import {
  clearWorkbenchRevealTargets,
  consumeWorkbenchRevealTarget,
  enqueueWorkbenchRevealTarget,
  navigateToWorkbenchTarget,
  peekWorkbenchRevealTarget,
  registerWorkbenchTargetHandler,
  workbenchResourceKey,
} from '@/workbench/workbench-navigation';
import { useWorkbenchStore } from '@/workbench/workbench-store';

describe('workbench navigation', () => {
  beforeEach(() => {
    useWorkbenchStore.getState().resetWorkbench();
    clearWorkbenchRevealTargets();
  });

  it('uses editor type and resource stable id as the navigation key', () => {
    expect(workbenchResourceKey(buildSettingsTab())).toBe('settings:utility:settings');
  });

  it('queues and consumes a target once', () => {
    const tab = buildSettingsTab();
    const queued = enqueueWorkbenchRevealTarget(tab, { id: 'settings.comfyui', flash: true });

    expect(peekWorkbenchRevealTarget(tab)).toEqual(queued);
    expect(consumeWorkbenchRevealTarget(tab)).toEqual(queued);
    expect(consumeWorkbenchRevealTarget(tab)).toBeNull();
  });

  it('reissues repeated requests for the same active tab', () => {
    const tab = buildSettingsTab();

    navigateToWorkbenchTarget({ tab, target: { id: 'settings.theme' } });
    const first = peekWorkbenchRevealTarget(tab);
    navigateToWorkbenchTarget({ tab, target: { id: 'settings.comfyui' } });
    const second = peekWorkbenchRevealTarget(tab);

    expect(first?.requestId).toBeGreaterThan(0);
    expect(second?.requestId).toBeGreaterThan(first?.requestId ?? 0);
    expect(second?.id).toBe('settings.comfyui');
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeTruthy();
  });

  it('registers and unregisters imperative target handlers', async () => {
    const { invokeWorkbenchTargetHandler } = await import('@/workbench/workbench-navigation');
    const handler = vi.fn(() => true);
    const dispose = registerWorkbenchTargetHandler('tab:settings', 'settings.comfyui', handler);

    expect(invokeWorkbenchTargetHandler('tab:settings', { id: 'settings.comfyui', requestId: 1 })).toBe(true);
    expect(handler).toHaveBeenCalledWith({ id: 'settings.comfyui', requestId: 1 });

    dispose();
    expect(invokeWorkbenchTargetHandler('tab:settings', { id: 'settings.comfyui', requestId: 2 })).toBe(false);
  });
});
