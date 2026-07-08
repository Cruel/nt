import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEditorProjectStateSnapshot, restoreEditorProjectState } from '@/workbench/project-editor-state';
import {
  clearWorkbenchTabStates,
  registerWorkbenchTabStateHandle,
  serializeWorkbenchTabStates,
  setWorkbenchTabState,
  useWorkbenchTabStateStore,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';
import { WorkbenchGroup } from '@/workbench/WorkbenchGroup';
import { WorkbenchTabDndContext } from '@/workbench/WorkbenchTabDndContext';
import { ROOT_GROUP_ID } from '@/workbench/workbench-model';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useProjectStore } from '@/project/project-store';
import type { JsonValue } from '@/project/json-value';
import type { WorkbenchGroup as WorkbenchGroupModel, WorkbenchTab } from '@/workbench/workbench-types';

const TEST_TAB_STATE_SCHEMA = 'noveltea.editor.test-tab-state';

function state(value: string): WorkbenchTabStatePayload {
  return {
    schema: TEST_TAB_STATE_SCHEMA,
    schemaVersion: 1,
    payload: { value },
  };
}

function payloadValue(payload: WorkbenchTabStatePayload | undefined): string | undefined {
  const value = payload?.payload;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? String((value as Record<string, unknown>).value)
    : undefined;
}

function rawTab(id: string): WorkbenchTab {
  return {
    id: `tab:${id}`,
    title: id,
    editorType: 'test-normal-editor',
    resource: {
      kind: 'record',
      stableId: `record:rooms:${id}`,
      collection: 'rooms',
      entityId: id,
    },
  };
}

const lifecycle = vi.hoisted(() => ({
  currentValues: new Map<string, string>(),
  restoredValues: [] as Array<{ tabId: string; value: string }>,
}));

vi.mock('@/workbench/default-editors', async () => {
  const React = await import('react');
  const tabState = await import('@/workbench/workbench-tab-state');

  function TestNormalEditor({ tab }: { tab: WorkbenchTab }) {
    const handle = React.useMemo(() => ({
      captureTabState: () => ({
        schema: TEST_TAB_STATE_SCHEMA,
        schemaVersion: 1,
        payload: { value: lifecycle.currentValues.get(tab.id) ?? 'unset' },
      }),
      restoreTabState: (nextState: WorkbenchTabStatePayload) => {
        lifecycle.restoredValues.push({ tabId: tab.id, value: payloadValue(nextState) ?? 'missing' });
      },
    }), [tab.id]);
    tabState.useWorkbenchEditorTabState(tab.id, handle);
    return <div data-testid={`editor-${tab.id}`}>{tab.title}</div>;
  }

  function TestKeepMountedEditor({ tab }: { tab: WorkbenchTab }) {
    tabState.useWorkbenchEditorTabState(tab.id, {
      captureTabState: () => state(lifecycle.currentValues.get(tab.id) ?? 'keep-mounted'),
      restoreTabState: (nextState) => {
        lifecycle.restoredValues.push({ tabId: tab.id, value: payloadValue(nextState) ?? 'missing' });
      },
    });
    return <div data-testid={`editor-${tab.id}`}>{tab.title}</div>;
  }

  return {
    defaultEditorRegistry: {
      resolve: (editorType: string) => {
        if (editorType === 'test-normal-editor') {
          return {
            type: 'test-normal-editor',
            label: 'Normal',
            component: TestNormalEditor,
          };
        }
        if (editorType === 'test-keep-mounted-editor') {
          return {
            type: 'test-keep-mounted-editor',
            label: 'Keep Mounted',
            component: TestKeepMountedEditor,
            mountPolicy: 'keep-mounted-while-open',
          };
        }
        return null;
      },
      list: () => [],
    },
  };
});

function group(activeTabId: string | null, tabIds: string[]): WorkbenchGroupModel {
  return {
    id: ROOT_GROUP_ID,
    tabIds,
    activeTabId,
    activationHistory: activeTabId ? [activeTabId] : [],
  };
}

function renderGroup(model: WorkbenchGroupModel, tabs: WorkbenchTab[]) {
  return render(
    <WorkbenchTabDndContext>
      <WorkbenchGroup group={model} tabs={tabs} />
    </WorkbenchTabDndContext>,
  );
}

