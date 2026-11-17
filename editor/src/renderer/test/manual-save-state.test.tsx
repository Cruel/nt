import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { toJsonValue } from '../project/json-value';
import { useProjectStore } from '../project/project-store';
import {
  projectRequiresManualSave,
  useManualSaveDirty,
  isAutosavedNativeFieldDraft,
} from '../project/manual-save-state';
import { useDraftDirtyStore } from '../workbench/draft-dirty-store';
import { usePendingInputStore } from '../workbench/pending-input-store';
import { useConfigurationAutosaveStatus } from '../project/project-configuration-autosave';
import { NATIVE_FIELD_DRAFT_SCHEMA, nativeFieldDraftKey } from '../commands/native-field-drafts';

const initial = () => createAuthoringProject();

function edit(project: ReturnType<typeof initial>) {
  return structuredClone(project);
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useDraftDirtyStore.getState().resetDraftDirty();
  usePendingInputStore.getState().resetPendingInputs();
  useConfigurationAutosaveStatus.setState({
    projectInstanceId: null,
    pendingOwners: [],
    failedOwners: [],
    blockedOwners: [],
    recoveredOwners: [],
    errorsByOwner: {},
  });
});

describe('manual Save presentation policy', () => {
  it('excludes Project Settings and Export profile edits but preserves physical dirty truth', () => {
    const saved = initial();
    const working = edit(saved);
    working.project.name = 'Modified title';
    working.settings.display.barColor = '#121212';
    working.export.runtime.localization.quality = 'release';

    expect(projectRequiresManualSave(toJsonValue(working), toJsonValue(saved))).toBe(false);
    const differentRoom = edit(working);
    differentRoom.rooms.foyer = {
      id: 'foyer',
      label: 'Changed Room',
      data: defaultRoomData('Changed Room'),
    };
    expect(projectRequiresManualSave(toJsonValue(differentRoom), toJsonValue(saved))).toBe(true);
  });

  it('preserves independent non-autosaved fields under export', () => {
    const saved = toJsonValue({ export: { runtime: { value: 1 }, profiles: [], local: 1 } });
    const configOnly = toJsonValue({ export: { runtime: { value: 2 }, profiles: [1], local: 1 } });
    const manual = toJsonValue({ export: { runtime: { value: 2 }, profiles: [], local: 2 } });
    expect(projectRequiresManualSave(configOnly, saved)).toBe(false);
    expect(projectRequiresManualSave(manual, saved)).toBe(true);
  });

  it('excludes local editor metadata but retains tracked organization', () => {
    const saved = toJsonValue({
      editor: { previewLocale: 'en', recordMetadata: {}, chapters: { records: {} } },
    });
    const localOnly = toJsonValue({
      editor: { previewLocale: 'fr', recordMetadata: {}, chapters: { records: {} } },
    });
    const withChapters = toJsonValue({
      editor: { previewLocale: 'fr', recordMetadata: {}, chapters: { records: { a: {} } } },
    });
    expect(projectRequiresManualSave(localOnly, saved)).toBe(false);
    expect(projectRequiresManualSave(withChapters, saved)).toBe(true);
  });

  it('does not hide malformed or non-autosaved draft input', () => {
    const entry = {
      key: nativeFieldDraftKey('project:settings', '/project/name'),
      tabId: 'settings',
      dirty: true,
      schema: NATIVE_FIELD_DRAFT_SCHEMA,
    };
    expect(isAutosavedNativeFieldDraft(entry)).toBe(true);
    expect(
      isAutosavedNativeFieldDraft({
        ...entry,
        key: nativeFieldDraftKey('record:rooms:foyer', '/rooms/foyer/label'),
      }),
    ).toBe(false);
    expect(isAutosavedNativeFieldDraft({ ...entry, key: 'native-field:bad-json' })).toBe(false);
    expect(isAutosavedNativeFieldDraft({ ...entry, schema: 'custom-form-draft' })).toBe(false);
  });

  it('does not offer manual Save during healthy autosave, but does on failure or unrelated dirty content', () => {
    const saved = initial();
    act(() => {
      useProjectStore.getState().loadProjectDocument({
        document: toJsonValue(saved),
        savedDocument: toJsonValue(saved),
        nativeSession: true,
        projectPath: '/mock/project',
        projectFilePath: '/mock/project/project.yaml',
        projectSessionId: '11111111-1111-4111-8111-111111111111',
      });
    });
    const instance = useProjectStore.getState().projectInstanceId;
    const { result } = renderHook(() => useManualSaveDirty());
    expect(result.current).toBe(false);

    const working = edit(saved);
    working.project.name = 'Typing a new title';
    act(() => {
      useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(working), 0);
      useConfigurationAutosaveStatus.setState({
        projectInstanceId: instance,
        pendingOwners: ['project:settings'],
        failedOwners: [],
        blockedOwners: [],
        recoveredOwners: [],
        errorsByOwner: {},
      });
      useDraftDirtyStore
        .getState()
        .setDraftDirty(nativeFieldDraftKey('project:settings', '/project/name'), {
          tabId: 'tab:project-settings',
          dirty: true,
          schema: NATIVE_FIELD_DRAFT_SCHEMA,
          payload: { value: 'Typing a new title' },
        });
      usePendingInputStore
        .getState()
        .setPendingInput('project:settings', '/settings/display/referenceResolution/width', {
          value: '-',
        });
    });
    expect(result.current).toBe(false);
    act(() => {
      useDraftDirtyStore
        .getState()
        .clearDraftDirty(nativeFieldDraftKey('project:settings', '/project/name'));
      usePendingInputStore
        .getState()
        .clearPendingInput('project:settings', '/settings/display/referenceResolution/width');
      useConfigurationAutosaveStatus.setState({
        projectInstanceId: instance,
        pendingOwners: [],
        failedOwners: ['project:settings'],
        blockedOwners: [],
        recoveredOwners: [],
        errorsByOwner: { 'project:settings': 'Save failed' },
      });
    });
    expect(result.current).toBe(true);
    act(() => {
      useConfigurationAutosaveStatus.setState({
        projectInstanceId: instance,
        pendingOwners: ['project:settings'],
        failedOwners: [],
        blockedOwners: [],
        recoveredOwners: [],
        errorsByOwner: {},
      });
      usePendingInputStore
        .getState()
        .setPendingInput('record:rooms:foyer', '/rooms/foyer/data/name', { value: '-' });
    });
    expect(result.current).toBe(true);
  });
});
