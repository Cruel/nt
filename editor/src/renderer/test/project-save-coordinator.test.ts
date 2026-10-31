import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  resolveExternalConflictUseDisk,
  saveActiveSaveUnit,
  saveAllSaveUnits,
  saveConflictingSaveUnitKeepMine,
  saveProjectAsCopy,
} from '@/project/project-save-coordinator';
import { useProjectStore } from '@/project/project-store';
import { useProjectSourceStore } from '@/project/project-source-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useCommandStore } from '@/commands/command-store';
import { resolveProjectComments } from '@/project/project-comment-confirmation';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import {
  buildEditorProjectStateSnapshot,
  setLoadedEditorProjectState,
  mergeEditorProjectState,
} from '@/workbench/project-editor-state';
import {
  emptyEditorProjectState,
  type EditorProjectState,
} from '../../shared/project-schema/editor-project-state';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultPlatformExportProfile } from '../../shared/project-schema/platform-export-contracts';
import { toJsonValue } from '@/project/json-value';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import {
  buildPlatformExportTab,
  buildProjectSettingsTab,
  buildProjectSourceTab,
} from '@/workbench/editor-registry';
import type { ProjectSourceFile } from '../../shared/project-source-files';
import { admitNativeRendererCommandFixture } from '../test-support/native-acknowledged-command-fixture';

const roomFileRevision = `xxh3-128:${'b'.repeat(32)}` as const;
const sourceRevision = `xxh3-128:${'a'.repeat(32)}` as const;
const helperSource: ProjectSourceFile = {
  id: 'scripts/helpers.lua',
  displayPath: 'scripts/helpers.lua',
  projectRelativePath: 'scripts/helpers.lua',
  kind: 'lua',
  text: true,
  contentHash: sourceRevision,
};

function roomTab(roomId: string): WorkbenchTab {
  return {
    id: `tab:rooms:${roomId}`,
    title: roomId,
    editorType: 'room-detail',
    resource: {
      kind: 'record',
      stableId: `record:rooms:${roomId}`,
      collection: 'rooms',
      entityId: roomId,
    },
  };
}

function projectWithRooms() {
  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
  project.rooms.kitchen = {
    id: 'kitchen',
    label: 'Kitchen',
    data: defaultRoomData('Kitchen'),
  };
  return project;
}

function recoveryState(
  entries: EditorProjectState['recovery']['saveUnitsById'],
): EditorProjectState {
  return {
    ...emptyEditorProjectState(),
    recovery: { sequence: Object.keys(entries).length, saveUnitsById: entries },
  };
}

function loadProject(
  savedProject: ReturnType<typeof projectWithRooms>,
  workingProject: ReturnType<typeof projectWithRooms>,
  editorState: EditorProjectState,
) {
  const saved = mergeEditorProjectState(toJsonValue(savedProject), editorState);
  useProjectStore.getState().loadProjectDocument({
    document: saved,
    savedDocument: saved,
    projectPath: '/mock/project',
    projectFilePath: '/mock/project/game.json',
    projectSessionId: 'test-project-session',
  });
  useProjectStore
    .getState()
    .replaceDocumentFromCommand(
      mergeEditorProjectState(toJsonValue(workingProject), editorState),
      0,
    );
  setLoadedEditorProjectState(editorState);
}

/** A native Save with no concurrent filesystem reconciliation. Scoped Save
 * baselines are projected by the Save coordinator from the selected units. */
function admitNativeSaveWithoutExternalChanges() {
  useCommandStore.getState().enableNativeCommandMode(0);
  const nativeSave = vi.fn().mockResolvedValue({
    accepted: true,
    error: '',
    snapshot: { workingRevision: 0 },
    affectedRecords: [],
  });
  Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
    configurable: true,
    value: nativeSave,
  });
  return nativeSave;
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.getState().clearProject();
  useProjectSourceStore.getState().clear();
  useWorkbenchStore.getState().resetWorkbench();
  useCommandStore.getState().resetCommandHistory();
  useDraftDirtyStore.getState().resetDraftDirty();
  setLoadedEditorProjectState(emptyEditorProjectState());
  // The retired TypeScript Project decoder/validator no longer exists; the
  // production-bundle closure test enforces absence, not a runtime mock.
});

