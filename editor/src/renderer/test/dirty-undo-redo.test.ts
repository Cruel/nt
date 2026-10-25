import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { getTabDirtyState } from '@/workbench/dirty-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { admitNativeRendererCommandFixture } from '../test-support/native-acknowledged-command-fixture';

const tab: WorkbenchTab = {
  id: 'tab:rooms:foyer',
  title: 'foyer',
  editorType: 'room-detail',
  resource: {
    kind: 'record',
    stableId: 'record:rooms:foyer',
    collection: 'rooms',
    entityId: 'foyer',
  },
};

function tabDirty() {
  const project = useProjectStore.getState();
  return getTabDirtyState(tab, project.document, project.savedDocument, {}).dirty;
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
  admitNativeRendererCommandFixture(project);
});

describe('dirty tab undo and redo behavior', () => {
  it('clears resource dirty state when native undo restores the saved value', async () => {
    expect(tabDirty()).toBe(false);

    const edit = await useCommandStore.getState().executeCommandAsync({
      type: 'project.replaceAtPath',
      label: 'Rename foyer',
      payload: { path: '/rooms/foyer/label', value: 'New Foyer' },
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    expect(edit.ok).toBe(true);
    expect(tabDirty()).toBe(true);

    const undo = await useCommandStore.getState().undoAsync();
    expect(undo.ok).toBe(true);
    expect(tabDirty()).toBe(false);

    const redo = await useCommandStore.getState().redoAsync();
    expect(redo.ok).toBe(true);
    expect(tabDirty()).toBe(true);
  });
});
