import { describe, expect, it, vi } from 'vite-plus/test';
import { TerminalNotificationService } from '../../main/services/terminal-notification-service';

describe('TerminalNotificationService', () => {
  it('shows privacy-safe localized attention notifications only when supported and the window is unfocused', async () => {
    const clickHandlers: Array<() => void> = [];
    const show = vi.fn();
    const restore = vi.fn();
    const showWindow = vi.fn();
    const focus = vi.fn();
    const emitClick = vi.fn();
    const createNotification = vi.fn((_options: { title: string; body: string }) => ({
      show,
      onClick(callback: () => void) {
        clickHandlers.push(callback);
      },
      onClose() {},
    }));
    const service = new TerminalNotificationService({
      isSupported: () => true,
      isWindowFocused: () => false,
      resolveSessionLabel: (sessionId) => (sessionId === 'session-1' ? 'Terminal 2' : null),
      resolveContent: (label, kind) => ({
        title: 'NovelTea',
        body:
          kind === 'command-completed'
            ? `localized ${label} completed`
            : `localized ${label} attention`,
      }),
      createNotification,
      restoreWindow: restore,
      showWindow,
      focusWindow: focus,
      emitClick,
    });

    await expect(service.show({ sessionId: 'session-1', kind: 'command-completed' })).resolves.toBe(
      true,
    );
    await expect(service.show({ sessionId: 'session-1', kind: 'bell' })).resolves.toBe(true);
    expect(show).toHaveBeenCalledTimes(2);
    expect(createNotification).toHaveBeenNthCalledWith(1, {
      title: 'NovelTea',
      body: 'localized Terminal 2 completed',
    });
    expect(createNotification).toHaveBeenNthCalledWith(2, {
      title: 'NovelTea',
      body: 'localized Terminal 2 attention',
    });

    clickHandlers[1]?.();
    expect(restore).toHaveBeenCalledOnce();
    expect(showWindow).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(emitClick).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });

  it('degrades silently when unsupported, focused, or the session is stale', async () => {
    const createNotification = vi.fn();
    const base = {
      resolveSessionLabel: () => 'Terminal 1',
      resolveContent: () => ({ title: 'NovelTea', body: 'localized attention' }),
      createNotification,
      restoreWindow: vi.fn(),
      showWindow: vi.fn(),
      focusWindow: vi.fn(),
      emitClick: vi.fn(),
    };

    await expect(
      new TerminalNotificationService({
        ...base,
        isSupported: () => false,
        isWindowFocused: () => false,
      }).show({ sessionId: 'session-1', kind: 'bell' }),
    ).resolves.toBe(false);
    await expect(
      new TerminalNotificationService({
        ...base,
        isSupported: () => true,
        isWindowFocused: () => true,
      }).show({ sessionId: 'session-1', kind: 'bell' }),
    ).resolves.toBe(false);
    await expect(
      new TerminalNotificationService({
        ...base,
        isSupported: () => true,
        isWindowFocused: () => false,
        resolveSessionLabel: () => null,
      }).show({ sessionId: 'session-1', kind: 'bell' }),
    ).resolves.toBe(false);
    expect(createNotification).not.toHaveBeenCalled();

    await expect(
      new TerminalNotificationService({
        ...base,
        isSupported: () => true,
        isWindowFocused: () => false,
        createNotification: () => {
          throw new Error('native notifications unavailable');
        },
      }).show({ sessionId: 'session-1', kind: 'bell' }),
    ).resolves.toBe(false);
  });
});
