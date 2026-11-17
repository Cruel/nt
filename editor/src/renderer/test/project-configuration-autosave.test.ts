import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { projectEdits } from '../commands/project-editing';
import { useCommandStore } from '../commands/command-store';
import { useNativeFieldDraftStore } from '../commands/native-field-drafts';
import {
  configurationTabShowsDirty,
  startProjectConfigurationAutosave,
  useConfigurationAutosaveStatus,
} from '../project/project-configuration-autosave';
import { useProjectStore } from '../project/project-store';
import { useWorkbenchStore } from '../workbench/workbench-store';
import { buildSettingsTab } from '../workbench/editor-registry';
import { usePendingInputStore } from '../workbench/pending-input-store';
import { useDraftDirtyStore } from '../workbench/draft-dirty-store';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';
import {
  buildEditorProjectStateSnapshot,
  setLoadedEditorProjectState,
} from '../workbench/project-editor-state';
import { admitNativeRendererCommandFixture } from '../test-support/native-acknowledged-command-fixture';

const initial = () => {
  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
  return project;
};

async function replace(path: string, value: unknown, owner: string) {
  const result = await projectEdits.execute({
    type: 'project.replaceAtPath',
    payload: { path, value },
    label: 'Change test field',
    originSaveUnitId: owner,
    persistencePolicy: 'manual-save',
  });
  expect(result.ok).toBe(true);
}

