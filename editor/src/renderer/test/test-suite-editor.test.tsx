import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TestSuiteEditor } from '@/editors/tests/TestSuiteEditor';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';

function projectWithTests() {
  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
  project.entrypoint = { kind: 'room', id: 'foyer' };
  project.tests.alpha = { id: 'alpha', label: 'Alpha', data: defaultTestData('Alpha') };
  project.tests.beta = { id: 'beta', label: 'Beta', data: defaultTestData('Beta') };
  project.tests.gamma = { id: 'gamma', label: 'Gamma', data: defaultTestData('Gamma') };
  project.tests.delta = { id: 'delta', label: 'Delta', data: defaultTestData('Delta') };
  return project;
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useWorkspaceStore.getState().setLastPlaybackReport(null);
  useWorkspaceStore.getState().setStatusMessage('');
  useBottomPanelStore.getState().setActivePanelId('problems');
  usePendingInputStore.setState({ entriesBySaveUnitId: {} });
  vi.mocked(window.noveltea.runPlaybackSuite).mockReset();
  vi.mocked(window.noveltea.runPlaybackTest).mockClear();
});

describe('TestSuiteEditor', () => {
  it('runs the whole suite once and renders native passed, failed, blocked, and error statuses', async () => {
    const project = projectWithTests();
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
      projectSessionId: 'project-session',
    });
    const runPlaybackSuite = vi.mocked(window.noveltea.runPlaybackSuite);
    runPlaybackSuite.mockResolvedValue({
      ok: true,
      success: false,
      diagnostics: [],
      report: {
        schema: 'noveltea.test-suite-report',
        counts: { total: 4, passed: 1, failed: 1, blocked: 1, error: 1 },
        entries: [
          {
            id: 'alpha',
            runner: 'runtime',
            status: 'failed',
            report: { id: 'alpha', passed: false, observations: [] },
          },
          {
            id: 'beta',
            runner: null,
            status: 'blocked',
            diagnostics: [
              { severity: 'error', path: '/tests/beta/data', message: 'Beta is not ready.' },
            ],
          },
          {
            id: 'delta',
            runner: 'runtime',
            status: 'error',
            diagnostics: [
              { severity: 'error', path: '/tests/delta', message: 'Runtime unavailable.' },
            ],
          },
          {
            id: 'gamma',
            runner: 'runtime',
            status: 'passed',
            report: { id: 'gamma', passed: true, observations: [] },
          },
        ],
      },
    });

    render(<TestSuiteEditor tab={{} as never} />);
    await screen.findByTestId('suite-test-alpha');
    expect(screen.getByRole('button', { name: 'Run All' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Run All' }));

    await waitFor(() => expect(runPlaybackSuite).toHaveBeenCalledOnce());
    expect(runPlaybackSuite).toHaveBeenCalledWith('project-session', project, {});
    expect(vi.mocked(window.noveltea.runPlaybackTest)).not.toHaveBeenCalled();

    expect(
      await screen.findByText('1 passed · 1 failed · 1 blocked · 1 error'),
    ).toBeInTheDocument();
    expect(within(screen.getByTestId('suite-test-alpha')).getByText('Failed')).toBeInTheDocument();
    expect(within(screen.getByTestId('suite-test-beta')).getByText('Blocked')).toBeInTheDocument();
    expect(within(screen.getByTestId('suite-test-delta')).getByText('Error')).toBeInTheDocument();
    expect(within(screen.getByTestId('suite-test-gamma')).getByText('Passed')).toBeInTheDocument();
    expect(screen.getByText('Beta is not ready.')).toBeInTheDocument();
    expect(screen.getByText('Runtime unavailable.')).toBeInTheDocument();
  });

  it('opens an executed suite entry in the existing playback report panel', async () => {
    const project = projectWithTests();
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
      projectSessionId: 'project-session',
    });
    vi.mocked(window.noveltea.runPlaybackSuite).mockResolvedValue({
      ok: true,
      success: true,
      diagnostics: [],
      report: {
        schema: 'noveltea.test-suite-report',
        counts: { total: 4, passed: 4, failed: 0, blocked: 0, error: 0 },
        entries: ['alpha', 'beta', 'delta', 'gamma'].map((id) => ({
          id,
          runner: 'runtime',
          status: 'passed',
          report: { id, passed: true, observations: [] },
        })),
      },
    });

    render(<TestSuiteEditor tab={{} as never} />);
    await screen.findByTestId('suite-test-alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Run All' }));
    const reportButton = await within(screen.getByTestId('suite-test-alpha')).findByRole('button', {
      name: 'Report',
    });
    expect(useWorkspaceStore.getState().lastPlaybackReport).toBeNull();
    fireEvent.click(reportButton);

    expect(useWorkspaceStore.getState().lastPlaybackReport).toEqual({
      id: 'alpha',
      passed: true,
      observations: [],
    });
    expect(useBottomPanelStore.getState().activePanelId).toBe('test-playback');
  });
});
