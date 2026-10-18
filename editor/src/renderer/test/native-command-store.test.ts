import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { useProjectStore } from '../project/project-store';
import { toJsonValue } from '../project/json-value';
import { useCommandStore } from '../commands/command-store';
import { confirmNativeCommand } from '../commands/native-command-execution';
import { createInitialCommandBusState, executeCommand } from '../commands/command-bus';

const sessionId = '5b33af83-d804-444c-b0dc-e8f10e4d03a0';
const newSessionId = 'ed60bb33-e19e-4569-bf3c-08ab72bef3c4';

function projectName() {
  return (useProjectStore.getState().document as { project: { name: string } }).project.name;
}

function setProject(name = 'Saved Project', id = sessionId) {
  const project = toJsonValue(createAuthoringProject({ id: 'native-command', name }));
  expect(
    useProjectStore.getState().loadProjectDocument({
      document: project,
      savedDocument: project,
      projectPath: '/fixture/native-command',
      projectFilePath: '/fixture/native-command/project.yaml',
      projectSessionId: id,
      scriptSourcePaths: {},
    }),
  ).toBe(true);
  useCommandStore.getState().resetCommandHistory();
}

function request(name: string) {
  return {
    type: 'project.replaceAtPath',
    payload: { path: '/project/name', value: name },
    originSaveUnitId: 'project:settings',
    persistencePolicy: 'manual-save' as const,
  };
}

function nativeAck(name: string, revision: number, accepted = true) {
  return {
    accepted,
    error: accepted ? '' : 'Native record mutation rejected',
    snapshot: {
      workingRevision: revision,
      diskSourceRevision: 'sha256:' + '0'.repeat(64),
      source: { project: { name } },
      normalized: { project: { name } },
      dirty: true,
      valid: true,
      diagnostics: [],
      inventory: [],
    },
    affectedRecords: ['project'],
    diagnosticsAdded: [],
    diagnosticsRemoved: [],
  };
}

