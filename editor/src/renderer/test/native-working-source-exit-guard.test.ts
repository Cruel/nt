import { describe, expect, it, vi } from 'vite-plus/test';
import { createNativeWorkingSourceExitGuard } from '../../main/services/native-working-source-exit-guard';

describe('working-source exit flush barrier (#625)', () => {
  it('does not close before the outstanding projection has drained and coalesces quit events', async () => {
    let complete!: () => void;
    const flush = vi.fn(() => new Promise<void>((resolve) => (complete = resolve)));
    const confirm = vi.fn(async () => true);
    const exit = createNativeWorkingSourceExitGuard(flush, confirm);
    const closeWindow = vi.fn();
    const quitApp = vi.fn();
    exit.request(closeWindow);
    exit.request(quitApp);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(closeWindow).not.toHaveBeenCalled();
    expect(quitApp).not.toHaveBeenCalled();
    complete();
    await vi.waitFor(() => expect(closeWindow).toHaveBeenCalledTimes(1));
    expect(exit.ready).toBe(true);
    exit.request(quitApp);
    expect(quitApp).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    exit.reset();
    expect(exit.ready).toBe(false);
  });

  it('retains the editor after a rejected flush failure and closes only on explicit consent', async () => {
    const flush = vi.fn().mockRejectedValue(new Error('external edit'));
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const exit = createNativeWorkingSourceExitGuard(flush, confirm);
    const close = vi.fn();
    exit.request(close);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(close).not.toHaveBeenCalled();
    expect(exit.ready).toBe(false);
    // Let the first asynchronous attempt settle before re-requesting quit.
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    exit.request(close);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
