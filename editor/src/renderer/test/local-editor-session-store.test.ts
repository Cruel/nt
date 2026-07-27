import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createInitialWorkbenchState } from '@/workbench/workbench-model';
import { useLocalEditorSessionStore } from '@/workbench/local-editor-session-store';

const STORAGE_KEY = 'noveltea-editor-session';

async function rehydrateFrom(state: unknown, version: number) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, version }));
  await useLocalEditorSessionStore.persist.rehydrate();
}

describe('local editor session persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    useLocalEditorSessionStore.setState({ shellSession: null });
  });

  it('rehydrates the current V2 shell session', async () => {
    const shellWorkbench = createInitialWorkbenchState();
    shellWorkbench.tabsById['tool:settings'] = {
      id: 'tool:settings',
      title: 'Settings',
      editorType: 'settings',
      resource: { kind: 'tool', stableId: 'tool:settings' },
    };
    shellWorkbench.groupsById[shellWorkbench.activeGroupId]!.tabIds = ['tool:settings'];
    shellWorkbench.groupsById[shellWorkbench.activeGroupId]!.activeTabId = 'tool:settings';

    await rehydrateFrom(
      {
        shellSession: {
          projectFilePath: '/projects/current.ntproj',
          shellWorkbench,
        },
      },
      2,
    );

    expect(useLocalEditorSessionStore.getState().shellSession).toEqual({
      projectFilePath: '/projects/current.ntproj',
      shellWorkbench,
    });
  });

  it('discards a V1 persisted session instead of migrating it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await rehydrateFrom({ shellWorkbench: createInitialWorkbenchState() }, 1);

    expect(useLocalEditorSessionStore.getState().shellSession).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does not promote the retired root shellWorkbench shape in V2 storage', async () => {
    await rehydrateFrom({ shellWorkbench: createInitialWorkbenchState() }, 2);

    expect(useLocalEditorSessionStore.getState().shellSession).toBeNull();
  });

  it('discards malformed current V2 shell state', async () => {
    await rehydrateFrom(
      {
        shellSession: {
          projectFilePath: '/projects/current.ntproj',
          shellWorkbench: {},
        },
      },
      2,
    );

    expect(useLocalEditorSessionStore.getState().shellSession).toBeNull();
  });
});
