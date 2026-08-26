import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TestsEditor } from '@/editors/tests/TestsEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultTestData, defaultTestStep } from '../../shared/project-schema/authoring-tests';

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({
    value,
    onChange,
    className,
  }: {
    value: string;
    onChange?: (value: string) => void;
    className?: string;
  }) => (
    <textarea
      className={className}
      value={value}
      onChange={(event) => onChange?.(event.currentTarget.value)}
    />
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
  it('renders typed test data and readiness diagnostics', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    project.entrypoint = { kind: 'room', id: 'foyer' };
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data: defaultTestData('Smoke') };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<TestsEditor tab={tab} />);

    expect(screen.getByText('Smoke')).toBeInTheDocument();
    expect(screen.getByText('smoke')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('runnable')).toBeInTheDocument());
    expect(screen.getByText('Selected step')).toBeInTheDocument();
  });

  it('commits metadata and step edits through test.replaceData', async () => {
    const project = createAuthoringProject();
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data: defaultTestData('Smoke') };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<TestsEditor tab={tab} />);

    fireEvent.change(screen.getByDisplayValue('Smoke'), { target: { value: 'Smoke Edited' } });
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        tests: { smoke: { data: { displayName: 'Smoke Edited' } } },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('test.replaceData');

    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => {
      const document = useProjectStore.getState().document as {
        tests: { smoke: { data: ReturnType<typeof defaultTestData> } };
      };
      expect(document.tests.smoke.data.steps.some((step) => step.input === 'continue')).toBe(true);
    });
  });

  it('commits semantic identity edits through test.replaceData', async () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    data.steps = [{ ...defaultTestStep('dialogue-choice'), id: 'choose', label: 'Choose route' }];
    data.preview.selectedStepId = 'choose';
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<TestsEditor tab={tab} />);

    fireEvent.change(screen.getByLabelText('Dialogue edge ID'), { target: { value: 'accept' } });
    await waitFor(() => {
      const document = useProjectStore.getState().document as {
        tests: { smoke: { data: ReturnType<typeof defaultTestData> } };
      };
      expect(document.tests.smoke.data.steps[0]?.dialogueChoice.edgeId).toBe('accept');
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('test.replaceData');
  });

  it('runs semantic tests against the prepared compiled project', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    project.entrypoint = { kind: 'room', id: 'foyer' };
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data: defaultTestData('Smoke') };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    const runPlaybackSpec = vi.mocked(window.noveltea.runPlaybackSpec);
    runPlaybackSpec.mockClear();

    render(<TestsEditor tab={tab} />);

    await waitFor(() => expect(screen.getByText('runnable')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Run Test'));

    await waitFor(() => expect(runPlaybackSpec).toHaveBeenCalledOnce());
    expect(runPlaybackSpec.mock.calls[0]?.[0]).toMatchObject({
      schema: 'noveltea.compiled.project',
      schemaVersion: 1,
    });
  });

  it('opens the playback panel and stores readiness reports when a test cannot run', async () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<TestsEditor tab={tab} />);

    fireEvent.click(screen.getByText('Run Test'));
    await waitFor(() => {
      const report = useWorkspaceStore.getState().lastPlaybackReport as {
        id?: string;
        passed?: boolean;
        diagnostics?: Array<{ severity?: string }>;
      } | null;
      expect(report).toMatchObject({ id: 'smoke', passed: false });
      expect(report?.diagnostics?.some((item) => item.severity === 'error')).toBe(true);
    });
  });
});
