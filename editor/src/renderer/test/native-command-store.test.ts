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
  it('stages dirty text through the serialized native queue without publishing Project edits', async () => {
    const stage = vi.fn().mockResolvedValue({
      ...nativeAck('Saved Project', 1),
      textSourceStaged: true,
      textSourceDiskRevision: 'sha256:' + 'a'.repeat(64),
    });
    Object.defineProperty(window.noveltea, 'nativeProjectStageText', {
      configurable: true, writable: true, value: stage,
    });
    const revisionBefore = useProjectStore.getState().projectRevision;
    const result = await useCommandStore.getState().stageNativeTextAsync(
      'scripts/demo.lua', 'return 17', 'sha256:' + 'a'.repeat(64), revisionBefore,
    );
    expect(result.ok).toBe(true);
    expect(stage).toHaveBeenCalledWith(
      sessionId, 0, 'scripts/demo.lua', 'sha256:' + 'a'.repeat(64), 'return 17',
    );
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(1);
    expect(useProjectStore.getState().projectRevision).toBe(revisionBefore);
    expect(useCommandStore.getState().history.entries).toHaveLength(0);
  });

  it('queues text Save behind native editing and advances revision only on worker acknowledgment', async () => {
    let release!: (value: ReturnType<typeof nativeAck>) => void;
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const sourceRevision = 'sha256:' + 'f'.repeat(64);
    const nativeSaveText = vi.fn().mockResolvedValue({
      ...nativeAck('Edited', 3),
      textSourceDiskRevisions: { 'scripts/demo.lua': sourceRevision },
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveText', {
      configurable: true, writable: true, value: nativeSaveText,
    });
    const command = useCommandStore.getState().executeCommandAsync(request('Edited'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const expectedProjectRevision = useProjectStore.getState().projectRevision + 1;
    const saving = useCommandStore.getState().saveNativeTextAsync(
      'scripts/demo.lua', 'return true', 'sha256:' + 'a'.repeat(64), expectedProjectRevision,
    );
    expect(nativeSaveText).not.toHaveBeenCalled();
    release(nativeAck('Edited', 1));
    expect((await command).ok).toBe(true);
    expect(await saving).toEqual({ ok: true, contentHash: sourceRevision });
    expect(nativeSaveText).toHaveBeenCalledWith(
      sessionId, 1, 'scripts/demo.lua', 'sha256:' + 'a'.repeat(64), 'return true',
    );
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(3);
    expect(useCommandStore.getState().nativeMutationPending).toBe(false);
  });

  it('retains native staged revision after source disk conflict, without falling back', async () => {
    const nativeSaveText = vi.fn().mockResolvedValue({
      ...nativeAck('Saved Project', 1, false),
      error: 'WORKSPACE_REVISION_CONFLICT',
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveText', {
      configurable: true, writable: true, value: nativeSaveText,
    });
    const result = await useCommandStore.getState().saveNativeTextAsync(
      'scripts/demo.lua', 'return edited', 'sha256:' + 'b'.repeat(64),
      useProjectStore.getState().projectRevision,
    );
    expect(result.ok).toBe(false);
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(1);
    expect(useCommandStore.getState().nativeMutationFailure).toBeNull();
    expect(useCommandStore.getState().executeCommand(request('Legacy')).ok).toBe(false);
  });
  it('serializes scoped native Save after acknowledged edits without changing editor history', async () => {
    let release!: (value: ReturnType<typeof nativeAck>) => void;
    const patch = vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const save = vi.fn().mockResolvedValue(nativeAck('Edited', 1));
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true, writable: true, value: save,
    });
    const command = useCommandStore.getState().executeCommandAsync(request('Edited'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const atRevision = useProjectStore.getState().projectRevision;
    const saved = useCommandStore.getState().saveNativeUnitAsync(
      'project:settings', atRevision + 1, { comments: 'keep' },
    );
    expect(save).not.toHaveBeenCalled();
    release(nativeAck('Edited', 1));
    expect((await command).ok).toBe(true);
    expect((await saved).ok).toBe(true);
    expect(save).toHaveBeenCalledWith(sessionId, 1, 'project:settings', { comments: 'keep' });
    expect(useCommandStore.getState().history.entries).toHaveLength(1);
    expect(useCommandStore.getState().nativeMutationFailure).toBeNull();
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('adopts a saved baseline before allowing the next queued native edit to publish', async () => {
    const order: string[] = [];
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      writable: true,
      value: vi.fn(async () => nativeAck('Saved Project', 0)),
    });
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(async () => {
      order.push('next-command');
      return nativeAck('Next change', 1);
    });
    const originalRevision = useProjectStore.getState().projectRevision;
    const saving = useCommandStore.getState().saveNativeUnitAsync(
      'project:settings',
      originalRevision,
      { comments: 'keep' },
      () => {
        order.push('saved-baseline');
        expect(useProjectStore.getState().projectRevision).toBe(originalRevision);
      },
    );
    const next = useCommandStore.getState().executeCommandAsync(request('Next change'));
    expect((await saving).ok).toBe(true);
    expect((await next).ok).toBe(true);
    expect(order).toEqual(['saved-baseline', 'next-command']);
    expect(projectName()).toBe('Next change');
  });

  it('keeps native Save failure from creating a saved baseline or enabling a legacy writer', async () => {
    const save = vi.fn().mockResolvedValue(nativeAck('Saved Project', 0, false));
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true, writable: true, value: save,
    });
    const current = useProjectStore.getState().projectRevision;
    const denied = await useCommandStore.getState().saveNativeUnitAsync(
      'project:settings', current, { comments: 'keep' },
    );
    expect(denied.ok).toBe(false);
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(0);
    expect(useCommandStore.getState().nativeMutationFailure).toBeNull();
    expect(useCommandStore.getState().executeCommand(request('Legacy writer')).ok).toBe(false);
    save.mockRejectedValueOnce(new Error('Worker stopped before Save reply'));
    const unknown = await useCommandStore.getState().saveNativeUnitAsync(
      'project:settings', current, {},
    );
    expect(unknown.ok).toBe(false);
    expect(useCommandStore.getState().nativeMutationFailure).toContain('Worker stopped');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('submits grouped editor commands as one native mutation and one undo entry', async () => {
    const patch = vi.spyOn(window.noveltea, 'nativeProjectPatch');
    patch.mockResolvedValueOnce(nativeAck('Second name', 1));
    const result = await useCommandStore.getState().executeCommandBatchAsync(
      {
        label: 'Edit project name twice',
        originSaveUnitId: 'project:settings',
        persistencePolicy: 'manual-save',
      },
      [request('First name'), request('Second name')],
    );
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[2]).toHaveLength(2);
    expect(projectName()).toBe('Second name');
    expect(useCommandStore.getState().history.entries).toHaveLength(1);
    patch.mockResolvedValueOnce(nativeAck('Saved Project', 2));
    expect((await useCommandStore.getState().undoAsync()).ok).toBe(true);
    expect(projectName()).toBe('Saved Project');
  });

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
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveText');
    Reflect.deleteProperty(window.noveltea, 'nativeProjectStageText');
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
    const queued = state.executeCommandAsync(request('Concurrent'));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.slice(0, 2)).toEqual([sessionId, 0]);
    patch.mockResolvedValueOnce(nativeAck('Concurrent', 2));
    release(nativeAck('Native Edition', 1));
    expect((await pending).ok).toBe(true);
    expect(projectName()).toBe('Native Edition');
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(1);
    expect(useCommandStore.getState().history.cursor).toBe(0);

    const queuedResult = await queued;
    expect(queuedResult.ok, JSON.stringify(queuedResult.diagnostics)).toBe(true);
    expect(projectName()).toBe('Concurrent');
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(2);
    expect(useCommandStore.getState().history.cursor).toBe(1);

    patch.mockResolvedValueOnce(nativeAck('Native Edition', 3));
    expect((await state.undoAsync()).ok).toBe(true);
    expect(projectName()).toBe('Native Edition');
    expect(useCommandStore.getState().history.cursor).toBe(0);

    patch.mockResolvedValueOnce(nativeAck('Concurrent', 4));
    expect((await state.redoAsync()).ok).toBe(true);
    expect(projectName()).toBe('Concurrent');
    expect(useCommandStore.getState().history.cursor).toBe(1);
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(4);
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

  it('does not block commands in a new Project while an old native worker reply is pending', async () => {
    let release!: (value: ReturnType<typeof nativeAck>) => void;
    const patch = vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const previous = useCommandStore.getState().executeCommandAsync(request('Old Project Edit'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const staleQueued = useCommandStore.getState().executeCommandAsync(request('Never Apply'));
    setProject('New Project', newSessionId);
    useCommandStore.getState().enableNativeCommandMode(0);
    patch.mockResolvedValueOnce(nativeAck('New Project Edit', 1));

    const current = useCommandStore.getState().executeCommandAsync(request('New Project Edit'));
    expect((await Promise.race([
      current.then((value) => value.ok),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]))).toBe(true);
    expect(projectName()).toBe('New Project Edit');
    expect(patch).toHaveBeenCalledTimes(2);
    release(nativeAck('Old Project Edit', 1));
    expect((await previous).ok).toBe(false);
    expect((await staleQueued).ok).toBe(false);
    expect(projectName()).toBe('New Project Edit');
  });
});