describe('project configuration autosave', () => {
  it('does not flash a dirty Export tab during successful autosave, but shows failures', () => {
    const owner = 'project:platform-export-profiles';
    const dirty = { dirty: true, saveUnitId: owner, draftDirty: false, pendingInputDirty: false };
    const status = {
      projectInstanceId: 'instance',
      pendingOwners: [owner],
      failedOwners: [],
      blockedOwners: [],
      recoveredOwners: [],
      errorsByOwner: {},
    };
    expect(configurationTabShowsDirty(dirty, status, 'instance')).toBe(false);
    // Native working/saved truth may become visible before the scheduler's
    // pending notification, or remain dirty after an older Save settles.
    // Neither interval requires intervention unless the controller says so.
    expect(configurationTabShowsDirty(dirty, { ...status, pendingOwners: [] }, 'instance')).toBe(
      false,
    );
    expect(configurationTabShowsDirty(dirty, status, 'other-instance')).toBe(true);
    expect(configurationTabShowsDirty({ ...dirty, dirty: false }, status, 'instance')).toBe(false);
    const editingRawInput = { ...dirty, pendingInputDirty: true };
    expect(configurationTabShowsDirty(editingRawInput, status, 'instance')).toBe(false);
    expect(
      configurationTabShowsDirty(dirty, { ...status, failedOwners: [owner] }, 'instance'),
    ).toBe(true);
    expect(
      configurationTabShowsDirty(dirty, { ...status, blockedOwners: [owner] }, 'instance'),
    ).toBe(true);
    expect(
      configurationTabShowsDirty(dirty, { ...status, recoveredOwners: [owner] }, 'instance'),
    ).toBe(true);
  });

  let stop: (() => void) | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.getState().clearProject();
    useWorkbenchStore.getState().resetWorkbench();
    useCommandStore.getState().resetCommandHistory();
    usePendingInputStore.getState().resetPendingInputs();
    useDraftDirtyStore.getState().resetDraftDirty();
    useNativeFieldDraftStore.setState({ entries: {}, latestSequenceByKey: {} });
    setLoadedEditorProjectState(emptyEditorProjectState());
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it('keeps title autosave clean when native Save reports its affected project owner', async () => {
    const native = admitNativeRendererCommandFixture(initial(), undefined, {
      includeSavedOwners: true,
    });
    stop = startProjectConfigurationAutosave();
    await replace('/project/name', 'First title', 'project:settings');
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await vi.waitFor(
      () => expect(useConfigurationAutosaveStatus.getState().pendingOwners).toEqual([]),
      {
        timeout: 5000,
      },
    );
    expect(useConfigurationAutosaveStatus.getState().failedOwners).toEqual([]);
    expect(useConfigurationAutosaveStatus.getState().errorsByOwner).toEqual({});
    expect(
      buildEditorProjectStateSnapshot().recovery.saveUnitsById['project:settings'],
    ).toBeUndefined();
    expect(
      (useProjectStore.getState().savedDocument as Record<string, unknown>).name,
    ).toBeUndefined();
    expect(
      (useProjectStore.getState().savedDocument as ReturnType<typeof initial>).project.name,
    ).toBe('First title');
  });

  it('retains a failed settings warning through another edit until a successful Save', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    native.save.mockResolvedValueOnce({
      accepted: false,
      error: 'Disk write failed',
      diagnosticsAdded: [],
      commentImpacts: [],
    } as never);
    stop = startProjectConfigurationAutosave();
    await replace('/settings/display/barColor', '#111111', 'project:settings');
    await vi.waitFor(
      () =>
        expect(useConfigurationAutosaveStatus.getState().failedOwners).toContain(
          'project:settings',
        ),
      { timeout: 5000 },
    );
    await replace('/settings/display/barColor', '#222222', 'project:settings');
    expect(useConfigurationAutosaveStatus.getState().failedOwners).toContain('project:settings');
    expect(useConfigurationAutosaveStatus.getState().pendingOwners).toContain('project:settings');
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await vi.waitFor(
      () => expect(useConfigurationAutosaveStatus.getState().failedOwners).toEqual([]),
      { timeout: 5000 },
    );
    expect(
      (useProjectStore.getState().savedDocument as ReturnType<typeof initial>).settings.display
        .barColor,
    ).toBe('#222222');
  });

  it('keeps an earlier-session recovery visible until the user intentionally saves', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    await replace('/settings/display/barColor', '#111111', 'project:settings');
    expect(
      buildEditorProjectStateSnapshot().recovery.saveUnitsById['project:settings'],
    ).toBeDefined();

    stop = startProjectConfigurationAutosave();
    expect(useConfigurationAutosaveStatus.getState().recoveredOwners).toContain('project:settings');
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(native.save).not.toHaveBeenCalled();

    await replace('/settings/display/barColor', '#222222', 'project:settings');
    expect(useConfigurationAutosaveStatus.getState().recoveredOwners).toContain('project:settings');
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await vi.waitFor(
      () => expect(useConfigurationAutosaveStatus.getState().recoveredOwners).toEqual([]),
      { timeout: 5000 },
    );
    expect(
      (useProjectStore.getState().savedDocument as ReturnType<typeof initial>).settings.display
        .barColor,
    ).toBe('#222222');
  });

  it('persists only a changed setting while a Room remains unsaved', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    stop = startProjectConfigurationAutosave();

    await replace('/rooms/foyer/label', 'Unsaved Room', 'record:rooms:foyer');
    await replace('/settings/display/barColor', '#aabbcc', 'project:settings');
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1), { timeout: 5000 });

    expect(native.save.mock.calls[0]?.[2]).toBe('project:settings');
    const saved = useProjectStore.getState().savedDocument as ReturnType<typeof initial>;
    const working = useProjectStore.getState().document as ReturnType<typeof initial>;
    expect(saved.settings.display.barColor).toBe('#aabbcc');
    expect(saved.rooms.foyer?.label).toBe('Foyer');
    expect(working.rooms.foyer?.label).toBe('Unsaved Room');
    expect(
      buildEditorProjectStateSnapshot().recovery.saveUnitsById['record:rooms:foyer'],
    ).toBeDefined();
    expect(
      buildEditorProjectStateSnapshot().recovery.saveUnitsById['project:settings'],
    ).toBeUndefined();
  });

  it('honors an explicit settings autosave even when a non-content tab is active', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    stop = startProjectConfigurationAutosave();
    await replace('/settings/display/barColor', '#abcdef', 'project:settings');
    expect(useConfigurationAutosaveStatus.getState().pendingOwners).toContain('project:settings');
    useWorkbenchStore.getState().openTab(buildSettingsTab());
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1), { timeout: 5000 });

    expect(native.save.mock.calls[0]?.[2]).toBe('project:settings');
    expect(
      (useProjectStore.getState().savedDocument as ReturnType<typeof initial>).settings.display
        .barColor,
    ).toBe('#abcdef');
  });

  it('persists edits arriving during an in-flight Save in a subsequent scoped Save', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    const original = native.save.getMockImplementation()!;
    const held = { release: () => undefined as void };
    native.save.mockImplementationOnce(
      (...args: Parameters<typeof original>) =>
        new Promise<Awaited<ReturnType<typeof original>>>((resolve, reject) => {
          held.release = () => {
            void original(...args).then(resolve, reject);
          };
        }),
    );
    stop = startProjectConfigurationAutosave();
    const failures: string[][] = [];
    const unsubscribe = useConfigurationAutosaveStatus.subscribe((state) => {
      failures.push([...state.failedOwners]);
    });

    await replace('/settings/display/barColor', '#111111', 'project:settings');
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const second = replace('/settings/display/barColor', '#222222', 'project:settings');
    held.release();
    await second;
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await vi.waitFor(
      () => expect(useConfigurationAutosaveStatus.getState().pendingOwners).toEqual([]),
      { timeout: 5000 },
    );
    expect(useConfigurationAutosaveStatus.getState().failedOwners).toEqual([]);
    expect(failures.every((owners) => owners.length === 0)).toBe(true);
    unsubscribe();
    expect(
      (useProjectStore.getState().savedDocument as ReturnType<typeof initial>).settings.display
        .barColor,
    ).toBe('#222222');
  });

  it('does not misreport a successful Save when raw input begins during persistence', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    const original = native.save.getMockImplementation()!;
    const held = { release: () => undefined as void };
    native.save.mockImplementationOnce(
      (...args: Parameters<typeof original>) =>
        new Promise<Awaited<ReturnType<typeof original>>>((resolve, reject) => {
          held.release = () => {
            void original(...args).then(resolve, reject);
          };
        }),
    );
    stop = startProjectConfigurationAutosave();

    await replace('/settings/display/barColor', '#abcdef', 'project:settings');
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1), { timeout: 5000 });
    usePendingInputStore
      .getState()
      .setPendingInput('project:settings', '/settings/display/referenceResolution/width', {
        value: '-',
      });
    held.release();

    await vi.waitFor(
      () =>
        expect(
          (useProjectStore.getState().savedDocument as ReturnType<typeof initial>).settings.display
            .barColor,
        ).toBe('#abcdef'),
      { timeout: 5000 },
    );
    expect(useConfigurationAutosaveStatus.getState().failedOwners).toEqual([]);
    expect(useProjectStore.getState().lastSaveError).toBeNull();
    usePendingInputStore
      .getState()
      .clearPendingInput('project:settings', '/settings/display/referenceResolution/width');
    await vi.waitFor(
      () => expect(useConfigurationAutosaveStatus.getState().pendingOwners).toEqual([]),
      { timeout: 5000 },
    );
    expect(native.save).toHaveBeenCalledTimes(1);
  });

  it('coalesces rapid Project Settings edits into one scoped native Save', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    stop = startProjectConfigurationAutosave();

    await replace('/settings/display/barColor', '#111111', 'project:settings');
    await replace('/settings/display/barColor', '#222222', 'project:settings');
    await replace('/settings/display/barColor', '#333333', 'project:settings');
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(
      (useProjectStore.getState().savedDocument as ReturnType<typeof initial>).settings.display
        .barColor,
    ).toBe('#333333');
  });

  it('persists export quality as a project profile without needing manual Save', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    stop = startProjectConfigurationAutosave();

    await replace(
      '/export/runtime/localization/quality',
      'release',
      'project:platform-export-profiles',
    );
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(native.save.mock.calls[0]?.[2]).toBe('project:platform-export-profiles');
    expect(
      (useProjectStore.getState().savedDocument as ReturnType<typeof initial>).export.runtime
        .localization.quality,
    ).toBe('release');
  });

  it('autosaves the Project-owned undefined-interaction fallback', async () => {
    const project = initial();
    project.undefinedInteractionProgram = {
      instructions: [],
      completion: { kind: 'return' },
      outcome: 'unhandled',
    };
    const native = admitNativeRendererCommandFixture(project);
    stop = startProjectConfigurationAutosave();

    await replace('/undefinedInteractionProgram/outcome', 'handled', 'project:settings');
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(native.save.mock.calls[0]?.[2]).toBe('project:settings');
    expect(
      (useProjectStore.getState().savedDocument as ReturnType<typeof initial>)
        .undefinedInteractionProgram?.outcome,
    ).toBe('handled');
  });

  it('saves an independent Export owner when Settings is blocked by raw numeric input', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    stop = startProjectConfigurationAutosave();
    await replace('/settings/display/barColor', '#445566', 'project:settings');
    usePendingInputStore
      .getState()
      .setPendingInput('project:settings', '/settings/display/referenceResolution/width', {
        value: '-',
      });
    await replace(
      '/export/runtime/localization/quality',
      'release',
      'project:platform-export-profiles',
    );

    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(native.save.mock.calls[0]?.[2]).toBe('project:platform-export-profiles');
    expect(useConfigurationAutosaveStatus.getState().blockedOwners).toContain('project:settings');
    expect(
      (useProjectStore.getState().savedDocument as ReturnType<typeof initial>).export.runtime
        .localization.quality,
    ).toBe('release');
    expect(
      (useProjectStore.getState().savedDocument as ReturnType<typeof initial>).settings.display
        .barColor,
    ).not.toBe('#445566');

    usePendingInputStore
      .getState()
      .clearPendingInput('project:settings', '/settings/display/referenceResolution/width');
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(native.save.mock.calls[1]?.[2]).toBe('project:settings');
  });

  it('continues independent Export autosave while Settings has a native field error', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    stop = startProjectConfigurationAutosave();
    await replace('/settings/display/barColor', '#112233', 'project:settings');
    await replace(
      '/export/runtime/localization/quality',
      'release',
      'project:platform-export-profiles',
    );
    const { projectInstanceId, projectSessionId } = useProjectStore.getState();
    useNativeFieldDraftStore.setState({
      entries: {
        blocked: {
          projectInstanceId: projectInstanceId!,
          projectSessionId: projectSessionId!,
          saveUnitId: 'project:settings',
          path: '/settings/display/barColor',
          value: '#112233',
          sequence: 1,
          editSessionId: 'test',
          error: 'A native field must be resolved',
          inputStartedAt: Date.now(),
          conflict: true,
          base: { revision: useCommandStore.getState().nativeWorkingRevision!, exists: true },
        },
      },
    });

    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(native.save.mock.calls[0]?.[2]).toBe('project:platform-export-profiles');
    expect(useConfigurationAutosaveStatus.getState().blockedOwners).toContain('project:settings');
    expect(
      (useProjectStore.getState().savedDocument as ReturnType<typeof initial>).export.runtime
        .localization.quality,
    ).toBe('release');
  });

  it('shows blocked attention for raw-only invalid Settings without scheduling a Save', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    stop = startProjectConfigurationAutosave();
    usePendingInputStore
      .getState()
      .setPendingInput('project:settings', '/settings/display/referenceResolution/width', {
        value: '-',
      });
    expect(useConfigurationAutosaveStatus.getState().blockedOwners).not.toContain(
      'project:settings',
    );
    await vi.waitFor(
      () =>
        expect(useConfigurationAutosaveStatus.getState().blockedOwners).toContain(
          'project:settings',
        ),
      { timeout: 5000 },
    );
    expect(native.save).not.toHaveBeenCalled();
    usePendingInputStore
      .getState()
      .clearPendingInput('project:settings', '/settings/display/referenceResolution/width');
    await vi.waitFor(() =>
      expect(useConfigurationAutosaveStatus.getState().blockedOwners).not.toContain(
        'project:settings',
      ),
    );
    expect(native.save).not.toHaveBeenCalled();
  });

  it('does not persist an invalid numeric draft until its raw input is resolved', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    stop = startProjectConfigurationAutosave();
    await replace('/settings/display/barColor', '#445566', 'project:settings');
    usePendingInputStore
      .getState()
      .setPendingInput('project:settings', '/settings/display/referenceResolution/width', {
        value: '-',
      });
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(native.save).not.toHaveBeenCalled();

    usePendingInputStore
      .getState()
      .clearPendingInput('project:settings', '/settings/display/referenceResolution/width');
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('retries a revision race and clears dirty settings without manual Save', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    native.save.mockResolvedValueOnce({
      accepted: false,
      error: 'Project changed before its native Save could begin.',
      diagnosticsAdded: [],
      commentImpacts: [],
    } as never);
    stop = startProjectConfigurationAutosave();

    await replace('/settings/display/barColor', '#444444', 'project:settings');
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await vi.waitFor(
      () => {
        expect(
          buildEditorProjectStateSnapshot().recovery.saveUnitsById['project:settings'],
        ).toBeUndefined();
        expect(useConfigurationAutosaveStatus.getState().pendingOwners).toEqual([]);
      },
      { timeout: 5000 },
    );
    expect(useProjectStore.getState().lastSaveError).toBeNull();
  });

  it('reports a failed Save and preserves dirty settings for an explicit retry', async () => {
    const native = admitNativeRendererCommandFixture(initial());
    native.save.mockResolvedValueOnce({
      accepted: false,
      error: 'Disk write failed',
      diagnosticsAdded: [],
      commentImpacts: [],
    } as never);
    stop = startProjectConfigurationAutosave();
    await replace('/settings/display/barColor', '#123123', 'project:settings');

    await vi.waitFor(
      () => expect(useProjectStore.getState().lastSaveError).toContain('Disk write failed'),
      { timeout: 5000 },
    );
    expect(
      buildEditorProjectStateSnapshot().recovery.saveUnitsById['project:settings'],
    ).toBeDefined();
    expect(native.save).toHaveBeenCalledTimes(1);
  });
});