describe('project save coordinator', () => {
  it('reviews native comment impacts and retries with the user-approved removal decision', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Updated';
    loadProject(
      saved,
      working,
      recoveryState({
        'record:rooms:foyer': {
          sequence: 1,
          patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Updated' }],
          affectedPaths: ['/rooms/foyer/label'],
          pendingRawInputByPath: {},
          atomicTransactionGroupIds: [],
        },
      }),
    );
    useCommandStore.getState().enableNativeCommandMode(0);
    const nativeSave = vi
      .fn()
      .mockResolvedValueOnce({
        accepted: false,
        error: 'Comment approval required',
        commentImpacts: [
          { file: 'records/rooms/foyer.yaml', path: '/label', comment: '# note', kind: 'deleted' },
        ],
      })
      .mockResolvedValueOnce({ accepted: true, error: '', snapshot: { workingRevision: 1 } });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      writable: true,
      value: nativeSave,
    });
    const pending = saveActiveSaveUnit('record:rooms:foyer');
    await vi.waitFor(() => expect(nativeSave).toHaveBeenCalledTimes(1));
    resolveProjectComments('delete');
    const result = await pending;
    expect(result).toMatchObject({ success: true, status: 'saved' });
    expect(nativeSave).toHaveBeenNthCalledWith(2, 'test-project-session', 0, 'record:rooms:foyer', {
      comments: 'remove',
    });
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });
  it('flushes the latest debounced source buffer through native staging before runtime use', async () => {
    const project = projectWithRooms();
    loadProject(project, structuredClone(project), emptyEditorProjectState());
    useProjectSourceStore.setState({
      projectSessionId: 'test-project-session',
      files: [helperSource],
      textById: { [helperSource.id]: 'return clean' },
      buffersById: {
        [helperSource.id]: {
          text: 'return clean',
          baseText: 'return clean',
          baseContentHash: sourceRevision,
          dirty: false,
          conflict: null,
        },
      },
    });
    useCommandStore.getState().enableNativeCommandMode(0);
    const stage = vi.fn().mockResolvedValue({
      accepted: true,
      error: '',
      snapshot: { workingRevision: 1 },
      textSourceStaged: true,
      textSourceDiskRevision: sourceRevision,
    });
    Object.defineProperty(window.noveltea, 'nativeProjectStageText', {
      configurable: true,
      writable: true,
      value: stage,
    });
    useProjectSourceStore.getState().setText(helperSource.id, 'return outdated');
    useProjectSourceStore.getState().setText(helperSource.id, 'return latest');
    expect(stage).not.toHaveBeenCalled();
    expect(await useProjectSourceStore.getState().flushNativeStages()).toBe(true);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage).toHaveBeenCalledWith(
      'test-project-session',
      0,
      helperSource.id,
      sourceRevision,
      'return latest',
    );
    expect(useCommandStore.getState().nativeWorkingRevision).toBe(1);
    useProjectSourceStore.getState().clear();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectStageText');
  });

  it('routes text buffer Save through native Stage/Save without invoking the retired writer', async () => {
    const project = projectWithRooms();
    loadProject(project, structuredClone(project), emptyEditorProjectState());
    useProjectSourceStore.setState({
      projectSessionId: 'test-project-session',
      files: [helperSource],
      textById: { [helperSource.id]: 'return edited' },
      buffersById: {
        [helperSource.id]: {
          text: 'return edited',
          baseText: 'return clean',
          baseContentHash: sourceRevision,
          dirty: true,
          conflict: null,
        },
      },
    });
    useCommandStore.getState().enableNativeCommandMode(0);
    useWorkbenchStore.getState().openTab(buildProjectSourceTab(helperSource));
    const savedHash = `xxh3-128:${'e'.repeat(32)}`;
    const nativeSave = vi.fn().mockResolvedValue({
      accepted: true,
      error: '',
      snapshot: { workingRevision: 2 },
      textSourceDiskRevisions: { [helperSource.id]: savedHash },
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveText', {
      configurable: true,
      writable: true,
      value: nativeSave,
    });
    const result = await saveActiveSaveUnit();
    expect(result).toMatchObject({
      success: true,
      status: 'saved',
      savedSaveUnitIds: [`source-file:${helperSource.id}`],
    });
    expect(nativeSave).toHaveBeenCalledWith(
      'test-project-session',
      0,
      helperSource.id,
      sourceRevision,
      'return edited',
    );
    expect(window.noveltea.writeProjectSource).not.toHaveBeenCalled();
    expect(useProjectSourceStore.getState().buffersById[helperSource.id]).toMatchObject({
      dirty: false,
      baseContentHash: savedHash,
    });
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveText');
  });

  it('uses native scoped Save to persist one owner without marking unrelated dirty owners saved', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Native Foyer';
    working.rooms.kitchen!.label = 'Still Dirty';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Native Foyer' }],
        affectedPaths: ['/rooms/foyer/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:kitchen': {
        sequence: 2,
        patches: [{ op: 'replace', path: '/rooms/kitchen/label', value: 'Still Dirty' }],
        affectedPaths: ['/rooms/kitchen/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    useCommandStore.getState().enableNativeCommandMode(0);
    const nativeSave = vi.fn().mockResolvedValue({
      accepted: true,
      error: '',
      snapshot: { workingRevision: 0 },
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      writable: true,
      value: nativeSave,
    });
    const result = await saveActiveSaveUnit('record:rooms:foyer');
    expect(result).toMatchObject({
      success: true,
      status: 'partially-saved',
      savedSaveUnitIds: ['record:rooms:foyer'],
      remainingDirtySaveUnitIds: ['record:rooms:kitchen'],
    });
    expect(nativeSave).toHaveBeenCalledWith('test-project-session', 0, 'record:rooms:foyer', {
      comments: 'keep',
    });
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    const state = useProjectStore.getState();
    expect((state.savedDocument as typeof saved).rooms.foyer?.label).toBe('Native Foyer');
    expect((state.savedDocument as typeof saved).rooms.kitchen?.label).toBe('Kitchen');
    expect((state.document as typeof working).rooms.kitchen?.label).toBe('Still Dirty');
    expect(buildEditorProjectStateSnapshot().recovery.saveUnitsById).toHaveProperty(
      'record:rooms:kitchen',
    );
    expect(buildEditorProjectStateSnapshot().recovery.saveUnitsById).not.toHaveProperty(
      'record:rooms:foyer',
    );
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('adopts disjoint external fields acknowledged by native Save and advances its projection gate', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Native Foyer';
    loadProject(
      saved,
      working,
      recoveryState({
        'record:rooms:foyer': {
          sequence: 1,
          patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Native Foyer' }],
          affectedPaths: ['/rooms/foyer/label'],
          pendingRawInputByPath: {},
          atomicTransactionGroupIds: [],
        },
      }),
    );
    useCommandStore.getState().enableNativeCommandMode(0);
    const onDisk = structuredClone(working.rooms.foyer!);
    onDisk.data.description.source = { kind: 'inline', text: 'Changed on disk during Save' };
    const save = vi.fn().mockResolvedValue({
      accepted: true,
      error: '',
      affectedRecords: ['rooms/foyer'],
      snapshot: {
        workingRevision: 0,
        recordSnapshots: {
          'rooms/foyer': {
            source: onDisk,
            baseline: onDisk,
            diskSourceRevision: roomFileRevision,
            conflictingPaths: [],
          },
        },
      },
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      writable: true,
      value: save,
    });
    const previousRevision = useProjectStore.getState().projectRevision;
    expect((await saveActiveSaveUnit('record:rooms:foyer')).success).toBe(true);
    const latest = useProjectStore.getState();
    expect((latest.document as typeof working).rooms.foyer!.data.description.source).toMatchObject({
      kind: 'inline',
      text: 'Changed on disk during Save',
    });
    expect(
      (latest.savedDocument as typeof saved).rooms.foyer!.data.description.source,
    ).toMatchObject({ kind: 'inline', text: 'Changed on disk during Save' });
    expect(latest.projectRevision).toBe(previousRevision + 1);
    expect(useCommandStore.getState().nativeProjectionRevision).toBe(latest.projectRevision);
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('never falls back to legacy writer when native Save refuses or Save All spans owners', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Native Foyer';
    working.rooms.kitchen!.label = 'Still Dirty';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Native Foyer' }],
        affectedPaths: ['/rooms/foyer/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:kitchen': {
        sequence: 2,
        patches: [{ op: 'replace', path: '/rooms/kitchen/label', value: 'Still Dirty' }],
        affectedPaths: ['/rooms/kitchen/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    useCommandStore.getState().enableNativeCommandMode(0);
    const nativeSave = vi.fn().mockResolvedValue({
      accepted: false,
      error: 'Physical YAML changed on disk.',
      snapshot: { workingRevision: 0 },
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      writable: true,
      value: nativeSave,
    });
    expect((await saveActiveSaveUnit('record:rooms:foyer')).success).toBe(false);
    expect((await saveAllSaveUnits()).status).toBe('failed');
    expect(nativeSave).toHaveBeenCalledTimes(2);
    expect(nativeSave.mock.calls[1]?.[2]).toEqual(['record:rooms:foyer', 'record:rooms:kitchen']);
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    expect((useProjectStore.getState().savedDocument as typeof saved).rooms.foyer?.label).toBe(
      'Foyer',
    );
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it.each(['Save', 'Save All'])(
    '%s delegates semantic rejection to native authority rather than the old validator',
    async (action) => {
      const saved = projectWithRooms();
      const working = projectWithRooms();
      working.rooms.foyer!.label = 'Native working change';
      // Deliberately malformed candidate data must reach the native owner,
      // which alone decides whether the transaction is admissible. Keep the
      // in-memory display snapshot valid so it can load normally.
      loadProject(
        saved,
        working,
        recoveryState({
          'record:rooms:foyer': {
            sequence: 1,
            patches: [
              { op: 'replace', path: '/rooms/foyer/label', value: 'Native working change' },
              { op: 'replace', path: '/rooms/foyer/data', value: null },
            ],
            affectedPaths: ['/rooms/foyer/label', '/rooms/foyer/data'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
          },
        }),
      );
      useCommandStore.getState().enableNativeCommandMode(0);
      const nativeSave = vi.fn().mockResolvedValue({
        accepted: false,
        error: 'Native semantic validation rejected the record.',
        diagnosticsAdded: [
          {
            code: 'native.room.data',
            severity: 'error',
            path: '/rooms/foyer/data',
            message: 'Invalid native Room data.',
          },
        ],
        snapshot: { workingRevision: 0 },
      });
      Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
        configurable: true,
        writable: true,
        value: nativeSave,
      });
      const result =
        action === 'Save'
          ? await saveActiveSaveUnit('record:rooms:foyer')
          : await saveAllSaveUnits();
      expect(result).toMatchObject({ success: false, status: 'failed' });
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'native.room.data',
            message: 'Invalid native Room data.',
          }),
        ]),
      );
      expect(nativeSave).toHaveBeenCalledTimes(1);
      expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
      Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
    },
  );

  it('preserves a blocking error when native Save rejects with only warning diagnostics', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Proposed';
    loadProject(
      saved,
      working,
      recoveryState({
        'record:rooms:foyer': {
          sequence: 1,
          patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Proposed' }],
          affectedPaths: ['/rooms/foyer/label'],
          pendingRawInputByPath: {},
          atomicTransactionGroupIds: [],
        },
      }),
    );
    useCommandStore.getState().enableNativeCommandMode(0);
    const nativeSave = vi.fn().mockResolvedValue({
      accepted: false,
      error: 'Native source transaction rejected.',
      diagnosticsAdded: [
        { code: 'native.notice', severity: 'warning', path: '/rooms/foyer', message: 'Notice.' },
      ],
      snapshot: { workingRevision: 0 },
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      writable: true,
      value: nativeSave,
    });
    const result = await saveActiveSaveUnit('record:rooms:foyer');
    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'warning', code: 'native.notice' }),
        expect.objectContaining({
          severity: 'error',
          message: 'Native source transaction rejected.',
        }),
      ]),
    );
    expect(nativeSave).toHaveBeenCalledTimes(1);
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('saves all native working owners in one revision-scoped atomic transaction', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Native Foyer';
    working.rooms.kitchen!.label = 'Native Kitchen';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Native Foyer' }],
        affectedPaths: ['/rooms/foyer/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:kitchen': {
        sequence: 2,
        patches: [{ op: 'replace', path: '/rooms/kitchen/label', value: 'Native Kitchen' }],
        affectedPaths: ['/rooms/kitchen/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    useCommandStore.getState().enableNativeCommandMode(0);
    const nativeSave = vi.fn().mockResolvedValue({
      accepted: true,
      error: '',
      snapshot: { workingRevision: 0 },
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      writable: true,
      value: nativeSave,
    });
    const result = await saveAllSaveUnits();
    expect(result).toMatchObject({
      success: true,
      status: 'saved',
      savedSaveUnitIds: ['record:rooms:foyer', 'record:rooms:kitchen'],
      remainingDirtySaveUnitIds: [],
    });
    expect(nativeSave).toHaveBeenCalledTimes(1);
    expect(nativeSave.mock.calls[0]?.[2]).toEqual(['record:rooms:foyer', 'record:rooms:kitchen']);
    expect((useProjectStore.getState().savedDocument as typeof working).rooms.foyer?.label).toBe(
      'Native Foyer',
    );
    expect((useProjectStore.getState().savedDocument as typeof working).rooms.kitchen?.label).toBe(
      'Native Kitchen',
    );
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('uses one native transaction for source-only Save All without legacy source writes', async () => {
    const project = projectWithRooms();
    loadProject(project, structuredClone(project), emptyEditorProjectState());
    useCommandStore.getState().enableNativeCommandMode(0);
    useProjectSourceStore.setState({
      projectSessionId: 'test-project-session',
      files: [helperSource],
      textById: { [helperSource.id]: 'return changed' },
      buffersById: {
        [helperSource.id]: {
          text: 'return changed',
          baseText: 'return clean',
          baseContentHash: sourceRevision,
          dirty: true,
          conflict: null,
        },
      },
    });
    const hash = `xxh3-128:${'e'.repeat(32)}`;
    const save = vi.fn().mockResolvedValue({
      accepted: true,
      error: '',
      snapshot: { workingRevision: 1 },
      textSourceDiskRevisions: { [helperSource.id]: hash },
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      writable: true,
      value: save,
    });
    const result = await saveAllSaveUnits();
    expect(result).toMatchObject({
      success: true,
      status: 'saved',
      savedSaveUnitIds: [`source-file:${helperSource.id}`],
      remainingDirtySaveUnitIds: [],
    });
    expect(save).toHaveBeenCalledWith('test-project-session', 0, [], {
      comments: 'keep',
      textPaths: [helperSource.id],
      textContents: { [helperSource.id]: 'return changed' },
    });
    expect(window.noveltea.writeProjectSource).not.toHaveBeenCalled();
    expect(useProjectSourceStore.getState().buffersById[helperSource.id]).toMatchObject({
      dirty: false,
      baseText: 'return changed',
      baseContentHash: hash,
    });
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('saves a dirty record and staged source atomically without partial baseline publication', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Native edited Room';
    loadProject(
      saved,
      working,
      recoveryState({
        'record:rooms:foyer': {
          sequence: 1,
          patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Native edited Room' }],
          affectedPaths: ['/rooms/foyer/label'],
          pendingRawInputByPath: {},
          atomicTransactionGroupIds: [],
        },
      }),
    );
    useCommandStore.getState().enableNativeCommandMode(0);
    useProjectSourceStore.setState({
      projectSessionId: 'test-project-session',
      files: [helperSource],
      textById: { [helperSource.id]: 'return changed' },
      buffersById: {
        [helperSource.id]: {
          text: 'return changed',
          baseText: 'return clean',
          baseContentHash: sourceRevision,
          dirty: true,
          conflict: null,
        },
      },
    });
    const hash = `xxh3-128:${'f'.repeat(32)}`;
    const save = vi
      .fn()
      .mockResolvedValueOnce({
        accepted: false,
        error: 'WORKSPACE_REVISION_CONFLICT',
        snapshot: { workingRevision: 0 },
      })
      .mockResolvedValueOnce({
        accepted: true,
        error: '',
        snapshot: { workingRevision: 1 },
        textSourceDiskRevisions: { [helperSource.id]: hash },
      });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      writable: true,
      value: save,
    });
    expect((await saveAllSaveUnits()).success).toBe(false);
    expect((useProjectStore.getState().savedDocument as typeof saved).rooms.foyer!.label).toBe(
      'Foyer',
    );
    expect(useProjectSourceStore.getState().buffersById[helperSource.id]!.dirty).toBe(true);
    expect((await saveAllSaveUnits()).success).toBe(true);
    expect(save).toHaveBeenCalledWith('test-project-session', 0, 'record:rooms:foyer', {
      comments: 'keep',
      textPaths: [helperSource.id],
      textContents: { [helperSource.id]: 'return changed' },
    });
    expect((useProjectStore.getState().savedDocument as typeof saved).rooms.foyer!.label).toBe(
      'Native edited Room',
    );
    expect(useProjectSourceStore.getState().buffersById[helperSource.id]).toMatchObject({
      dirty: false,
      baseContentHash: hash,
    });
    expect(window.noveltea.writeProjectSource).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('routes active source-file Save through the shared save coordinator', async () => {
    const project = projectWithRooms();
    loadProject(project, structuredClone(project), emptyEditorProjectState());
    useProjectSourceStore.setState({
      projectSessionId: 'test-project-session',
      files: [helperSource],
      textById: { [helperSource.id]: 'return dirty' },
      buffersById: {
        [helperSource.id]: {
          text: 'return dirty',
          baseText: 'return clean',
          baseContentHash: sourceRevision,
          dirty: true,
          conflict: null,
        },
      },
    });
    useWorkbenchStore.getState().openTab(buildProjectSourceTab(helperSource));
    vi.mocked(window.noveltea.writeProjectSource).mockResolvedValueOnce({
      ok: true,
      success: true,
      sourceId: helperSource.id,
      contentHash: `xxh3-128:${'c'.repeat(32)}`,
    });

    const result = await saveActiveSaveUnit();

    expect(result).toMatchObject({
      success: true,
      status: 'saved',
      savedSaveUnitIds: ['source-file:scripts/helpers.lua'],
      remainingDirtySaveUnitIds: [],
    });
    expect(window.noveltea.writeProjectSource).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: helperSource.id, text: 'return dirty' }),
    );
    expect(useProjectSourceStore.getState().buffersById[helperSource.id]?.dirty).toBe(false);
  });

  it('includes dirty source-file units in Save All even when Project JSON has no dirty units', async () => {
    const project = projectWithRooms();
    loadProject(project, structuredClone(project), emptyEditorProjectState());
    useCommandStore.getState().enableNativeCommandMode(0);
    useProjectSourceStore.setState({
      projectSessionId: 'test-project-session',
      files: [helperSource],
      textById: { [helperSource.id]: 'return dirty' },
      buffersById: {
        [helperSource.id]: {
          text: 'return dirty',
          baseText: 'return clean',
          baseContentHash: sourceRevision,
          dirty: true,
          conflict: null,
        },
      },
    });
    const save = vi.fn().mockResolvedValue({
      accepted: true,
      error: '',
      snapshot: { workingRevision: 0 },
      textSourceDiskRevisions: { [helperSource.id]: `xxh3-128:${'d'.repeat(32)}` },
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      value: save,
    });

    const result = await saveAllSaveUnits();

    expect(result).toMatchObject({
      success: true,
      status: 'saved',
      savedSaveUnitIds: ['source-file:scripts/helpers.lua'],
      remainingDirtySaveUnitIds: [],
    });
    expect(save).toHaveBeenCalledWith('test-project-session', 0, [], {
      comments: 'keep',
      textPaths: [helperSource.id],
      textContents: { [helperSource.id]: 'return dirty' },
    });
    expect(window.noveltea.writeProjectSource).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('surfaces source-save diagnostics when Save All cannot commit a dirty source', async () => {
    const project = projectWithRooms();
    loadProject(project, structuredClone(project), emptyEditorProjectState());
    useCommandStore.getState().enableNativeCommandMode(0);
    useProjectSourceStore.setState({
      projectSessionId: 'test-project-session',
      files: [helperSource],
      textById: { [helperSource.id]: 'return dirty' },
      buffersById: {
        [helperSource.id]: {
          text: 'return dirty',
          baseText: 'return clean',
          baseContentHash: sourceRevision,
          dirty: true,
          conflict: null,
        },
      },
    });
    const save = vi.fn().mockResolvedValue({
      accepted: false,
      error: 'source revision conflict',
      diagnosticsAdded: [
        {
          code: 'native.source.revision-conflict',
          severity: 'error',
          path: helperSource.id,
          message: 'source revision conflict',
        },
      ],
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      value: save,
    });

    const result = await saveAllSaveUnits();

    expect(result).toMatchObject({
      success: false,
      status: 'failed',
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: ['source-file:scripts/helpers.lua'],
      diagnostics: [
        expect.objectContaining({
          code: 'native.source.revision-conflict',
          path: helperSource.id,
          message: 'source revision conflict',
        }),
      ],
    });
    expect(window.noveltea.writeProjectSource).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('saves platform export profile edits from the Export tab', async () => {
    const saved = projectWithRooms();
    const native = admitNativeRendererCommandFixture(saved, 'test-project-session');

    const command = await useCommandStore.getState().executeCommandAsync({
      type: 'project.replaceAtPath',
      label: 'Update platform export profiles',
      payload: {
        path: '/export/profiles',
        value: [defaultPlatformExportProfile('windows')],
      },
      originSaveUnitId: 'project:platform-export-profiles',
      persistencePolicy: 'manual-save',
    });
    expect(command.ok).toBe(true);
    useWorkbenchStore.getState().openTab(buildPlatformExportTab());

    const result = await saveActiveSaveUnit();

    expect(result.success, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.savedSaveUnitIds).toContain('project:platform-export-profiles');
    expect(native.save).toHaveBeenCalledWith(
      'test-project-session',
      1,
      'project:platform-export-profiles',
      {
        comments: 'keep',
      },
    );
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      export: { profiles: [expect.objectContaining({ target: 'windows' })] },
    });
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
  });

  it('saves only the active unit and rebases the remaining recovery overlay', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'New Foyer';
    working.rooms.kitchen!.label = 'New Kitchen';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'New Foyer' }],
        affectedPaths: ['/rooms/foyer'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:kitchen': {
        sequence: 2,
        patches: [{ op: 'replace', path: '/rooms/kitchen/label', value: 'New Kitchen' }],
        affectedPaths: ['/rooms/kitchen'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    const nativeSave = admitNativeSaveWithoutExternalChanges();
    useWorkbenchStore.getState().openTab(roomTab('foyer'));
    const beforeProjectRevision = useProjectStore.getState().projectRevision;
    const beforePublication = useProjectStore.getState().lastMutationPublication;

    const result = await saveActiveSaveUnit();

    expect(result).toMatchObject({
      success: true,
      status: 'partially-saved',
      savedSaveUnitIds: ['record:rooms:foyer'],
      remainingDirtySaveUnitIds: ['record:rooms:kitchen'],
    });
    expect(nativeSave).toHaveBeenCalledWith('test-project-session', 0, 'record:rooms:foyer', {
      comments: 'keep',
    });
    const persistedEditor = buildEditorProjectStateSnapshot();
    expect(persistedEditor.recovery.saveUnitsById).toHaveProperty('record:rooms:kitchen');
    expect(persistedEditor.recovery.saveUnitsById).not.toHaveProperty('record:rooms:foyer');
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: {
        foyer: { label: 'New Foyer' },
        kitchen: { label: 'New Kitchen' },
      },
    });
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: {
        foyer: { label: 'New Foyer' },
        kitchen: { label: 'Kitchen' },
      },
    });
    expect(useProjectStore.getState().projectRevision).toBe(beforeProjectRevision);
    expect(useProjectStore.getState().lastMutationPublication).toBe(beforePublication);
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('saves selected tracked editor.yaml content without marking unrelated tracked editor content saved', async () => {
    const saved = projectWithRooms();
    saved.editor.tags.records.story = { name: 'Story', color: 'tag-slate' };
    saved.editor.recordMetadata.rooms = { foyer: { tags: [], color: null } };
    const working = structuredClone(saved);
    working.editor.tags.records.story!.color = 'tag-blue';
    working.editor.recordMetadata.rooms!.foyer!.tags = ['dirty'];
    const recovery = recoveryState({
      'project:tags': {
        sequence: 1,
        patches: [
          {
            op: 'replace',
            path: '/editor/tags/records/story/color',
            value: 'tag-blue',
          },
        ],
        affectedPaths: ['/editor/tags/records/story/color'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:foyer': {
        sequence: 2,
        patches: [
          {
            op: 'replace',
            path: '/editor/recordMetadata/rooms/foyer/tags',
            value: ['dirty'],
          },
        ],
        affectedPaths: ['/editor/recordMetadata/rooms/foyer/tags'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    const savedEditor = {
      ...recovery,
      chapters: saved.editor.chapters,
      tags: saved.editor.tags,
      recordMetadata: saved.editor.recordMetadata,
    };
    const workingEditor = {
      ...recovery,
      chapters: working.editor.chapters,
      tags: working.editor.tags,
      recordMetadata: working.editor.recordMetadata,
    };
    const savedDocument = mergeEditorProjectState(toJsonValue(saved), savedEditor);
    const workingDocument = mergeEditorProjectState(toJsonValue(working), workingEditor);
    useProjectStore.getState().loadProjectDocument({
      document: savedDocument,
      savedDocument,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.yaml',
      projectSessionId: 'test-project-session',
    });
    useProjectStore.getState().replaceDocumentFromCommand(workingDocument, 0);
    setLoadedEditorProjectState(workingEditor);
    const nativeSave = admitNativeSaveWithoutExternalChanges();

    const result = await saveActiveSaveUnit('project:tags');

    expect(result.success).toBe(true);
    expect(nativeSave).toHaveBeenCalledWith('test-project-session', 0, 'project:tags', {
      comments: 'keep',
    });
    const state = useProjectStore.getState();
    expect((state.savedDocument as typeof working).editor.tags.records.story?.color).toBe(
      'tag-blue',
    );
    expect(
      (state.savedDocument as typeof working).editor.recordMetadata.rooms?.foyer?.tags,
    ).toEqual([]);
    expect((state.document as typeof working).editor.recordMetadata.rooms?.foyer?.tags).toEqual([
      'dirty',
    ]);
    expect(result.remainingDirtySaveUnitIds).toContain('record:rooms:foyer');
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('reconciles unrelated external changes returned by a successful scoped save before adopting its revisions', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Local Foyer';
    working.rooms.kitchen!.label = 'Local Kitchen';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Local Foyer' }],
        affectedPaths: ['/rooms/foyer/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:kitchen': {
        sequence: 2,
        patches: [{ op: 'replace', path: '/rooms/kitchen/label', value: 'Local Kitchen' }],
        affectedPaths: ['/rooms/kitchen/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    useCommandStore.getState().enableNativeCommandMode(0);
    useWorkbenchStore.getState().openTab(roomTab('foyer'));
    const diskKitchen = structuredClone(saved.rooms.kitchen!);
    diskKitchen.label = 'Disk Kitchen';
    const nativeSave = vi.fn().mockResolvedValue({
      accepted: true,
      error: '',
      affectedRecords: ['rooms/foyer', 'rooms/kitchen'],
      snapshot: {
        workingRevision: 0,
        recordSnapshots: {
          'rooms/foyer': {
            source: working.rooms.foyer,
            baseline: working.rooms.foyer,
            diskSourceRevision: `xxh3-128:${'e'.repeat(32)}`,
            conflictingPaths: [],
          },
          'rooms/kitchen': {
            source: working.rooms.kitchen,
            baseline: diskKitchen,
            diskSourceRevision: `xxh3-128:${'f'.repeat(32)}`,
            conflictingPaths: ['/label'],
          },
        },
      },
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      value: nativeSave,
    });

    const result = await saveActiveSaveUnit();

    expect(result).toMatchObject({
      success: true,
      status: 'partially-saved',
      savedSaveUnitIds: ['record:rooms:foyer'],
      remainingDirtySaveUnitIds: ['record:rooms:kitchen'],
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'editor.external-change.conflict', severity: 'error' }),
    );
    const state = useProjectStore.getState();
    expect(state.document).toMatchObject({
      rooms: {
        foyer: { label: 'Local Foyer' },
        kitchen: { label: 'Local Kitchen' },
      },
    });
    expect(state.savedDocument).toMatchObject({
      rooms: {
        foyer: { label: 'Local Foyer' },
        kitchen: { label: 'Disk Kitchen' },
      },
    });
    expect(
      buildEditorProjectStateSnapshot().recovery.saveUnitsById['record:rooms:kitchen']
        ?.externalConflict,
    ).toMatchObject({
      conflictingPaths: ['/rooms/kitchen/label'],
      externalFileRevisions: {
        'records/rooms/kitchen.yaml': `xxh3-128:${'f'.repeat(32)}`,
      },
    });
    expect(nativeSave).toHaveBeenCalledWith('test-project-session', 0, 'record:rooms:foyer', {
      comments: 'keep',
    });
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('blocks a save unit with pending invalid raw input without writing', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'New Foyer';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'New Foyer' }],
        affectedPaths: ['/rooms/foyer'],
        pendingRawInputByPath: {
          '/rooms/foyer/data/zoom': { value: 'not-a-number' },
        },
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    useWorkbenchStore.getState().openTab(roomTab('foyer'));

    const result = await saveActiveSaveUnit();

    expect(result.status).toBe('blocked');
    expect(result.diagnostics[0]).toMatchObject({ code: 'editor.save.pending-input' });
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
  });

  it('blocks ordinary Save for an external conflict and Keep Mine writes against the external revision', async () => {
    const saved = projectWithRooms();
    saved.rooms.foyer!.label = 'Disk Foyer';
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Local Foyer';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Local Foyer' }],
        affectedPaths: ['/rooms/foyer/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
        externalConflict: {
          baseValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Foyer' },
          },
          localValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Local Foyer' },
          },
          externalValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Disk Foyer' },
          },
          conflictingPaths: ['/rooms/foyer/label'],
          externalFileRevisions: { 'records/rooms/foyer.yaml': roomFileRevision },
        },
      },
    });
    loadProject(saved, working, editorState);
    const nativeSave = admitNativeSaveWithoutExternalChanges();
    useWorkbenchStore.getState().openTab(roomTab('foyer'));

    const blocked = await saveActiveSaveUnit();
    expect(blocked).toMatchObject({ success: false, status: 'blocked' });
    expect(blocked.diagnostics[0]).toMatchObject({ code: 'editor.external-change.conflict' });
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();

    const resolved = await saveConflictingSaveUnitKeepMine('record:rooms:foyer');
    expect(resolved.success).toBe(true);
    expect(nativeSave).toHaveBeenCalledOnce();
    expect(nativeSave).toHaveBeenCalledWith('test-project-session', 0, 'record:rooms:foyer', {
      comments: 'keep',
      keepMine: true,
    });
    expect((useProjectStore.getState().savedDocument as typeof saved).rooms.foyer!.label).toBe(
      'Local Foyer',
    );
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('keeps the unit conflicted when Keep Mine loses its expected-revision race', async () => {
    const saved = projectWithRooms();
    saved.rooms.foyer!.label = 'Disk Foyer';
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Local Foyer';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Local Foyer' }],
        affectedPaths: ['/rooms/foyer/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
        externalConflict: {
          baseValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Foyer' },
          },
          localValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Local Foyer' },
          },
          externalValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Disk Foyer' },
          },
          conflictingPaths: ['/rooms/foyer/label'],
          externalFileRevisions: { 'records/rooms/foyer.yaml': roomFileRevision },
        },
      },
    });
    loadProject(saved, working, editorState);
    vi.mocked(window.noveltea.saveProjectContent).mockResolvedValueOnce({
      ok: false,
      success: false,
      error: 'Project source changed on disk before this save could commit.',
      diagnostics: [
        {
          code: 'WORKSPACE_REVISION_CONFLICT',
          severity: 'error',
          path: '/records/rooms/foyer.yaml',
          message: 'Project source changed on disk before this save could commit.',
        },
      ],
    });

    const result = await saveConflictingSaveUnitKeepMine('record:rooms:foyer');

    expect(result).toMatchObject({ success: false, status: 'failed' });
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Local Foyer' } },
    });
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: { foyer: { label: 'Disk Foyer' } },
    });
    expect(
      useProjectStore.getState().document &&
        (useProjectStore.getState().document as { editor?: EditorProjectState }).editor?.recovery
          .saveUnitsById['record:rooms:foyer']?.externalConflict,
    ).toBeDefined();
  });

  it('Use Disk discards only the conflicted save unit and keeps the external baseline', () => {
    const saved = projectWithRooms();
    saved.rooms.foyer!.label = 'Disk Foyer';
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Local Foyer';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Local Foyer' }],
        affectedPaths: ['/rooms/foyer/label'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
        externalConflict: {
          baseValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Foyer' },
          },
          localValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Local Foyer' },
          },
          externalValueByPath: {
            '/rooms/foyer/label': { exists: true, value: 'Disk Foyer' },
          },
          conflictingPaths: ['/rooms/foyer/label'],
          externalFileRevisions: { 'records/rooms/foyer.yaml': roomFileRevision },
        },
      },
    });
    loadProject(saved, working, editorState);

    expect(resolveExternalConflictUseDisk('record:rooms:foyer')).toBe(true);
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Disk Foyer' } },
    });
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: { foyer: { label: 'Disk Foyer' } },
    });
    expect(
      useProjectStore.getState().document &&
        (useProjectStore.getState().document as { editor?: EditorProjectState }).editor?.recovery
          .saveUnitsById,
    ).not.toHaveProperty('record:rooms:foyer');
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
  });

  it('ignores unchanged baseline authoring errors owned by an unrelated save unit', async () => {
    const saved = projectWithRooms();
    saved.rooms.kitchen!.label = '';
    const working = projectWithRooms();
    working.rooms.kitchen!.label = '';
    working.rooms.foyer!.label = 'New Foyer';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'New Foyer' }],
        affectedPaths: ['/rooms/foyer'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    const nativeSave = admitNativeSaveWithoutExternalChanges();
    useWorkbenchStore.getState().openTab(roomTab('foyer'));

    const result = await saveActiveSaveUnit();

    expect(result.status).toBe('saved');
    expect(nativeSave).toHaveBeenCalledWith('test-project-session', 0, 'record:rooms:foyer', {
      comments: 'keep',
    });
    expect((useProjectStore.getState().savedDocument as typeof saved).rooms.kitchen!.label).toBe(
      '',
    );
    expect((useProjectStore.getState().savedDocument as typeof saved).rooms.foyer!.label).toBe(
      'New Foyer',
    );
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('delegates dirty-dependency admission to native Save without writing a partial baseline', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.entrypoint = { kind: 'room', id: 'hall' };
    working.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      data: defaultRoomData('Hall'),
    };
    const editorState = recoveryState({
      'project:settings': {
        sequence: 1,
        patches: [{ op: 'add', path: '/entrypoint', value: { kind: 'room', id: 'hall' } }],
        affectedPaths: ['/entrypoint'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:hall': {
        sequence: 2,
        patches: [
          {
            op: 'add',
            path: '/rooms/hall',
            value: toJsonValue(working.rooms.hall),
          },
        ],
        affectedPaths: ['/rooms/hall'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    useCommandStore.getState().enableNativeCommandMode(0);
    const nativeSave = vi.fn().mockResolvedValue({
      accepted: false,
      error: 'Dirty Room dependency requires its own Save unit.',
      diagnosticsAdded: [
        {
          code: 'native.save.dependency-dirty',
          severity: 'error',
          path: '/rooms/hall',
          message: 'Dirty Room dependency requires its own Save unit.',
        },
      ],
    });
    Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
      configurable: true,
      value: nativeSave,
    });
    useWorkbenchStore.getState().openTab(buildProjectSettingsTab());

    const result = await saveActiveSaveUnit();

    expect(result).toMatchObject({
      success: false,
      status: 'failed',
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: ['project:settings', 'record:rooms:hall'],
    });
    expect(result.diagnostics[0]).toMatchObject({
      code: 'native.save.dependency-dirty',
      path: '/rooms/hall',
    });
    expect(nativeSave).toHaveBeenCalledWith('test-project-session', 0, 'project:settings', {
      comments: 'keep',
    });
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('commits every member of the active atomic transaction group together', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'New Foyer';
    working.rooms.kitchen!.label = 'New Kitchen';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'New Foyer' }],
        affectedPaths: ['/rooms/foyer'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: ['atomic:shared'],
      },
      'record:rooms:kitchen': {
        sequence: 2,
        patches: [{ op: 'replace', path: '/rooms/kitchen/label', value: 'New Kitchen' }],
        affectedPaths: ['/rooms/kitchen'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: ['atomic:shared'],
      },
    });
    loadProject(saved, working, editorState);
    const nativeSave = admitNativeSaveWithoutExternalChanges();
    useWorkbenchStore.getState().openTab(roomTab('foyer'));

    const result = await saveActiveSaveUnit();

    expect(result).toMatchObject({
      success: true,
      status: 'saved',
      savedSaveUnitIds: ['record:rooms:foyer', 'record:rooms:kitchen'],
    });
    expect(nativeSave).toHaveBeenCalledWith(
      'test-project-session',
      0,
      ['record:rooms:foyer', 'record:rooms:kitchen'],
      { comments: 'keep' },
    );
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('blocks atomic native Save All when any selected unit has invalid pending input', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'New Foyer';
    working.rooms.kitchen!.label = 'New Kitchen';
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'New Foyer' }],
        affectedPaths: ['/rooms/foyer'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:kitchen': {
        sequence: 2,
        patches: [{ op: 'replace', path: '/rooms/kitchen/label', value: 'New Kitchen' }],
        affectedPaths: ['/rooms/kitchen'],
        pendingRawInputByPath: {
          '/rooms/kitchen/data/zoom': { value: 'invalid' },
        },
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    const nativeSave = admitNativeSaveWithoutExternalChanges();

    const result = await saveAllSaveUnits();

    expect(result).toMatchObject({
      success: false,
      status: 'blocked',
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: ['record:rooms:foyer', 'record:rooms:kitchen'],
    });
    expect(result.diagnostics[0]).toMatchObject({ code: 'editor.save.pending-input' });
    expect(nativeSave).not.toHaveBeenCalled();
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('sends dependent dirty owners in one revision-bound native Save All', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.entrypoint = { kind: 'room', id: 'hall' };
    working.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      data: defaultRoomData('Hall'),
    };
    const editorState = recoveryState({
      'project:settings': {
        sequence: 1,
        patches: [{ op: 'add', path: '/entrypoint', value: { kind: 'room', id: 'hall' } }],
        affectedPaths: ['/entrypoint'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:rooms:hall': {
        sequence: 2,
        patches: [
          {
            op: 'add',
            path: '/rooms/hall',
            value: toJsonValue(working.rooms.hall),
          },
        ],
        affectedPaths: ['/rooms/hall'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);
    const nativeSave = admitNativeSaveWithoutExternalChanges();

    const result = await saveAllSaveUnits();

    expect(result).toMatchObject({
      success: true,
      status: 'saved',
      savedSaveUnitIds: ['project:settings', 'record:rooms:hall'],
      remainingDirtySaveUnitIds: [],
    });
    expect(nativeSave).toHaveBeenCalledWith(
      'test-project-session',
      0,
      ['project:settings', 'record:rooms:hall'],
      { comments: 'keep' },
    );
    expect((useProjectStore.getState().savedDocument as typeof working).rooms.hall).toMatchObject({
      id: 'hall',
    });
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    Reflect.deleteProperty(window.noveltea, 'nativeProjectSaveUnit');
  });

  it('Save As copies the saved baseline plus complete recovery without changing identity', async () => {
    const saved = projectWithRooms();
    const working = projectWithRooms();
    working.rooms.foyer!.label = 'Dirty Foyer';
    working.assets.cover = {
      id: 'cover',
      label: 'Cover',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/cover.png' },
        aliases: [],
        extension: '.png',
        imageMetadata: { width: 1280, height: 720, hasAlpha: true, orientation: 1 },
      },
    };
    const editorState = recoveryState({
      'record:rooms:foyer': {
        sequence: 1,
        patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Dirty Foyer' }],
        affectedPaths: ['/rooms/foyer'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
      'record:assets:cover': {
        sequence: 2,
        patches: [
          {
            op: 'add',
            path: '/assets/cover',
            value: toJsonValue(working.assets.cover),
          },
        ],
        affectedPaths: ['/assets/cover'],
        pendingRawInputByPath: {},
        atomicTransactionGroupIds: [],
      },
    });
    loadProject(saved, working, editorState);

    const result = await saveProjectAsCopy();

    expect(result.success).toBe(true);
    const [projectSessionId, copy, workingAssetPaths] = vi.mocked(window.noveltea.saveProjectCopyAs)
      .mock.calls[0]!;
    expect(projectSessionId).toBe('test-project-session');
    expect(copy).toMatchObject({
      rooms: { foyer: { label: 'Foyer' } },
      editor: {
        recovery: { saveUnitsById: { 'record:rooms:foyer': expect.any(Object) } },
      },
    });
    expect(workingAssetPaths).toEqual(['assets/images/cover.png']);
    expect(useProjectStore.getState().projectFilePath).toBe('/mock/project/game.json');
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Dirty Foyer' } },
    });
  });
});
