import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BottomPanel } from '@/workbench/BottomPanel';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { buildCharacterDetailTabForRecord } from '@/workbench/editor-registry';
import { consumeWorkbenchRevealTarget } from '@/workbench/workbench-navigation';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';

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
});
