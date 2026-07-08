import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CharacterEditor } from '@/editors/characters/CharacterEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { captureWorkbenchTabState, clearWorkbenchTabStates, useWorkbenchTabStateStore } from '@/workbench/workbench-tab-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';

vi.mock('@/preview/DerivedPreviewPane', () => ({
  DerivedPreviewPane: () => <div data-testid="character-derived-preview" />,
}));

const tab: WorkbenchTab = {
  id: 'tab:character-detail:characters:iris',
  title: 'Iris',
  editorType: 'character-detail',
  resource: {
    kind: 'record',
    stableId: 'record:characters:iris',
    collection: 'characters',
    entityId: 'iris',
  },
};

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  clearWorkbenchTabStates();
});

describe('CharacterEditor', () => {
  it('renders typed character defaults', () => {
    const project = createAuthoringProject();
    project.characters.iris = { id: 'iris', label: 'Iris', tags: [], data: defaultCharacterData('Iris') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<CharacterEditor tab={tab} />);

    expect(screen.getByText('Iris')).toBeInTheDocument();
    expect(screen.getByText('Poses')).toBeInTheDocument();
    expect(screen.getByText('Expressions')).toBeInTheDocument();
    expect(screen.getByTestId('character-derived-preview')).toBeInTheDocument();
  });

  it('dispatches command-backed dialogue and pose updates', async () => {
    const project = createAuthoringProject();
    project.characters.iris = { id: 'iris', label: 'Iris', tags: [], data: defaultCharacterData('Iris') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<CharacterEditor tab={tab} />);

    const dialogueName = screen.getAllByDisplayValue('Iris')[1]!;
    fireEvent.change(dialogueName, { target: { value: 'Iris V.' } });

    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        characters: { iris: { data: { dialogue: { name: 'Iris V.' } } } },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('character.replaceData');

    fireEvent.click(screen.getByText('Add Pose'));
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        characters: { iris: { data: { poses: expect.arrayContaining([expect.objectContaining({ id: 'pose' })]) } } },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('character.replaceData');
  });

  it('captures scroll tab state for the inspector', () => {
    const project = createAuthoringProject();
    project.characters.iris = { id: 'iris', label: 'Iris', tags: [], data: defaultCharacterData('Iris') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    const view = render(<CharacterEditor tab={tab} />);
    const scrollContainer = view.container.querySelector<HTMLElement>('[data-character-editor-scroll]')!;
    scrollContainer.scrollTop = 72;

    captureWorkbenchTabState(tab.id);

    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]).toMatchObject({
      schema: 'noveltea.editor.tab-state.character',
      payload: {
        scroll: { scrollTop: 72, scrollLeft: 0 },
      },
    });
  });
});
