import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TestsEditor } from '@/editors/tests/TestsEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';
import { defaultTestData, defaultTestStep } from '../../shared/project-schema/authoring-tests';

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({ value, onChange, className }: { value: string; onChange?: (value: string) => void; className?: string }) => (
    <textarea className={className} value={value} onChange={(event) => onChange?.(event.currentTarget.value)} />
  ),
}));

const tab: WorkbenchTab = {
  id: 'tab:test-detail:tests:smoke',
  title: 'Smoke',
  editorType: 'test-detail',
  resource: {
    kind: 'record',
    stableId: 'record:tests:smoke',
    collection: 'tests',
    entityId: 'smoke',
  },
};

beforeEach(() => {
  window.PointerEvent = window.PointerEvent ?? window.MouseEvent;
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  useWorkspaceStore.getState().setLastPlaybackReport(null);
  useWorkspaceStore.getState().setStatusMessage('');
});

describe('TestsEditor', () => {
  it('renders typed test data and readiness diagnostics', () => {
    const project = createAuthoringProject();
    project.tests.smoke = { id: 'smoke', label: 'Smoke', tags: [], data: defaultTestData('Smoke') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<TestsEditor tab={tab} />);

    expect(screen.getByText('Smoke')).toBeInTheDocument();
    expect(screen.getByText('smoke')).toBeInTheDocument();
    expect(screen.getByText('not runnable')).toBeInTheDocument();
    expect(screen.getAllByText('Choose an entrypoint before this test can run.').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Selected step')).toBeInTheDocument();
    expect(screen.getByText('Assertions')).toBeInTheDocument();
  });

  it('commits metadata and step edits through test.replaceData', async () => {
    const project = createAuthoringProject();
    project.tests.smoke = { id: 'smoke', label: 'Smoke', tags: [], data: defaultTestData('Smoke') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<TestsEditor tab={tab} />);

    fireEvent.change(screen.getByDisplayValue('Smoke'), { target: { value: 'Smoke Edited' } });
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({ tests: { smoke: { data: { displayName: 'Smoke Edited' } } } });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('test.replaceData');

    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => {
      const document = useProjectStore.getState().document as { tests: { smoke: { data: ReturnType<typeof defaultTestData> } } };
      expect(document.tests.smoke.data.steps.some((step) => step.input === 'continue')).toBe(true);
    });
  });

  it('commits assertion edits through test.replaceData', async () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    data.steps = [{ ...defaultTestStep('continue'), id: 'continue', label: 'Continue' }];
    data.preview.selectedStepId = 'continue';
    project.tests.smoke = { id: 'smoke', label: 'Smoke', tags: [], data };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<TestsEditor tab={tab} />);

    fireEvent.click(screen.getByText('Add Assertion'));
    await waitFor(() => {
      const document = useProjectStore.getState().document as { tests: { smoke: { data: ReturnType<typeof defaultTestData> } } };
      expect(document.tests.smoke.data.steps[0]?.assertions).toHaveLength(1);
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('test.replaceData');

    fireEvent.click(screen.getByText('Duplicate Assertion'));
    await waitFor(() => {
      const document = useProjectStore.getState().document as { tests: { smoke: { data: ReturnType<typeof defaultTestData> } } };
      expect(document.tests.smoke.data.steps[0]?.assertions).toHaveLength(2);
    });
  });

  it('opens the playback panel and stores readiness reports when a test cannot run', async () => {
    const project = createAuthoringProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', tags: [], data: defaultSceneData('Opening') };
    const data = defaultTestData('Smoke');
    data.entrypoint = { $ref: { collection: 'scenes', id: 'opening' } };
    project.tests.smoke = { id: 'smoke', label: 'Smoke', tags: [], data };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<TestsEditor tab={tab} />);

    fireEvent.click(screen.getByText('Run Test'));
    await waitFor(() => {
      expect(useWorkspaceStore.getState().lastPlaybackReport).toMatchObject({
        id: 'smoke',
        passed: false,
        diagnostics: [expect.objectContaining({ category: 'authoring-test-playback' })],
      });
    });
  });

  it('runs ui-click tests through the UI playback API', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: defaultRoomData('Foyer') };
    project.entrypoint = { collection: 'rooms', id: 'foyer' };
    const data = defaultTestData('Title Start');
    data.steps = [{ ...defaultTestStep('ui-click'), id: 'title-start', label: 'Title Start' }];
    data.preview.selectedStepId = 'title-start';
    project.tests.smoke = { id: 'smoke', label: 'Smoke', tags: [], data };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<TestsEditor tab={tab} />);

    expect(screen.getByText('runnable')).toBeInTheDocument();
    expect(screen.getByDisplayValue('runtime_title')).toBeInTheDocument();
    expect(screen.getAllByDisplayValue('#nt-title-start').length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByText('Run Test'));
    await waitFor(() => {
      expect(window.noveltea.runUiPlaybackSpec).toHaveBeenCalledWith(
        expect.objectContaining({ room: expect.any(Object), entrypoint: [3, 'foyer'] }),
        expect.objectContaining({ steps: [expect.objectContaining({ input: 'ui_click', document_id: 'runtime_title', target: '#nt-title-start' })] }),
      );
    });
  });
});
