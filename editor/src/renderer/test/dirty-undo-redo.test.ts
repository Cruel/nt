import { beforeEach, describe, expect, it } from 'vitest';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { getTabDirtyState } from '@/workbench/dirty-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';

const tab: WorkbenchTab = {
  id: 'tab:rooms:foyer',
  title: 'foyer',
  editorType: 'raw-json',
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
  useProjectStore.getState().loadProjectDocument({
    document: { rooms: { foyer: { id: 'foyer', label: 'Foyer' } } },
    projectPath: '/mock/project',
    projectFilePath: '/mock/project/game.json',
  });
  useCommandStore.getState().resetCommandHistory();
});

describe('dirty tab undo and redo behavior', () => {
  it('clears resource dirty state when undo restores the saved value', () => {
    expect(tabDirty()).toBe(false);

    const edit = useCommandStore.getState().executeCommand({
      type: 'project.replaceAtPath',
      label: 'Rename foyer',
      payload: { path: '/rooms/foyer/label', value: 'New Foyer' },
    });
    expect(edit.ok).toBe(true);
    expect(tabDirty()).toBe(true);

    const undo = useCommandStore.getState().undo();
    expect(undo.ok).toBe(true);
    expect(tabDirty()).toBe(false);

    const redo = useCommandStore.getState().redo();
    expect(redo.ok).toBe(true);
    expect(tabDirty()).toBe(true);
  });
});
