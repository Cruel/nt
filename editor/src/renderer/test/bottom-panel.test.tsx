import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BottomPanel } from '@/workbench/BottomPanel';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import {
  buildCharacterDetailTabForRecord,
  buildFullGamePreviewTab,
  buildRoomDetailTabForRecord,
} from '@/workbench/editor-registry';
import { consumeWorkbenchRevealTarget } from '@/workbench/workbench-navigation';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { useEntityUsagesStore } from '@/project/entity-usages-store';
import { emptyPackageExportResult, usePackageExportStore } from '@/export/package-export-store';
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
  useWorkspaceStore.getState().setLastPlaybackReport(null);
  useWorkspaceStore.getState().setLastExportResult(null);
  useEntityUsagesStore.getState().clearUsages();
  usePackageExportStore.getState().clear();
  usePreviewManagerStore.getState().resetPreviewManager();
  usePreferencesStore.setState({ developerMode: false });
  useBottomPanelStore.getState().hydrate({ visible: true, activePanelId: 'problems' });
  useWorkbenchStore.getState().resetWorkbench();
});

describe('BottomPanel', () => {
  it('shows only globally available panels without a Project and falls back deterministically', () => {
    useProjectStore.getState().clearProject();
    useBottomPanelStore.getState().hydrate({ visible: true, activePanelId: 'problems' });

    render(<BottomPanel />);

    expect(screen.getByRole('button', { name: 'Activity' })).toHaveClass(
      'bg-accent',
      'text-accent-foreground',
    );
    expect(screen.getByText('No activity entries yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Problems/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Runtime Events' })).not.toBeInTheDocument();
    expect(useBottomPanelStore.getState().serialize()).toEqual({
      visible: true,
      activePanelId: 'problems',
      sizePercent: 30,
    });
  });

  it('keeps Project panels available but hides preview-only panels without a Play tab', () => {
    render(<BottomPanel />);

    expect(screen.getByRole('button', { name: /Problems/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Runtime Events' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Asset Performance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Preview Diagnostics/ })).not.toBeInTheDocument();
  });

  it('shows result-driven panels only when they have retained results', () => {
    render(<BottomPanel />);

    expect(screen.queryByRole('button', { name: 'Package Export' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test Playback' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'References' })).not.toBeInTheDocument();

    act(() => {
      const exportResult = emptyPackageExportResult('complete');
      usePackageExportStore.getState().finish(exportResult);
      useWorkspaceStore.getState().setLastExportResult(exportResult);
      useWorkspaceStore.getState().setLastPlaybackReport({ passed: true, id: 'smoke' });
      useEntityUsagesStore.getState().setUsages({ collection: 'characters', id: 'dfs' }, []);
    });

    expect(screen.getByRole('button', { name: 'Package Export' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test Playback' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'References' })).toBeInTheDocument();

    act(() => {
      usePackageExportStore.getState().clear();
      useWorkspaceStore.getState().setLastExportResult(null);
      useWorkspaceStore.getState().setLastPlaybackReport(null);
      useEntityUsagesStore.getState().clearUsages();
    });

    expect(screen.queryByRole('button', { name: 'Package Export' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test Playback' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'References' })).not.toBeInTheDocument();
  });

  it('shows export while an export workflow is running', () => {
    render(<BottomPanel />);

    act(() => usePackageExportStore.getState().start());

    expect(screen.getByRole('button', { name: 'Package Export' })).toBeInTheDocument();
  });

  it('keeps developer tooling out of the normal authoring strip', () => {
    render(<BottomPanel />);

    expect(screen.queryByRole('button', { name: 'Shader Compile' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Command History' })).not.toBeInTheDocument();

    act(() => {
      usePreferencesStore.setState({ developerMode: true });
    });

    expect(screen.getByRole('button', { name: 'Shader Compile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Command History' })).toBeInTheDocument();
  });

  it('falls back when a result-driven active panel is cleared', () => {
    act(() => {
      useEntityUsagesStore.getState().setUsages({ collection: 'characters', id: 'dfs' }, []);
      useBottomPanelStore.getState().setActivePanelId('references');
    });
    render(<BottomPanel />);

    expect(screen.getByRole('button', { name: 'References' })).toHaveClass('bg-accent');

    act(() => useEntityUsagesStore.getState().clearUsages());

    expect(screen.queryByRole('button', { name: 'References' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Problems/ })).toHaveClass('bg-accent');
  });

  it('groups and highlights preview-linked panels while a Play tab is active', () => {
    act(() => useWorkbenchStore.getState().openTab(buildFullGamePreviewTab()));

    render(<BottomPanel />);

    const runtimeEvents = screen.getByRole('button', { name: 'Runtime Events' });
    const assetPerformance = screen.getByRole('button', { name: 'Asset Performance' });
    const previewDiagnostics = screen.getByRole('button', { name: /Preview Diagnostics/ });
    const previewGroup = runtimeEvents.closest('[data-bottom-panel-group="preview"]');

    expect(previewGroup).not.toBeNull();
    expect(previewGroup).toContainElement(assetPerformance);
    expect(previewGroup).toContainElement(previewDiagnostics);
    expect(runtimeEvents).toHaveAttribute('data-relevant', 'true');
    expect(assetPerformance).toHaveAttribute('data-relevant', 'true');
    expect(previewDiagnostics).toHaveAttribute('data-relevant', 'true');
    expect(runtimeEvents).toHaveClass('border-t-primary');
    expect(assetPerformance).toHaveClass('border-t-primary');
    expect(previewDiagnostics).toHaveClass('border-t-primary');
    expect(previewGroup?.querySelector('[data-bottom-panel-group-line]')).toHaveClass('border-b');

    act(() => useBottomPanelStore.getState().setActivePanelId('preview-events'));

    expect(runtimeEvents).toHaveClass('bg-accent', 'text-accent-foreground');
    expect(runtimeEvents).not.toHaveClass('rounded');

    act(() => {
      useWorkbenchStore.getState().openTab(buildCharacterDetailTabForRecord('dfs', 'DFS'));
    });

    expect(runtimeEvents).toHaveAttribute('data-relevant', 'false');
    expect(assetPerformance).toHaveAttribute('data-relevant', 'false');
    expect(previewDiagnostics).toHaveAttribute('data-relevant', 'false');
  });

  it('renders semantic runtime activity instead of raw preview protocol payloads', () => {
    act(() => {
      useWorkbenchStore.getState().openTab(buildFullGamePreviewTab());
      useWorkspaceStore.getState().addRuntimeEvent({
        label: 'Set trust',
        detail: 'variable-set · old=2 · new=3',
        severity: 'info',
      });
      useBottomPanelStore.getState().setActivePanelId('preview-events');
    });

    render(<BottomPanel />);

    expect(screen.getByText('Set trust')).toBeInTheDocument();
    expect(screen.getByText('variable-set · old=2 · new=3')).toBeInTheDocument();
    expect(screen.queryByText('runtime-debug-snapshot')).not.toBeInTheDocument();
  });

  it('keeps Preview Diagnostics available after the Play tab is gone while diagnostics remain', () => {
    usePreviewManagerStore.getState().recordPreviewDiagnostic({
      severity: 'error',
      source: 'manager',
      message: 'Focused Room preview failed.',
      target: { kind: 'record', collection: 'rooms', entityId: 'foyer' },
    });

    render(<BottomPanel />);

    expect(screen.queryByRole('button', { name: 'Runtime Events' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Asset Performance' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('1 preview error')).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Preview Diagnostics/ })).toContainElement(
      screen.getByLabelText('1 preview error'),
    );
  });

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
