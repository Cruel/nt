import { describe, expect, it } from 'vite-plus/test';
import {
  buildAuthoringProjectTree,
  buildProjectTree,
  useWorkspaceStore,
} from '@/stores/workspace-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

describe('workspace diagnostic snapshots', () => {
  it('does not republish equal diagnostics but does publish changed findings', () => {
    const store = useWorkspaceStore.getState();
    const diagnostic = {
      code: 'record.invalid',
      severity: 'error' as const,
      path: '/rooms/hall',
      message: 'Invalid Room',
      ownerPaths: ['/rooms/hall'],
      observedAgainst: 'working' as const,
    };
    store.setDiagnostics([diagnostic]);
    const original = useWorkspaceStore.getState().diagnostics;
    const snapshots: (typeof original)[] = [];
    const unsubscribe = useWorkspaceStore.subscribe((next, previous) => {
      if (next.diagnostics !== previous.diagnostics) snapshots.push(next.diagnostics);
    });
    try {
      store.setDiagnostics([{ ...diagnostic, ownerPaths: [...diagnostic.ownerPaths] }]);
      expect(useWorkspaceStore.getState().diagnostics).toBe(original);
      expect(snapshots).toEqual([]);

      const changed = [{ ...diagnostic, message: 'Invalid Room identity' }];
      store.setDiagnostics(changed);
      expect(useWorkspaceStore.getState().diagnostics).toBe(changed);
      expect(snapshots).toEqual([changed]);
      store.setDiagnostics([]);
      expect(useWorkspaceStore.getState().diagnostics).toEqual([]);
      expect(snapshots).toHaveLength(2);
    } finally {
      unsubscribe();
      store.setDiagnostics([]);
    }
  });
});

describe('workspace project tree', () => {
  it('shows all authoring collection folders for empty projects', () => {
    const tree = buildProjectTree(createAuthoringProject());

    expect(tree.map((node) => node.id)).toContain('layouts');
    expect(tree.find((node) => node.id === 'layouts')?.label).toBe('Layouts');
    expect(tree.find((node) => node.id === 'rooms')?.children).toEqual([]);
  });

  it('groups authoring records under their collection using record labels', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Front Foyer', data: {} as never };
    project.layouts.hud = { id: 'hud', label: 'HUD', data: {} as never };

    const tree = buildAuthoringProjectTree(project);

    expect(tree.find((node) => node.id === 'rooms')?.children?.[0]).toEqual(
      expect.objectContaining({
        id: 'rooms:foyer',
        label: 'Front Foyer',
        type: 'room',
        collection: 'rooms',
        entityId: 'foyer',
      }),
    );
    expect(tree.find((node) => node.id === 'layouts')?.children?.[0]).toEqual(
      expect.objectContaining({
        id: 'layouts:hud',
        label: 'HUD',
        type: 'layout',
      }),
    );
  });

  it('does not treat non-authoring documents as project trees', () => {
    expect(buildProjectTree({ room: { foyer: ['foyer'] } })).toEqual([]);
  });
});