beforeEach(() => {
  clearWorkbenchTabStates();
  lifecycle.currentValues.clear();
  lifecycle.restoredValues = [];
  useWorkbenchStore.getState().resetWorkbench();
  useProjectStore.getState().loadProjectDocument({
    document: { schema: 'noveltea.authoring.project', rooms: {} },
    projectPath: '/mock',
    projectFilePath: '/mock/project.json',
  });
});

describe('workbench tab-state registry', () => {
  it('registers and unregisters a runtime-only tab-state handle', () => {
    const captures: string[] = [];
    const restores: string[] = [];
    const unregister = registerWorkbenchTabStateHandle('tab:one', {
      captureTabState: () => {
        captures.push('capture');
        return state('captured');
      },
      restoreTabState: (nextState) => {
        restores.push(payloadValue(nextState) ?? 'missing');
      },
    });

    expect(serializeWorkbenchTabStates()).toEqual({});
    expect(serializeWorkbenchTabStates(['tab:one'])).toEqual({});

    act(() => {
      useWorkbenchStore.getState().openTab(rawTab('one'));
      useWorkbenchStore.getState().activateTab(ROOT_GROUP_ID, 'tab:one');
    });

    expect(captures).toContain('capture');
    unregister();
    setWorkbenchTabState('tab:one', state('after-unregister'));
    act(() => useWorkbenchStore.getState().activateTab(ROOT_GROUP_ID, 'tab:one'));
    expect(restores).not.toContain('after-unregister');
  });

  it('keeps a payload pending when no handle exists and restores it on registration', () => {
    setWorkbenchTabState('tab:late', state('pending'));
    const restores: string[] = [];

    registerWorkbenchTabStateHandle('tab:late', {
      captureTabState: () => state('captured'),
      restoreTabState: (nextState) => {
        restores.push(payloadValue(nextState) ?? 'missing');
      },
    });

    expect(restores).toEqual(['pending']);
  });
});

