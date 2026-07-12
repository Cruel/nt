import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BottomPanel } from '@/workbench/BottomPanel';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { buildCharacterDetailTabForRecord } from '@/workbench/editor-registry';
import { consumeWorkbenchRevealTarget } from '@/workbench/workbench-navigation';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

beforeEach(() => {
  const project = createAuthoringProject();
  project.characters.dfs = { id: 'dfs', label: 'DFS', data: {} as never };
  useProjectStore.getState().clearProject();
  useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock/project', projectFilePath: '/mock/project/game.json' });
  useWorkspaceStore.getState().setDiagnostics([]);
  useBottomPanelStore.getState().hydrate({ visible: true, activePanelId: 'problems' });
  useWorkbenchStore.getState().resetWorkbench();
});

describe('BottomPanel', () => {
  it('opens resolvable problem diagnostics through workbench navigation', () => {
    useWorkspaceStore.getState().setDiagnostics([{
      severity: 'warning',
      path: '/characters/dfs/data/preview',
      message: 'Selected pose/expression has no sprite asset yet.',
      category: 'authoring-characters',
    }]);

    render(<BottomPanel />);
    fireEvent.click(screen.getByText('Selected pose/expression has no sprite asset yet.'));

    expect(useWorkbenchStore.getState().tabsById['tab:character-detail:characters:dfs']).toBeTruthy();
    expect(consumeWorkbenchRevealTarget(buildCharacterDetailTabForRecord('dfs', 'DFS'))).toMatchObject({
      id: 'character.preview',
      flash: true,
    });
  });
});
