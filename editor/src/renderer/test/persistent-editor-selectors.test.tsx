import { render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  createEditorRegistry,
  missingEditorRegistration,
  resolveWorkbenchEditor,
} from '@/workbench/editor-registry';
import {
  selectOpenPersistentWorkbenchTabs,
  selectWorkbenchTabGroupId,
} from '@/workbench/persistent-editor-selectors';
import {
  useWorkbenchEditorLocation,
  WorkbenchEditorLocationProvider,
  type WorkbenchEditorLocation,
} from '@/workbench/workbench-editor-location';
import type { WorkbenchState, WorkbenchTab } from '@/workbench/workbench-types';

const persistentTab: WorkbenchTab = {
  id: 'tab:persistent',
  title: 'Persistent',
  editorType: 'persistent',
};
const inactivePersistentTab: WorkbenchTab = {
  id: 'tab:persistent-inactive',
  title: 'Inactive persistent',
  editorType: 'persistent',
};
const activeOnlyTab: WorkbenchTab = {
  id: 'tab:active-only',
  title: 'Active only',
  editorType: 'active-only',
};
const missingTab: WorkbenchTab = {
  id: 'tab:missing',
  title: 'Missing',
  editorType: 'not-registered',
};

const registry = createEditorRegistry([
  {
    type: 'persistent',
    label: 'Persistent',
    component: () => null,
    mountPolicy: 'keep-mounted-while-open',
  },
  {
    type: 'active-only',
    label: 'Active only',
    component: () => null,
  },
]);

function stateWithPersistentTabIn(groupId: string): WorkbenchState {
  return {
    layout: {
      kind: 'split',
      id: 'split:root',
      direction: 'horizontal',
      children: [
        { kind: 'group', groupId: 'group:left' },
        { kind: 'group', groupId: 'group:right' },
      ],
    },
    groupsById: {
      'group:left': {
        id: 'group:left',
        tabIds: groupId === 'group:left' ? [persistentTab.id, inactivePersistentTab.id] : [inactivePersistentTab.id],
        activeTabId: inactivePersistentTab.id,
      },
      'group:right': {
        id: 'group:right',
        tabIds: [activeOnlyTab.id, missingTab.id, ...(groupId === 'group:right' ? [persistentTab.id] : [])],
        activeTabId: activeOnlyTab.id,
      },
    },
    tabsById: {
      [persistentTab.id]: persistentTab,
      [inactivePersistentTab.id]: inactivePersistentTab,
      [activeOnlyTab.id]: activeOnlyTab,
      [missingTab.id]: missingTab,
    },
    activeGroupId: 'group:right',
    recentlyClosedTabs: [],
  };
}

describe('persistent editor policy and location selectors', () => {
  it('resolves registrations and default policies through one shared helper', () => {
    expect(resolveWorkbenchEditor(registry, activeOnlyTab)).toMatchObject({
      registration: { type: 'active-only' },
      policies: { mountPolicy: 'active-only', previewHostPolicy: 'none' },
    });
    expect(resolveWorkbenchEditor(registry, missingTab)).toEqual({
      registration: missingEditorRegistration,
      policies: {
        mountPolicy: 'active-only',
        previewHostPolicy: 'none',
        previewPersistence: undefined,
      },
    });
  });

  it('selects active and inactive open persistent tabs but excludes missing registrations', () => {
    const state = stateWithPersistentTabIn('group:left');

    expect(selectOpenPersistentWorkbenchTabs(state, registry).map((tab) => tab.id)).toEqual([
      persistentTab.id,
      inactivePersistentTab.id,
    ]);
  });

  it('updates a tab location when it moves between groups', () => {
    expect(selectWorkbenchTabGroupId(stateWithPersistentTabIn('group:left'), persistentTab.id)).toBe('group:left');
    expect(selectWorkbenchTabGroupId(stateWithPersistentTabIn('group:right'), persistentTab.id)).toBe('group:right');
    expect(selectWorkbenchTabGroupId(stateWithPersistentTabIn('group:left'), 'tab:not-open')).toBeNull();
  });
});

describe('WorkbenchEditorLocation context', () => {
  it('updates location without remounting the editor child', () => {
    const mounts = vi.fn();
    const unmounts = vi.fn();

    function Consumer() {
      const location = useWorkbenchEditorLocation();
      useEffect(() => {
        mounts();
        return unmounts;
      }, []);
      return <div data-testid="location">{`${location.groupId}:${location.isVisible}`}</div>;
    }

    const first: WorkbenchEditorLocation = {
      tabId: persistentTab.id,
      groupId: 'group:left',
      isActiveInGroup: true,
      isVisible: true,
    };
    const view = render(
      <WorkbenchEditorLocationProvider location={first}>
        <Consumer />
      </WorkbenchEditorLocationProvider>,
    );
    const consumer = screen.getByTestId('location');

    view.rerender(
      <WorkbenchEditorLocationProvider location={{ ...first, groupId: 'group:right', isVisible: false }}>
        <Consumer />
      </WorkbenchEditorLocationProvider>,
    );

    expect(screen.getByTestId('location')).toBe(consumer);
    expect(screen.getByTestId('location')).toHaveTextContent('group:right:false');
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();
  });
});
