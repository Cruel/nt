import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
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
import { useToolingActivityStore } from '@/workbench/tooling-activity-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { useEntityUsagesStore } from '@/project/entity-usages-store';
import { emptyPackageExportResult, usePackageExportStore } from '@/export/package-export-store';
import { editorI18n } from '@/i18n';
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
  useWorkspaceStore.getState().clearRuntimeEvents();
  useWorkspaceStore.getState().clearRuntimeTrace();
  useWorkspaceStore.getState().setRuntimeConsoleClearHandler(null);
  useWorkspaceStore.getState().setRuntimeTraceClearHandler(null);
  useWorkspaceStore.getState().setLastPlaybackReport(null);
  useWorkspaceStore.getState().setLastExportResult(null);
  useEntityUsagesStore.getState().clearUsages();
  usePackageExportStore.getState().clear();
  usePreviewManagerStore.getState().resetPreviewManager();
  usePreferencesStore.setState({ developerMode: false });
  useBottomPanelStore.getState().hydrate({ visible: true, activePanelId: 'problems' });
  useWorkbenchStore.getState().resetWorkbench();
  useToolingActivityStore.getState().clear();
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
    expect(screen.queryByRole('button', { name: 'Console' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Trace' })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Console' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Trace' })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Tooling' })).not.toBeInTheDocument();

    act(() => {
      usePreferencesStore.setState({ developerMode: true });
    });

    expect(screen.getByRole('button', { name: 'Shader Compile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Command History' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tooling' })).toBeInTheDocument();
  });

  it('keeps Tooling available in developer mode without a Project', () => {
    useProjectStore.getState().clearProject();
    act(() => {
      usePreferencesStore.setState({ developerMode: true });
      useToolingActivityStore.getState().add({
        id: 'native-1',
        layer: 'native',
        operation: 'compile-shaders',
        status: 'success',
        startedAt: 1,
        durationMs: 12,
        detail: 'programs=1 variants=1',
      });
      useBottomPanelStore.getState().setActivePanelId('tooling');
    });

    render(<BottomPanel />);

    expect(screen.getByRole('button', { name: 'Tooling' })).toHaveClass('bg-accent');
    expect(screen.getByText('compile-shaders')).toBeInTheDocument();
    expect(screen.getByText('programs=1 variants=1')).toBeInTheDocument();
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

    const runtimeEvents = screen.getByRole('button', { name: 'Console' });
    const trace = screen.getByRole('button', { name: 'Trace' });
    const assetPerformance = screen.getByRole('button', { name: 'Asset Performance' });
    const previewDiagnostics = screen.getByRole('button', { name: /Preview Diagnostics/ });
    const previewGroup = runtimeEvents.closest('[data-bottom-panel-group="preview"]');

    expect(previewGroup).not.toBeNull();
    expect(previewGroup).toContainElement(assetPerformance);
    expect(previewGroup).toContainElement(trace);
    expect(previewGroup).toContainElement(previewDiagnostics);
    expect(runtimeEvents).toHaveAttribute('data-relevant', 'true');
    expect(trace).toHaveAttribute('data-relevant', 'true');
    expect(assetPerformance).toHaveAttribute('data-relevant', 'true');
    expect(previewDiagnostics).toHaveAttribute('data-relevant', 'true');
    expect(runtimeEvents).toHaveClass('border-t-primary');
    expect(trace).toHaveClass('border-t-primary');
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
    expect(trace).toHaveAttribute('data-relevant', 'false');
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

  it('filters structured Console entries and clears both retained surfaces', async () => {
    const clearRemote = vi.fn().mockResolvedValue(undefined);
    act(() => {
      useWorkbenchStore.getState().openTab(buildFullGamePreviewTab());
      useWorkspaceStore.getState().addDevtoolsConsoleRecords(
        [
          {
            sequence: '8',
            globalSequence: '18',
            hostGeneration: '1',
            runtimeGeneration: '3',
            frame: '40',
            severity: 'info',
            category: 'lua',
            message: 'hello player',
            source: { chunk: 'main.lua', line: 4 },
            generationMarker: false,
          },
          {
            sequence: '9',
            globalSequence: '20',
            hostGeneration: '1',
            runtimeGeneration: '3',
            frame: '41',
            severity: 'error',
            category: 'runtime',
            message: 'door failed',
            source: null,
            generationMarker: false,
          },
        ],
        '2',
      );
      useWorkspaceStore.getState().setRuntimeConsoleClearHandler(clearRemote);
      useBottomPanelStore.getState().setActivePanelId('preview-events');
    });

    render(<BottomPanel />);
    expect(screen.getByText(/Console history gap: 2 record/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Console severity'), { target: { value: 'error' } });
    expect(screen.getByText('door failed')).toBeInTheDocument();
    expect(screen.queryByText('hello player')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Console severity'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Console category'), { target: { value: 'lua' } });
    fireEvent.change(screen.getByLabelText('Console text filter'), { target: { value: 'player' } });
    expect(screen.getByText('hello player')).toBeInTheDocument();
    expect(screen.queryByText('door failed')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Freeze' }));
    expect(screen.getByText('Console view frozen; capture continues.')).toBeInTheDocument();
    act(() => {
      useWorkspaceStore.getState().addDevtoolsConsoleRecords([
        {
          sequence: '10',
          globalSequence: '21',
          hostGeneration: '1',
          runtimeGeneration: '3',
          frame: '42',
          severity: 'info',
          category: 'lua',
          message: 'new player event',
          source: null,
          generationMarker: false,
        },
      ]);
    });
    expect(screen.queryByText('new player event')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unfreeze' }));
    expect(screen.getByText('new player event')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(useWorkspaceStore.getState().runtimeEvents).toEqual([]);
    expect(useWorkspaceStore.getState().runtimeConsoleLostRecordCount).toBeNull();
    expect(clearRemote).toHaveBeenCalledTimes(1);
  });

  it('filters, freezes, and clears the retained Trace without stopping capture', () => {
    const clearRemote = vi.fn().mockResolvedValue(undefined);
    const pointerRecord = {
      sequence: '12',
      firstSequence: '10',
      globalSequence: '21',
      firstGlobalSequence: '19',
      hostGeneration: '1',
      runtimeGeneration: '3',
      kind: 'input-routing' as const,
      category: 'input',
      repeatCount: 3,
      firstFrame: '40',
      lastFrame: '42',
      input: {
        event: 'mouse-motion',
        hostX: 100,
        hostY: 80,
        referenceX: 200,
        referenceY: 160,
        mouseButton: null,
        wheelX: null,
        wheelY: null,
        referenceValid: true,
        debugProcessed: true,
        debugConsumed: false,
        runtimeUiProcessed: true,
        runtimeUiConsumed: false,
        runtimeUiWantsPointer: false,
        gameplayEvent: true,
        gameplayAdmitted: true,
        gameplayBlockReason: 'none',
        governingLayout: null,
        governingLayoutMode: 'none',
        rmluiHover: {
          context: 'game-ui',
          documentId: 'hud',
          tag: 'button',
          id: 'door',
          classes: '',
          pointerEvents: 'auto',
        },
        rmluiFocus: null,
        worldEvaluated: true,
        worldConsumed: false,
        worldHit: 'room/foyer/hotspot/door',
        worldHovered: 'room/foyer/hotspot/door',
        worldPressed: null,
        worldTarget: null,
      },
      debuggerMutation: null,
      detail: '',
      generationMarker: false,
    };
    const blockedRecord = {
      ...pointerRecord,
      sequence: '9',
      firstSequence: '9',
      repeatCount: 1,
      input: {
        ...pointerRecord.input,
        runtimeUiConsumed: true,
        runtimeUiWantsPointer: true,
        gameplayAdmitted: false,
        gameplayBlockReason: 'runtime-ui',
        rmluiHover: {
          context: 'game-ui',
          documentId: 'hud',
          tag: 'div',
          id: 'feature-lab-panel',
          classes: 'feature-lab-panel',
          pointerEvents: 'auto',
        },
        worldEvaluated: false,
        worldHit: null,
        worldHovered: null,
      },
    };
    act(() => {
      useWorkbenchStore.getState().openTab(buildFullGamePreviewTab());
      useWorkspaceStore.getState().addDevtoolsTraceRecords([blockedRecord, pointerRecord], '2');
      useWorkspaceStore.getState().setRuntimeTraceClearHandler(clearRemote);
      useBottomPanelStore.getState().setActivePanelId('preview-trace');
    });

    render(<BottomPanel />);
    expect(screen.getByText(/Trace history gap: 2 record/)).toBeInTheDocument();
    expect(screen.getAllByText('mouse-motion')).toHaveLength(2);
    expect(screen.getByText(/room\/foyer\/hotspot\/door/)).toBeInTheDocument();
    expect(screen.getByText(/gameplay: admitted=false block=runtime-ui/)).toBeInTheDocument();
    expect(screen.getByText(/world: evaluated=false/)).toBeInTheDocument();
    expect(screen.getByText(/gameplay: admitted=true block=none/)).toBeInTheDocument();
    expect(
      screen.getByText(/world: evaluated=true hit=room\/foyer\/hotspot\/door/),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Trace text filter'), { target: { value: 'missing' } });
    expect(screen.queryByText('mouse-motion')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Trace text filter'), { target: { value: 'door' } });
    expect(screen.getByText('mouse-motion')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Freeze' }));
    expect(screen.getByText('Trace view frozen; capture continues.')).toBeInTheDocument();
    act(() => {
      useWorkspaceStore.getState().addDevtoolsTraceRecords([
        {
          ...pointerRecord,
          sequence: '13',
          firstSequence: '13',
          repeatCount: 1,
          input: { ...pointerRecord.input, event: 'mouse-button-down' },
        },
      ]);
    });
    expect(screen.queryByText('mouse-button-down')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unfreeze' }));
    expect(screen.getByText('mouse-button-down')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(useWorkspaceStore.getState().runtimeTrace).toEqual([]);
    expect(clearRemote).toHaveBeenCalledTimes(1);
  });

  it('keeps Preview Diagnostics available after the Play tab is gone while diagnostics remain', () => {
    usePreviewManagerStore.getState().recordPreviewDiagnostic({
      severity: 'error',
      source: 'manager',
      message: 'Focused Room preview failed.',
      target: { kind: 'record', collection: 'rooms', entityId: 'foyer' },
    });

    render(<BottomPanel />);

    expect(screen.queryByRole('button', { name: 'Console' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Trace' })).not.toBeInTheDocument();
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

  it('localizes coded project diagnostics at the renderer boundary', async () => {
    useWorkspaceStore.getState().setDiagnostics([
      {
        code: 'hotspot.authoring.target.none',
        severity: 'info',
        path: '/rooms/room/data/hotspots/0/target',
        message: 'Hotspot has no target and will not be interactive.',
        category: 'Rooms',
      },
    ]);

    await act(async () => editorI18n.changeLanguage('pt-BR'));
    render(<BottomPanel />);

    expect(screen.getByText('O hotspot não tem alvo e não será interativo.')).toBeInTheDocument();
    expect(
      screen.queryByText('Hotspot has no target and will not be interactive.'),
    ).not.toBeInTheDocument();

    await act(async () => editorI18n.changeLanguage('pseudo'));
    expect(
      screen.getByText('⟦Hotspot has no target and will not be interactive.⟧'),
    ).toBeInTheDocument();
  });

  it('uses semantic diagnostic navigation to open a room-placed Instance Property', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
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
