import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CandidateRepairReadyDialog } from '@/project/CandidateRepairReadyDialog';
import { useCandidateRepairStore } from '@/project/candidate-repair-store';
import { useProjectStore } from '@/project/project-store';
import { useRepairPromptStore } from '@/project/repair-prompt-store';
import { WORKSPACE_TOOLBAR_COMMAND_EVENT } from '@/workspace/workspace-toolbar-events';
import type {
  CandidateRepairSource,
  CandidateRepairStatus,
} from '../../shared/project-candidate-repair';

const source = (root: string): CandidateRepairSource => ({
  root,
  sourcePath: 'project.yaml',
  text: 'schema: noveltea.project.workspace\n',
  revision: 'sha256:source',
  recognition: 'strong',
});

function registerCandidate(id: string, root: string, ai = true) {
  useCandidateRepairStore.getState().register(id, root, 'strong', []);
  const candidateSource = source(root);
  useCandidateRepairStore.setState((state) => ({
    entries: {
      ...state.entries,
      [id]: {
        ...state.entries[id]!,
        source: candidateSource,
        buffer: candidateSource.text,
      },
    },
  }));
  if (ai) useCandidateRepairStore.getState().markAiRepairRequested(id);
}

function status(id: string, generation: number, ready: boolean): CandidateRepairStatus {
  return {
    id,
    generation,
    ready,
    revision: ready ? `sha256:ready-${id}-${generation}` : null,
    diagnostics: ready
      ? []
      : [{ severity: 'error', path: '/', message: 'The Project is still invalid.' }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useCandidateRepairStore.setState({ entries: {} });
  useProjectStore.getState().clearProject();
  useRepairPromptStore.setState({ visible: false, draft: null });
  vi.stubGlobal('noveltea', {
    ...window.noveltea,
    readRepairCandidate: vi.fn(async (id: string) =>
      source(useCandidateRepairStore.getState().entries[id]?.root ?? '/unknown'),
    ),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('candidate repair readiness confirmation', () => {
  it('asks to open an AI-repaired Project without switching the current Project', async () => {
    registerCandidate('candidate-a', '/projects/project-a');
    useProjectStore.setState({ projectPath: '/projects/project-b' });
    const commands: unknown[] = [];
    const listener = (event: Event) => commands.push((event as CustomEvent).detail);
    window.addEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, listener);
    try {
      render(<CandidateRepairReadyDialog />);
      act(() => useCandidateRepairStore.getState().applyStatus(status('candidate-a', 1, true)));
      expect(await screen.findByRole('dialog')).toHaveTextContent('project-a');
      expect(screen.getByRole('dialog')).toHaveTextContent('project-b is currently open');
      expect(commands).toEqual([]);
      expect(useProjectStore.getState().projectPath).toBe('/projects/project-b');

      fireEvent.click(screen.getByRole('button', { name: 'Open Project' }));
      expect(commands).toEqual([
        {
          command: 'open-project',
          projectPath: '/projects/project-a',
          repairCandidateId: 'candidate-a',
          readyRevision: 'sha256:ready-candidate-a-1',
        },
      ]);
      expect(useProjectStore.getState().projectPath).toBe('/projects/project-b');
    } finally {
      window.removeEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, listener);
    }
  });

  it('does not prompt for manual candidates and never stacks multiple ready dialogs', async () => {
    registerCandidate('manual', '/projects/manual', false);
    registerCandidate('first', '/projects/first');
    registerCandidate('second', '/projects/second');
    render(<CandidateRepairReadyDialog />);
    act(() => {
      useCandidateRepairStore.getState().applyStatus(status('manual', 1, true));
      useCandidateRepairStore.getState().applyStatus(status('first', 1, true));
      useCandidateRepairStore.getState().applyStatus(status('second', 1, true));
    });

    expect(await screen.findByRole('dialog')).toHaveTextContent('first');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('second');
    fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not re-prompt after dismissal until the candidate becomes invalid and valid again', async () => {
    registerCandidate('candidate-a', '/projects/a');
    render(<CandidateRepairReadyDialog />);
    act(() => useCandidateRepairStore.getState().applyStatus(status('candidate-a', 1, true)));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not Now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    act(() => useCandidateRepairStore.getState().applyStatus(status('candidate-a', 2, true)));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => useCandidateRepairStore.getState().applyStatus(status('candidate-a', 3, false)));
    act(() => useCandidateRepairStore.getState().applyStatus(status('candidate-a', 4, true)));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('withdraws the modal on invalidation and ignores a released candidate', async () => {
    registerCandidate('candidate-a', '/projects/a');
    render(<CandidateRepairReadyDialog />);
    act(() => useCandidateRepairStore.getState().applyStatus(status('candidate-a', 1, true)));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    act(() => useCandidateRepairStore.getState().applyStatus(status('candidate-a', 2, false)));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    act(() => useCandidateRepairStore.getState().release('candidate-a'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('queues readiness behind an existing repair prompt and workspace modal', async () => {
    registerCandidate('candidate-a', '/projects/a');
    const { rerender } = render(<CandidateRepairReadyDialog blocked />);
    act(() => useCandidateRepairStore.getState().applyStatus(status('candidate-a', 1, true)));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(<CandidateRepairReadyDialog />);
    act(() => useRepairPromptStore.setState({ visible: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => useRepairPromptStore.setState({ visible: false }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('withholds readiness when local candidate edits would be discarded by opening', async () => {
    registerCandidate('candidate-a', '/projects/a');
    useCandidateRepairStore.getState().setBuffer('candidate-a', 'unsaved changes');
    render(<CandidateRepairReadyDialog />);
    act(() => useCandidateRepairStore.getState().applyStatus(status('candidate-a', 1, true)));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
