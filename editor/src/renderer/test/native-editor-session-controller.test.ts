import { describe, expect, it, vi } from 'vite-plus/test';
import path from 'node:path';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { NativeAuthoringPreparation } from '../../main/services/native-authoring-worker-contract';
import { NativeEditorSessionController } from '../../main/services/native-editor-session-controller';
import { NativeAuthoringSessionBridge } from '../../main/services/native-authoring-session-bridge';
import { NativeAuthoringWorkingProject } from '../../main/services/native-authoring-working-project';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { createNodeProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';

function fixture() {
  const saved = createAuthoringProject({ id: 'native-open', name: 'Open Project' });
  let active = 'one';
  let fail: ((error: Error) => void) | undefined;
  const authority = {
    requireActiveProjectRoot(id: string) {
      if (active !== id) throw new Error('Project session is stale or unknown.');
      return '/trusted/project';
    },
    isCurrent(id: string) {
      return active === id;
    },
  };
  const close = vi.fn();
  const bridge = {
    close,
    onFailure(callback: (error: Error) => void) {
      fail = callback;
      return () => {
        fail = undefined;
      };
    },
  };
  const preparation: NativeAuthoringPreparation = {
    accepted: true,
    error: '',
    workingRevision: 0,
    project: saved,
    recordOverrides: {},
    completeProject: saved,
    sourceRevisions: {},
    textOverlays: {},
    shaderOverlays: {},
    diagnostics: [],
  };
  const open = vi.fn(async () => ({}));
  const prepareCompleteWorking = vi.fn(async () => preparation);
  const working = { open, prepareCompleteWorking };
  const controller = new NativeEditorSessionController(
    authority,
    bridge,
    working as unknown as ConstructorParameters<typeof NativeEditorSessionController>[2],
  );
  return {
    saved,
    close,
    open,
    preparation,
    prepareCompleteWorking,
    controller,
    setActive(id: string) {
      active = id;
    },
    fail(error: Error) {
      fail?.(error);
    },
  };
}

describe('native admission at the editor main Project lifecycle', () => {
  it('tracks in-flight activation generations independently of the current Project ID', () => {
    const sessions = new ActiveProjectSessionService();
    const first = sessions.beginProjectActivation();
    expect(sessions.isProjectActivationCurrent(first)).toBe(true);
    const second = sessions.beginProjectActivation();
    expect(sessions.isProjectActivationCurrent(first)).toBe(false);
    expect(sessions.isProjectActivationCurrent(second)).toBe(true);
    sessions.closeActiveProject();
    expect(sessions.isProjectActivationCurrent(second)).toBe(false);
  });

  it('admits only current main-owned Projects after full saved-value parity', async () => {
    const test = fixture();
    await test.controller.admit('one', test.saved);
    expect(test.controller.isAdmitted('one')).toBe(true);
    expect(test.open).toHaveBeenCalledWith('one');
    expect(test.prepareCompleteWorking).toHaveBeenCalledWith();
    test.setActive('two');
    expect(test.controller.isAdmitted('one')).toBe(false);
    await expect(test.controller.admit('one', test.saved)).rejects.toThrow('stale');
    expect(test.open).toHaveBeenCalledTimes(1);
    test.controller.dispose();
  });

  it('rejects native/Workspace divergence and rejected preparation rather than falling back', async () => {
    const test = fixture();
    test.prepareCompleteWorking.mockResolvedValueOnce({
      ...test.preparation,
      completeProject: {
        ...test.saved,
        project: { ...test.saved.project, name: 'Divergent Project' },
      },
    });
    await expect(test.controller.admit('one', test.saved)).rejects.toThrow('differs');
    expect(test.controller.isAdmitted('one')).toBe(false);
    test.prepareCompleteWorking.mockResolvedValueOnce({
      ...test.preparation,
      accepted: false,
      error: 'Invalid dirty owner',
      completeProject: null,
    });
    await expect(test.controller.admit('one', test.saved)).rejects.toThrow('Invalid dirty owner');
    expect(test.controller.isAdmitted('one')).toBe(false);
    test.controller.dispose();
  });

  it('revokes the old admission on worker failure, close and superseding activation', async () => {
    const test = fixture();
    await test.controller.admit('one', test.saved);
    test.fail(new Error('worker crashed'));
    expect(test.controller.isAdmitted('one')).toBe(false);
    await test.controller.admit('one', test.saved);

    let release!: () => void;
    test.prepareCompleteWorking.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(test.preparation);
        }),
    );
    const pending = test.controller.admit('one', test.saved);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    test.controller.close();
    release();
    await expect(pending).rejects.toThrow('superseded');
    expect(test.controller.isAdmitted('one')).toBe(false);
    test.controller.dispose();
  });
});

const nativeAddon = process.env.NOVELTEA_AUTHORING_NODE_ADDON;
describe.skipIf(!nativeAddon)('real native worker admission of the editor Project', () => {
  it('admits the exact Feature Lab saved Project and revokes it on close', async () => {
    const fixture = path.resolve(process.cwd(), '../tests/projects/feature-lab');
    const opened = await createNodeProjectWorkspaceService().open(fixture);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const sessions = new ActiveProjectSessionService();
    const bridge = new NativeAuthoringSessionBridge(sessions, {
      addonPath: nativeAddon!,
      workerScript: path.resolve(
        process.cwd(),
        'dist-electron/authoring-worker/native-authoring-worker.cjs',
      ),
      pollIntervalMs: 200,
    });
    const controller = new NativeEditorSessionController(
      sessions,
      bridge,
      new NativeAuthoringWorkingProject(bridge),
    );
    try {
      const id = await sessions.activateProjectFile(path.join(fixture, 'project.yaml'));
      await controller.admit(id, opened.snapshot.project);
      expect(controller.isAdmitted(id)).toBe(true);
      controller.close();
      expect(controller.isAdmitted(id)).toBe(false);
      await expect(controller.admit('stale-id', opened.snapshot.project)).rejects.toThrow('stale');
    } finally {
      controller.dispose();
      sessions.dispose();
    }
  }, 120_000);
});
