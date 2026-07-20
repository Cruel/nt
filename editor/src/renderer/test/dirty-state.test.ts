import { describe, expect, it } from 'vite-plus/test';
import {
  getResourceDirtyState,
  getTabDirtyState,
  restoreResourcePatchesFromSaved,
  restoreSaveUnitPatchesFromSaved,
} from '@/workbench/dirty-state';
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
    expect(getResourceDirtyState(tab.resource, current, null)).toMatchObject({
      dirty: true,
      currentExists: true,
      savedExists: false,
    });
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

  it('shares one persistent dirty result across duplicate views of the same save unit', () => {
    const duplicate = { ...tab, id: 'tab:materials:panel:duplicate' };
    const current = { materials: { panel: { id: 'panel', label: 'New Panel' } } };
    const saved = { materials: { panel: { id: 'panel', label: 'Panel' } } };
    const first = getTabDirtyState(tab, current, saved, {});
    const second = getTabDirtyState(duplicate, current, saved, {});
    expect(first).toMatchObject({ dirty: true, saveUnitId: 'record:materials:panel' });
    expect(second).toMatchObject({ dirty: true, saveUnitId: first.saveUnitId });
  });

  it('tracks Project Settings dirty state across its exact owned paths', () => {
    const settingsTab: WorkbenchTab = {
      id: 'tab:project-settings',
      title: 'Project Settings',
      editorType: 'project-settings',
      resource: { kind: 'project', stableId: 'project:settings' },
    };
    const saved = {
      project: { name: 'Story' },
      settings: { display: {} },
      startupHook: null,
      entrypoint: null,
      rooms: {},
    };
    const current = { ...saved, project: { name: 'Edited Story' } };
    expect(getTabDirtyState(settingsTab, current, saved, {})).toMatchObject({
      dirty: true,
      saveUnitId: 'project:settings',
      resourcePaths: ['/entrypoint', '/project', '/settings', '/startupHook'],
    });
    expect(restoreSaveUnitPatchesFromSaved(settingsTab, current, saved)).toEqual([
      { op: 'replace', path: '/entrypoint', value: null },
      { op: 'replace', path: '/project', value: { name: 'Story' } },
      { op: 'replace', path: '/settings', value: { display: {} } },
      { op: 'replace', path: '/startupHook', value: null },
    ]);
  });

  it('shares pending Project Settings input across duplicate views without document changes', () => {
    const settingsTab: WorkbenchTab = {
      id: 'tab:project-settings',
      title: 'Project Settings',
      editorType: 'project-settings',
      resource: { kind: 'project', stableId: 'project:settings' },
    };
    const duplicate = { ...settingsTab, id: 'tab:project-settings:duplicate' };
    const document = {
      project: { name: 'Story' },
      settings: { display: {} },
      startupHook: null,
      entrypoint: null,
    };
    const pendingSaveUnitIds = new Set(['project:settings']);

    expect(getTabDirtyState(settingsTab, document, document, {}, pendingSaveUnitIds)).toMatchObject(
      {
        dirty: true,
        persistentDirty: false,
        pendingInputDirty: true,
        saveUnitId: 'project:settings',
      },
    );
    expect(getTabDirtyState(duplicate, document, document, {}, pendingSaveUnitIds)).toMatchObject({
      dirty: true,
      pendingInputDirty: true,
      saveUnitId: 'project:settings',
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