describe('workbench tab-state lifecycle', () => {
  it('captures active-only tab state before tab switch unmount and restores on remount', async () => {
    const first = rawTab('one');
    const second = rawTab('two');
    lifecycle.currentValues.set(first.id, 'scroll-42');

    const view = renderGroup(group(first.id, [first.id, second.id]), [first, second]);
    expect(screen.getByTestId(`editor-${first.id}`)).toBeInTheDocument();

    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={group(second.id, [first.id, second.id])} tabs={[first, second]} />
      </WorkbenchTabDndContext>,
    );

    expect(payloadValue(useWorkbenchTabStateStore.getState().tabStatesById[first.id])).toBe('scroll-42');

    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={group(first.id, [first.id, second.id])} tabs={[first, second]} />
      </WorkbenchTabDndContext>,
    );

    await waitFor(() => expect(lifecycle.restoredValues).toContainEqual({ tabId: first.id, value: 'scroll-42' }));
  });

  it('captures before store-driven activation and restores when the tab is activated again', async () => {
    const first = rawTab('one');
    const second = rawTab('two');
    lifecycle.currentValues.set(first.id, 'store-switch');

    useWorkbenchStore.getState().openTab(first);
    useWorkbenchStore.getState().openTab(second);
    const view = renderGroup(useWorkbenchStore.getState().groupsById[ROOT_GROUP_ID]!, [first, second]);

    act(() => useWorkbenchStore.getState().activateTab(ROOT_GROUP_ID, first.id));
    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={useWorkbenchStore.getState().groupsById[ROOT_GROUP_ID]!} tabs={[first, second]} />
      </WorkbenchTabDndContext>,
    );

    act(() => useWorkbenchStore.getState().activateTab(ROOT_GROUP_ID, second.id));
    expect(payloadValue(useWorkbenchTabStateStore.getState().tabStatesById[first.id])).toBe('store-switch');
    lifecycle.currentValues.set(first.id, 'cleanup-overwrite');
    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={useWorkbenchStore.getState().groupsById[ROOT_GROUP_ID]!} tabs={[first, second]} />
      </WorkbenchTabDndContext>,
    );
    expect(payloadValue(useWorkbenchTabStateStore.getState().tabStatesById[first.id])).toBe('store-switch');

    act(() => useWorkbenchStore.getState().activateTab(ROOT_GROUP_ID, first.id));
    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={useWorkbenchStore.getState().groupsById[ROOT_GROUP_ID]!} tabs={[first, second]} />
      </WorkbenchTabDndContext>,
    );

    await waitFor(() => expect(lifecycle.restoredValues).toContainEqual({ tabId: first.id, value: 'store-switch' }));
  });

  it('retains recently closed tab state, restores on reopen, and expires trimmed entries', () => {
    const tabs = Array.from({ length: 21 }, (_, index) => rawTab(`tab-${index}`));
    for (const tab of tabs) {
      useWorkbenchStore.getState().openTab(tab);
      setWorkbenchTabState(tab.id, state(`state:${tab.id}`));
    }

    useWorkbenchStore.getState().closeAllTabsInGroup(ROOT_GROUP_ID);

    const workbench = useWorkbenchStore.getState();
    expect(workbench.recentlyClosedTabs).toHaveLength(20);
    expect(workbench.recentlyClosedTabs[0]?.tabState).toEqual(state(`state:${tabs[20]!.id}`));
    expect(useWorkbenchTabStateStore.getState().tabStatesById[tabs[0]!.id]).toBeUndefined();

    useWorkbenchStore.getState().reopenLastClosedTab();
    expect(useWorkbenchStore.getState().tabsById[tabs[20]!.id]).toBeTruthy();
    expect(payloadValue(useWorkbenchTabStateStore.getState().tabStatesById[tabs[20]!.id])).toBe(`state:${tabs[20]!.id}`);
  });

  it('deletes retained state when the workbench reset discards recently closed entries', () => {
    const tab = rawTab('reset');
    useWorkbenchStore.getState().openTab(tab);
    setWorkbenchTabState(tab.id, state('reset-state'));
    useWorkbenchStore.getState().closeTab(ROOT_GROUP_ID, tab.id);

    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]).toBeTruthy();

    useWorkbenchStore.getState().resetWorkbench();

    expect(useWorkbenchStore.getState().recentlyClosedTabs).toEqual([]);
    expect(useWorkbenchTabStateStore.getState().tabStatesById).toEqual({});
  });

  it('keeps duplicate tab ids independent even when they share one resource', () => {
    const first = rawTab('shared');
    const duplicate = { ...rawTab('shared'), id: 'tab:shared-duplicate' };
    useWorkbenchStore.getState().openTab(first);
    useWorkbenchStore.getState().openTab(duplicate, { duplicate: true });

    setWorkbenchTabState(first.id, state('first'));
    setWorkbenchTabState(duplicate.id, state('duplicate'));

    expect(payloadValue(useWorkbenchTabStateStore.getState().tabStatesById[first.id])).toBe('first');
    expect(payloadValue(useWorkbenchTabStateStore.getState().tabStatesById[duplicate.id])).toBe('duplicate');
  });
});

describe('workbench tab-state project snapshots', () => {
  it('serializes open project tab states and restores only valid project tabs', () => {
    useProjectStore.getState().loadProjectDocument({
      document: {
        schema: 'noveltea.authoring.project',
        rooms: {
          one: { id: 'one', label: 'One', tags: [], data: {} },
        },
      },
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    const tab = rawTab('one');
    useWorkbenchStore.getState().openTab(tab);
    setWorkbenchTabState(tab.id, state('project-state'));

    const snapshot = buildEditorProjectStateSnapshot();
    expect(snapshot.workbench?.tabsById[tab.id]).toBeTruthy();
    expect(payloadValue(snapshot.tabStatesById[tab.id])).toBe('project-state');

    clearWorkbenchTabStates();
    useWorkbenchStore.getState().resetWorkbench();
    const restoredProject = JSON.parse(JSON.stringify({
      schema: 'noveltea.authoring.project',
      rooms: {
        one: { id: 'one', label: 'One', tags: [], data: {} },
      },
      editor: {
        ...snapshot,
        tabStatesById: {
          [tab.id]: state('restored'),
          'tab:missing': state('missing'),
        },
      },
    })) as JsonValue;
    restoreEditorProjectState(restoredProject, '/mock/project.json');

    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeTruthy();
    expect(payloadValue(useWorkbenchTabStateStore.getState().tabStatesById[tab.id])).toBe('restored');
    expect(useWorkbenchTabStateStore.getState().tabStatesById['tab:missing']).toBeUndefined();
  });
});