describe('native-backed renderer commands', () => {
  it('confirms JSON Patch array append against the final native parent array', async () => {
    const original = createInitialCommandBusState({ project: { tags: ['a'] } });
    const proposal = executeCommand(original, {
      type: 'project.applyPatch',
      payload: [{ op: 'add', path: '/project/tags/-', value: 'b' }],
      originSaveUnitId: 'project:settings',
      persistencePolicy: 'manual-save',
    });
    expect(proposal.ok, JSON.stringify(proposal.diagnostics)).toBe(true);
    const submitted = vi.fn(async () => ({
      ...nativeAck('irrelevant', 1),
      snapshot: {
        ...nativeAck('irrelevant', 1).snapshot,
        source: { project: { tags: ['a', 'b'] } },
      },
    }));
    const confirmed = await confirmNativeCommand(
      original,
      proposal,
      proposal.historyEntry!.patches,
      sessionId,
      0,
      submitted,
    );
    expect(confirmed.result.ok).toBe(true);
    expect(confirmed.result.document).toMatchObject({ project: { tags: ['a', 'b'] } });
  });

  beforeEach(() => {
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
    setProject();
    useCommandStore.getState().enableNativeCommandMode(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectPatch');
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
  });

  it('waits for native acknowledgment before publishing document and history; supports undo/redo', async () => {
    let release!: (value: ReturnType<typeof nativeAck>) => void;
    const patch = vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const state = useCommandStore.getState();
    const pending = state.executeCommandAsync(request('Native Edition'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(projectName()).toBe('Saved Project');
    expect(useCommandStore.getState().history.cursor).toBe(-1);
    expect(useCommandStore.getState().nativeMutationPending).toBe(true);
    expect(useCommandStore.getState().executeCommand(request('Unsafe fallback')).ok).toBe(false);
    expect((await state.executeCommandAsync(request('Concurrent'))).ok).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.slice(0, 2)).toEqual([sessionId, 0]);
    release(nativeAck('Native Edition', 1));
    expect((await pending).ok).toBe(true);
    expect(projectName()).toBe('Native Edition');
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(1);
    expect(useCommandStore.getState().history.cursor).toBe(0);

    patch.mockResolvedValueOnce(nativeAck('Saved Project', 2));
    expect((await state.undoAsync()).ok).toBe(true);
    expect(projectName()).toBe('Saved Project');
    expect(useCommandStore.getState().history.cursor).toBe(-1);

    patch.mockResolvedValueOnce(nativeAck('Native Edition', 3));
    expect((await state.redoAsync()).ok).toBe(true);
    expect(projectName()).toBe('Native Edition');
    expect(useCommandStore.getState().history.cursor).toBe(0);
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(3);
  });

  it('rejects denied native patches without changing the document or history', async () => {
    const patch = vi
      .spyOn(window.noveltea, 'nativeProjectPatch')
      .mockResolvedValueOnce(nativeAck('Refused', 0, false));
    expect((await useCommandStore.getState().executeCommandAsync(request('Refused'))).ok).toBe(
      false,
    );
    expect(projectName()).toBe('Saved Project');
    expect(useCommandStore.getState().history.cursor).toBe(-1);
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(0);
    patch.mockResolvedValueOnce(nativeAck('Accepted', 1));
    expect((await useCommandStore.getState().executeCommandAsync(request('Accepted'))).ok).toBe(
      true,
    );
    expect(projectName()).toBe('Accepted');
  });

  it('freezes native editing after an inconsistent accepted acknowledgment', async () => {
    const patch = vi
      .spyOn(window.noveltea, 'nativeProjectPatch')
      .mockResolvedValue(nativeAck('Unexpected Native Value', 1));
    const first = await useCommandStore.getState().executeCommandAsync(request('Proposed'));
    expect(first.ok).toBe(false);
    expect(first.diagnostics[0]?.message).toContain('disagreed');
    expect(projectName()).toBe('Saved Project');
    expect(useCommandStore.getState().nativeMutationFailure).toContain('disagreed');
    expect((await useCommandStore.getState().executeCommandAsync(request('Another'))).ok).toBe(
      false,
    );
    expect(useCommandStore.getState().executeCommand(request('TS fallback')).ok).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
    useCommandStore.getState().resetCommandHistory();
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(0);
    expect(useCommandStore.getState().nativeMutationFailure).toContain('disagreed');
  });

  it('refuses to submit commands after an unrelated TypeScript Project publication', async () => {
    const patch = vi.spyOn(window.noveltea, 'nativeProjectPatch');
    const current = useProjectStore.getState().document!;
    const changed = structuredClone(current) as { project: { name: string } };
    changed.project.name = 'Legacy Publication';
    expect(
      useProjectStore.getState().replaceDocumentFromCommand(changed, -1, {
        kind: 'replace',
        affectedPaths: ['/project/name'],
      }),
    ).toBe(true);
    const result = await useCommandStore.getState().executeCommandAsync(request('Native Attempt'));
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).toContain('without a native acknowledgment');
    expect(projectName()).toBe('Legacy Publication');
    expect(patch).not.toHaveBeenCalled();
    expect(useCommandStore.getState().nativeMutationFailure).toContain('without a native');
  });

  it('prevents legacy auto-commit and discards delayed responses after a Project switch', async () => {
    const patch = vi.spyOn(window.noveltea, 'nativeProjectPatch');
    expect(
      (
        await useCommandStore.getState().executeCommandAsync({
          ...request('Auto'),
          persistencePolicy: 'auto-commit',
        })
      ).ok,
    ).toBe(false);
    expect(patch).not.toHaveBeenCalled();
    let release!: (value: ReturnType<typeof nativeAck>) => void;
    patch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = useCommandStore.getState().executeCommandAsync(request('Old Project'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    setProject('New Project', newSessionId);
    expect(useCommandStore.getState().nativeWorkingRevision).toBeNull();
    release(nativeAck('Old Project', 1));
    expect((await pending).ok).toBe(false);
    expect(projectName()).toBe('New Project');
    expect(useCommandStore.getState().nativeMutationFailure).toBeNull();
    expect(useCommandStore.getState().executeCommand(request('TS New Project')).ok).toBe(true);
  });
});
