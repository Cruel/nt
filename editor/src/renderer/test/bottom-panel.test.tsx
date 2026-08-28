import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BottomPanel } from '@/workbench/BottomPanel';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import {
  buildCharacterDetailTabForRecord,
  buildRoomDetailTabForRecord,
} from '@/workbench/editor-registry';
import { consumeWorkbenchRevealTarget } from '@/workbench/workbench-navigation';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

beforeEach(() => {
  const project = createAuthoringProject();
  project.characters.dfs = { id: 'dfs', label: 'DFS', data: defaultCharacterData('DFS') };
  useProjectStore.getState().clearProject();
  useProjectStore.getState().loadProjectDocument({
    document: project,
    projectPath: '/mock/project',
    projectFilePath: '/mock/project/game.json',
  });
  useWorkspaceStore.getState().setDiagnostics([]);
  usePreferencesStore.setState({ developerMode: false });
  useBottomPanelStore.getState().hydrate({ visible: true, activePanelId: 'problems' });
  useWorkbenchStore.getState().resetWorkbench();
});

describe('BottomPanel', () => {
  it('opens resolvable problem diagnostics through workbench navigation', () => {
    useWorkspaceStore.getState().setDiagnostics([
      {
        severity: 'warning',
        path: '/characters/dfs/data/preview',
        message: 'Selected pose/expression has no sprite asset yet.',
        category: 'Characters',
      },
    ]);

    render(<BottomPanel />);
    const problem = screen.getByText('Selected pose/expression has no sprite asset yet.');
    expect(problem.closest('button')).toHaveClass('cursor-pointer', 'border-l-amber-500');
    expect(screen.getByText('DFS')).toBeInTheDocument();
    expect(screen.queryByText('Characters')).not.toBeInTheDocument();
    expect(screen.queryByText('warning')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Selected pose/expression has no sprite asset yet.'));

    expect(
      useWorkbenchStore.getState().tabsById['tab:character-detail:characters:dfs'],
    ).toBeTruthy();
    expect(
      consumeWorkbenchRevealTarget(buildCharacterDetailTabForRecord('dfs', 'DFS')),
    ).toMatchObject({
      id: 'character.preview',
      flash: true,
    });
  });

  it('shows diagnostic data paths only in developer mode', () => {
    useWorkspaceStore.getState().setDiagnostics([
      {
        severity: 'warning',
        path: '/characters/dfs/data/preview',
        message: 'Selected pose/expression has no sprite asset yet.',
        category: 'Characters',
      },
    ]);

    const view = render(<BottomPanel />);
    expect(screen.queryByText('/characters/dfs/data/preview')).not.toBeInTheDocument();

    act(() => usePreferencesStore.getState().setDeveloperMode(true));
    view.rerender(<BottomPanel />);

    expect(screen.getByText('/characters/dfs/data/preview')).toBeInTheDocument();
  });

  it('uses semantic diagnostic navigation to open a room-placed Instance Property', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        order: 0,
        presentation: { label: null, layout: null },
      },
    ];
    room.interactables = [
      {
        id: 'key-entry',
        interactable: { $ref: { registry: 'interactableInstances', id: 'key-instance' } },
        condition: { kind: 'always' },
        placementId: 'key-placement',
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      data: defaultInteractableData('Key'),
    };
    project.interactableInstances['key-instance'] = defaultInteractableInstanceData(
      'key-instance',
      'key',
      { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
    );
    useProjectStore.getState().loadUnsavedProjectDocument(project);
    useWorkspaceStore.getState().setDiagnostics([
      {
        severity: 'error',
        path: '/interactableInstances/key-instance/localProperties',
        message:
          "Interactable Instance 'key-instance' requires Property 'quality' to have a Value.",
        navigation: {
          kind: 'interactable-instance-property',
          instanceId: 'key-instance',
          propertyId: 'quality',
        },
      },
    ]);

    render(<BottomPanel />);
    fireEvent.click(screen.getByText(/requires Property 'quality'/));

    expect(
      consumeWorkbenchRevealTarget(buildRoomDetailTabForRecord('foyer', 'Foyer')),
    ).toMatchObject({
      id: 'instance.property.key-instance.quality',
      payload: { placementId: 'key-placement' },
      flash: true,
    });
  });
});
