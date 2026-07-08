import { describe, expect, it } from 'vitest';
import { getResourceDirtyState, getTabDirtyState, restoreResourcePatchesFromSaved } from '@/workbench/dirty-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';

const tab: WorkbenchTab = {
  id: 'tab:materials:panel',
  title: 'panel',
  editorType: 'material-detail',
  resource: {
    kind: 'record',
    stableId: 'record:materials:panel',
    collection: 'materials',
    entityId: 'panel',
  },
};

describe('workbench dirty state', () => {
  it('keeps record resources clean when current and saved values match', () => {
    const document = { materials: { panel: { id: 'panel', label: 'Panel' } } };
    expect(getResourceDirtyState(tab.resource, document, document)).toMatchObject({
      dirty: false,
      path: '/materials/panel',
      currentExists: true,
      savedExists: true,
    });
  });

  it('marks record resources dirty when current and saved values differ', () => {
    const current = { materials: { panel: { id: 'panel', label: 'New Panel' } } };
    const saved = { materials: { panel: { id: 'panel', label: 'Panel' } } };
    expect(getResourceDirtyState(tab.resource, current, saved).dirty).toBe(true);
  });

  it('marks new unsaved records dirty without a saved baseline', () => {
    const current = { materials: { panel: { id: 'panel', label: 'Panel' } } };
    expect(getResourceDirtyState(tab.resource, current, null)).toMatchObject({ dirty: true, currentExists: true, savedExists: false });
  });

  it('combines persistent and draft dirty state for tab markers', () => {
    const document = { materials: { panel: { id: 'panel', label: 'Panel' } } };
    expect(getTabDirtyState(tab, document, document, {}).dirty).toBe(false);
    expect(getTabDirtyState(tab, document, document, { [tab.id]: true })).toMatchObject({
      dirty: true,
      persistentDirty: false,
      draftDirty: true,
    });
  });

  it('builds discard patches that restore saved resource values', () => {
    const current = { materials: { panel: { id: 'panel', label: 'New Panel' } } };
    const saved = { materials: { panel: { id: 'panel', label: 'Panel' } } };
    expect(restoreResourcePatchesFromSaved(tab.resource, current, saved)).toEqual([
      { op: 'replace', path: '/materials/panel', value: { id: 'panel', label: 'Panel' } },
    ]);
  });

  it('builds discard patches that remove newly-created unsaved records', () => {
    const current = { materials: { panel: { id: 'panel', label: 'Panel' } } };
    expect(restoreResourcePatchesFromSaved(tab.resource, current, null)).toEqual([
      { op: 'remove', path: '/materials/panel' },
    ]);
  });
});
