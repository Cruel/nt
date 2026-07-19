import { describe, expect, it } from 'vite-plus/test';
import { buildAuthoringProjectTree, buildProjectTree } from '@/stores/workspace-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

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
