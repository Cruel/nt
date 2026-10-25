import { describe, expect, it, vi } from 'vite-plus/test';
import { NativeEditorSessionController } from '../../main/services/native-editor-session-controller';

const SESSION = 'native-test-readiness-session';

function fixture() {
  let revision = 7;
  let current = true;
  const bridge = { close: vi.fn(), onFailure: vi.fn(() => () => {}) };
  const working = {
    snapshot: vi.fn(() => ({ workingRevision: revision })),
    prepareCompleteWorking: vi.fn(async () => ({ accepted: true, workingRevision: revision })),
  };
  const controller = new NativeEditorSessionController(
    {
      requireActiveProjectRoot: (id) => {
        if (!current || id !== SESSION) throw new Error('Stale Project session.');
        return '/native-test-project';
      },
      isCurrent: (id) => current && id === SESSION,
    },
    bridge,
    working as unknown as ConstructorParameters<typeof NativeEditorSessionController>[2],
  );
  Object.assign(controller, { activeId: SESSION });
  const dispose = vi.fn(async () => {});
  const prepare = vi.fn(async () => ({ status: 'prepared' as const, dispose }));
  Object.defineProperty(controller, 'runtimeCache', {
    value: { prepare, clear: vi.fn(async () => {}) },
  });
  return {
    controller,
    bridge,
    working,
    prepare,
    dispose,
    setRevision: (next: number) => {
      revision = next;
    },
    revoke: () => {
      current = false;
    },
  };
}

describe('native Test readiness, from revision-pinned editor session authority', () => {
  it('returns prepared readiness and releases the runtime lease', async () => {
    const test = fixture();
    await expect(test.controller.testReadiness(SESSION, 7, 'smoke')).resolves.toEqual({
      runnable: true,
      reason: 'runnable',
      diagnostics: [],
    });
    expect(test.working.prepareCompleteWorking).toHaveBeenCalledExactlyOnceWith('smoke');
    expect(test.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/native-test-project',
        testId: 'smoke',
      }),
    );
    expect(test.dispose).toHaveBeenCalledOnce();
    test.controller.close();
  });

  it('rejects obsolete revisions without preparing a runtime', async () => {
    const test = fixture();
    await expect(test.controller.testReadiness(SESSION, 6, 'smoke')).rejects.toThrow(
      'Stale native Test readiness revision.',
    );
    expect(test.prepare).not.toHaveBeenCalled();
    test.controller.close();
  });

  it('rejects a response invalidated while its runtime lease is being released', async () => {
    const test = fixture();
    let release!: () => void;
    const releasing = new Promise<void>((resolve) => {
      release = resolve;
    });
    test.dispose.mockImplementationOnce(() => releasing);
    const pending = test.controller.testReadiness(SESSION, 7, 'smoke');
    await vi.waitFor(() => expect(test.dispose).toHaveBeenCalledOnce());
    test.setRevision(8);
    release();
    await expect(pending).rejects.toThrow('superseded during lease release');
    test.controller.close();
  });

  it('rejects a closed session even if a stale preparation resolves after close', async () => {
    const test = fixture();
    let release!: () => void;
    const preparing = new Promise<Awaited<ReturnType<typeof test.prepare>>>((resolve) => {
      release = () => resolve({ status: 'prepared', dispose: test.dispose });
    });
    test.prepare.mockImplementationOnce(() => preparing);
    const pending = test.controller.testReadiness(SESSION, 7, 'smoke');
    await vi.waitFor(() => expect(test.prepare).toHaveBeenCalledOnce());
    test.controller.close();
    release();
    await expect(pending).rejects.toThrow('superseded');
    expect(test.dispose).toHaveBeenCalledOnce();
  });
});
