import { describe, expect, it, vi } from 'vite-plus/test';
import { TerminalNotificationService } from '../../main/services/terminal-notification-service';

describe('TerminalNotificationService', () => {
  it('shows privacy-safe attention notifications only when supported and the window is unfocused', () => {
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
      createNotification,
      restoreWindow: restore,
      showWindow,
      focusWindow: focus,
      emitClick,
    });

    expect(service.show({ sessionId: 'session-1', kind: 'command-completed' })).toBe(true);
    expect(service.show({ sessionId: 'session-1', kind: 'bell' })).toBe(true);
    expect(show).toHaveBeenCalledTimes(2);
    expect(createNotification).toHaveBeenNthCalledWith(1, {
      title: 'NovelTea',
      body: 'Terminal 2 completed a command.',
    });
    expect(createNotification).toHaveBeenNthCalledWith(2, {
      title: 'NovelTea',
      body: 'Terminal 2 needs attention.',
    });

    clickHandlers[1]?.();
    expect(restore).toHaveBeenCalledOnce();
    expect(showWindow).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(emitClick).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });

  it('degrades silently when unsupported, focused, or the session is stale', () => {
    const createNotification = vi.fn();
    const base = {
      resolveSessionLabel: () => 'Terminal 1',
      createNotification,
      restoreWindow: vi.fn(),
      showWindow: vi.fn(),
      focusWindow: vi.fn(),
      emitClick: vi.fn(),
    };

    expect(
      new TerminalNotificationService({
        ...base,
        isSupported: () => false,
        isWindowFocused: () => false,
      }).show({ sessionId: 'session-1', kind: 'bell' }),
    ).toBe(false);
    expect(
      new TerminalNotificationService({
        ...base,
        isSupported: () => true,
        isWindowFocused: () => true,
      }).show({ sessionId: 'session-1', kind: 'bell' }),
    ).toBe(false);
    expect(
      new TerminalNotificationService({
        ...base,
        isSupported: () => true,
        isWindowFocused: () => false,
        resolveSessionLabel: () => null,
      }).show({ sessionId: 'session-1', kind: 'bell' }),
    ).toBe(false);
    expect(createNotification).not.toHaveBeenCalled();

    expect(
      new TerminalNotificationService({
        ...base,
        isSupported: () => true,
        isWindowFocused: () => false,
        createNotification: () => {
          throw new Error('native notifications unavailable');
        },
      }).show({ sessionId: 'session-1', kind: 'bell' }),
    ).toBe(false);
  });
});
