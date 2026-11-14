import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CandidateRepairEditor } from '@/editors/source/CandidateRepairEditor';
import { useCandidateRepairStore } from '@/project/candidate-repair-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useProjectStore } from '@/project/project-store';
import {
  WORKSPACE_TOOLBAR_COMMAND_EVENT,
  beginProjectOpenRequest,
} from '@/workspace/workspace-toolbar-events';
import type { WorkbenchTab } from '@/workbench/workbench-types';

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({
    value,
    onChange,
    diagnostics,
  }: {
    value: string;
    onChange: (value: string) => void;
    diagnostics: { message: string }[];
  }) => (
    <textarea
      aria-label="Project YAML"
      data-diagnostic-count={diagnostics.length}
      data-diagnostic-messages={diagnostics.map((diagnostic) => diagnostic.message).join('|')}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const candidateId = 'repair-candidate';
const tab: WorkbenchTab = {
  id: 'tab:candidate-repair:test',
  title: 'Project Candidate',
  editorType: 'candidate-repair',
  resource: { kind: 'raw', stableId: candidateId, sourceId: candidateId },
};

beforeEach(() => {
  vi.clearAllMocks();
  useWorkbenchStore.getState().resetWorkbench();
  useWorkbenchStore.getState().openTab(tab);
  useProjectStore.getState().clearProject();
  const root = '/tmp/test-candidate';
  const text = 'schema: noveltea.project.workspace\nbroken: [\n';
  useCandidateRepairStore.setState({
    entries: {
      [candidateId]: {
        id: candidateId,
        root,
        recognition: 'strong',
        diagnostics: Array.from({ length: 90 }, (_, index) => ({
          severity: 'error' as const,
          category: 'Project source syntax',
          path: '/project.yaml',
          sourcePath: 'project.yaml',
          line: index + 1,
          column: 1,
          message: `YAML issue ${index + 1}`,
        })),
        source: {
          root,
          sourcePath: 'project.yaml',
          revision: `sha256:${'a'.repeat(64)}`,
          recognition: 'strong',
          text,
        },
        buffer: text,
      },
    },
  });
});

describe('candidate YAML source editor', () => {
  it.each(['open', 'recently closed'] as const)(
    'discards the admitted candidate from %s tabs without touching another candidate',
    (placement) => {
      const unrelated: WorkbenchTab = {
        ...tab,
        id: 'tab:candidate-repair:other',
        resource: { kind: 'tool', stableId: 'candidate-repair:other', sourceId: 'other' },
      };
      useWorkbenchStore.getState().openTab(unrelated);
      if (placement === 'recently closed') {
        const state = useWorkbenchStore.getState();
        useWorkbenchStore.getState().closeTab(state.activeGroupId, tab.id);
      }
      useWorkbenchStore.getState().discardRepairCandidateTabs([candidateId]);
      const state = useWorkbenchStore.getState();
      expect(state.tabsById[tab.id]).toBeUndefined();
      expect(state.tabsById[unrelated.id]).toBeDefined();
      expect(state.recentlyClosedTabs.some((item) => item.tab.id === tab.id)).toBe(false);
    },
  );

  it('shows the raw YAML and diagnostics without a Fix button for each issue', async () => {
    render(<CandidateRepairEditor tab={tab} />);

    const source = screen.getByRole('textbox', { name: 'Project YAML' });
    expect(source).toHaveValue('schema: noveltea.project.workspace\nbroken: [\n');
    await waitFor(() => expect(source).toHaveAttribute('data-diagnostic-count', '1'));
    expect(source.getAttribute('data-diagnostic-messages')).toMatch(/flow|sequence|closing/iu);

    // Manual source editing is not another entry point into AI Fix. The
    // failed-Open dialog owns that choice, so even many diagnostics do not
    // create a row of Fix buttons above the YAML editor.
    expect(screen.queryByRole('button', { name: /fix/iu })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Project' })).not.toBeInTheDocument();
  });

  it('shows one compact source header without redundant repair instructions or dirty status', () => {
    render(<CandidateRepairEditor tab={tab} />);
    expect(screen.getByText('project.yaml')).toHaveAttribute(
      'title',
      '/tmp/test-candidate/project.yaml',
    );
    expect(screen.getByText('Ctrl+S to save')).toBeInTheDocument();
    expect(screen.queryByText('Project Candidate · Fix it')).not.toBeInTheDocument();
    const source = screen.getByRole('textbox', { name: 'Project YAML' });
    fireEvent.change(source, { target: { value: 'schema: noveltea.project.workspace\n' } });
    expect(screen.queryByText(/Candidate source has changed/iu)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps the Save hint beside the filename and centers validation in the remaining header space', () => {
    render(<CandidateRepairEditor tab={tab} />);
    const heading = screen.getByText('project.yaml').parentElement;
    expect(heading).toHaveClass('flex');
    expect(screen.getByText('Ctrl+S to save').parentElement).toBe(heading);
    expect(screen.getByText('Ctrl+S to save').nextElementSibling).toHaveClass(
      'flex-1',
      'text-center',
    );
    act(() => {
      useCandidateRepairStore.setState((state) => ({
        entries: {
          ...state.entries,
          [candidateId]: { ...state.entries[candidateId]!, saving: true },
        },
      }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');
    expect(screen.getByRole('status').parentElement).toBe(heading);
    act(() => {
      useCandidateRepairStore.setState((state) => ({
        entries: {
          ...state.entries,
          [candidateId]: {
            ...state.entries[candidateId]!,
            saving: false,
            validatingAfterSave: true,
          },
        },
      }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Validating Project…');
    expect(screen.getByRole('status').parentElement).toBe(heading);
  });

  it('does not add a validation-success row when native readiness arrives', () => {
    render(<CandidateRepairEditor tab={tab} />);
    const heading = screen.getByText('project.yaml').parentElement;
    act(() => {
      useCandidateRepairStore.setState((state) => ({
        entries: {
          ...state.entries,
          [candidateId]: {
            ...state.entries[candidateId]!,
            status: {
              id: candidateId,
              generation: 2,
              ready: true,
              revision: `sha256:${'c'.repeat(64)}`,
              diagnostics: [],
            },
          },
        },
      }));
    });
    expect(
      screen.queryByText('The source files passed read-only validation.'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('project.yaml').parentElement).toBe(heading);
    expect(screen.getByRole('textbox', { name: 'Project YAML' })).toBeInTheDocument();
  });

  it('clears and reintroduces syntax errors while typing, without saving the Project', async () => {
    render(<CandidateRepairEditor tab={tab} />);
    const source = screen.getByRole('textbox', { name: 'Project YAML' });
    const valid = 'schema: noveltea.project.workspace\nbroken: []\n';
    const invalid = 'schema: noveltea.project.workspace\nbroken: [\n';

    await waitFor(() => expect(source).toHaveAttribute('data-diagnostic-count', '1'));
    fireEvent.change(source, { target: { value: valid } });
    // Old persisted errors are hidden as soon as the unsaved buffer changes,
    // even before the debounced parser finishes.
    expect(source).toHaveAttribute('data-diagnostic-count', '0');
    await waitFor(() => expect(source).toHaveAttribute('data-diagnostic-count', '0'));
    expect(useCandidateRepairStore.getState().entries[candidateId]?.buffer).toBe(valid);
    await waitFor(() =>
      expect(useCandidateRepairStore.getState().entries[candidateId]).toMatchObject({
        syntaxText: valid,
        syntaxDiagnostics: [],
      }),
    );

    fireEvent.change(source, { target: { value: invalid } });
    await waitFor(() => expect(source).toHaveAttribute('data-diagnostic-count', '1'));
    expect(source.getAttribute('data-diagnostic-messages')).toMatch(/flow|sequence|closing/iu);
    expect(useCandidateRepairStore.getState().entries[candidateId]?.syntaxText).toBe(invalid);
    expect(useCandidateRepairStore.getState().entries[candidateId]?.source?.text).toBe(invalid);
  });

  it('opens the same candidate automatically after Save and settled native validation', async () => {
    const initial = useCandidateRepairStore.getState().entries[candidateId]!.source!;
    const repaired = 'schema: noveltea.project.workspace\nbroken: []\n';
    const saved = { ...initial, text: repaired, revision: `sha256:${'b'.repeat(64)}` };
    const status = {
      id: candidateId,
      generation: 2,
      ready: true,
      revision: `sha256:${'c'.repeat(64)}`,
      diagnostics: [],
    };
    vi.stubGlobal('noveltea', {
      ...window.noveltea,
      saveRepairCandidate: vi.fn().mockResolvedValue(saved),
      observeRepairCandidate: vi.fn().mockResolvedValue(status),
      readRepairCandidate: vi.fn().mockResolvedValue(saved),
    });
    const commands: unknown[] = [];
    const onCommand = (event: Event) => commands.push((event as CustomEvent).detail);
    window.addEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
    try {
      render(<CandidateRepairEditor tab={tab} />);
      fireEvent.change(screen.getByRole('textbox', { name: 'Project YAML' }), {
        target: { value: repaired },
      });
      expect(commands).toEqual([]);
      void useCandidateRepairStore.getState().saveAndOpen(candidateId, tab.id);
      await waitFor(() => expect(commands).toHaveLength(1));
      expect(window.noveltea.saveRepairCandidate).toHaveBeenCalledWith(
        candidateId,
        initial.revision,
        repaired,
      );
      expect(window.noveltea.observeRepairCandidate).toHaveBeenCalledWith(candidateId);
      expect(commands[0]).toEqual({
        command: 'open-project',
        projectPath: initial.root,
        repairCandidateId: candidateId,
        readyRevision: status.revision,
      });
    } finally {
      window.removeEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
      vi.unstubAllGlobals();
    }
  });

  it('opens an already-saved candidate using the native ready token without validating twice', async () => {
    const current = useCandidateRepairStore.getState().entries[candidateId]!;
    const status = {
      id: candidateId,
      generation: 3,
      ready: true,
      revision: `sha256:${'c'.repeat(64)}`,
      diagnostics: [],
    };
    useCandidateRepairStore.setState({
      entries: {
        [candidateId]: { ...current, status, diagnosticsNeedRefresh: false },
      },
    });
    vi.stubGlobal('noveltea', {
      ...window.noveltea,
      saveRepairCandidate: vi.fn(),
      observeRepairCandidate: vi.fn(),
    });
    const commands: unknown[] = [];
    const onCommand = (event: Event) => commands.push((event as CustomEvent).detail);
    window.addEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
    try {
      expect(await useCandidateRepairStore.getState().saveAndOpen(candidateId, tab.id)).toBe(true);
      expect(commands).toEqual([
        {
          command: 'open-project',
          projectPath: current.root,
          repairCandidateId: candidateId,
          readyRevision: status.revision,
        },
      ]);
      expect(window.noveltea.saveRepairCandidate).not.toHaveBeenCalled();
      expect(window.noveltea.observeRepairCandidate).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
      vi.unstubAllGlobals();
    }
  });

  it('validates a saved candidate when native readiness is not yet known', async () => {
    const current = useCandidateRepairStore.getState().entries[candidateId]!;
    const status = {
      id: candidateId,
      generation: 2,
      ready: true,
      revision: `sha256:${'d'.repeat(64)}`,
      diagnostics: [],
    };
    vi.stubGlobal('noveltea', {
      ...window.noveltea,
      saveRepairCandidate: vi.fn(),
      observeRepairCandidate: vi.fn().mockResolvedValue(status),
      readRepairCandidate: vi.fn().mockResolvedValue(current.source),
    });
    const commands: unknown[] = [];
    const onCommand = (event: Event) => commands.push((event as CustomEvent).detail);
    window.addEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
    try {
      expect(await useCandidateRepairStore.getState().saveAndOpen(candidateId, tab.id)).toBe(true);
      expect(window.noveltea.saveRepairCandidate).not.toHaveBeenCalled();
      expect(window.noveltea.observeRepairCandidate).toHaveBeenCalledWith(candidateId);
      expect(commands).toEqual([
        {
          command: 'open-project',
          projectPath: current.root,
          repairCandidateId: candidateId,
          readyRevision: status.revision,
        },
      ]);
    } finally {
      window.removeEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
      vi.unstubAllGlobals();
    }
  });

  it('retries a watcher-invalidated native check once after a successful Save', async () => {
    const initial = useCandidateRepairStore.getState().entries[candidateId]!.source!;
    const repaired = 'schema: noveltea.project.workspace\nbroken: []\n';
    const saved = { ...initial, text: repaired, revision: `sha256:${'b'.repeat(64)}` };
    const status = {
      id: candidateId,
      generation: 3,
      ready: true,
      revision: `sha256:${'c'.repeat(64)}`,
      diagnostics: [],
    };
    vi.stubGlobal('noveltea', {
      ...window.noveltea,
      saveRepairCandidate: vi.fn().mockResolvedValue(saved),
      observeRepairCandidate: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(status),
      readRepairCandidate: vi.fn().mockResolvedValue(saved),
    });
    const commands: unknown[] = [];
    const onCommand = (event: Event) => commands.push((event as CustomEvent).detail);
    window.addEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
    try {
      render(<CandidateRepairEditor tab={tab} />);
      fireEvent.change(screen.getByRole('textbox', { name: 'Project YAML' }), {
        target: { value: repaired },
      });
      void useCandidateRepairStore.getState().saveAndOpen(candidateId, tab.id);
      await waitFor(() => expect(commands).toHaveLength(1));
      expect(window.noveltea.observeRepairCandidate).toHaveBeenCalledTimes(2);
      expect(commands[0]).toMatchObject({
        repairCandidateId: candidateId,
        readyRevision: status.revision,
      });
    } finally {
      window.removeEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
      vi.unstubAllGlobals();
    }
  });

  it('does not open from background validation without the user pressing Save', async () => {
    const commands: unknown[] = [];
    const onCommand = (event: Event) => commands.push((event as CustomEvent).detail);
    window.addEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
    try {
      render(<CandidateRepairEditor tab={tab} />);
      useCandidateRepairStore.getState().applyStatus({
        id: candidateId,
        generation: 2,
        ready: true,
        revision: `sha256:${'c'.repeat(64)}`,
        diagnostics: [],
      });
      await waitFor(() =>
        expect(useCandidateRepairStore.getState().entries[candidateId]?.status?.ready).toBe(true),
      );
      expect(commands).toEqual([]);
    } finally {
      window.removeEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
    }
  });

  it('stays in repair when native validation rejects the saved candidate', async () => {
    const initial = useCandidateRepairStore.getState().entries[candidateId]!.source!;
    const repaired = 'schema: noveltea.project.workspace\nbroken: []\n';
    const saved = { ...initial, text: repaired, revision: `sha256:${'b'.repeat(64)}` };
    vi.stubGlobal('noveltea', {
      ...window.noveltea,
      saveRepairCandidate: vi.fn().mockResolvedValue(saved),
      observeRepairCandidate: vi.fn().mockResolvedValue({
        id: candidateId,
        generation: 2,
        ready: false,
        revision: null,
        diagnostics: [{ severity: 'error', path: '/project.yaml', message: 'Schema is invalid' }],
      }),
      readRepairCandidate: vi.fn().mockResolvedValue(saved),
    });
    const commands: unknown[] = [];
    const onCommand = (event: Event) => commands.push((event as CustomEvent).detail);
    window.addEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
    try {
      render(<CandidateRepairEditor tab={tab} />);
      fireEvent.change(screen.getByRole('textbox', { name: 'Project YAML' }), {
        target: { value: repaired },
      });
      void useCandidateRepairStore.getState().saveAndOpen(candidateId, tab.id);
      await waitFor(() =>
        expect(useCandidateRepairStore.getState().entries[candidateId]?.status?.ready).toBe(false),
      );
      expect(window.noveltea.observeRepairCandidate).toHaveBeenCalledWith(candidateId);
      expect(commands).toEqual([]);
      expect(useCandidateRepairStore.getState().entries[candidateId]?.admitted).not.toBe(true);
    } finally {
      window.removeEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
      vi.unstubAllGlobals();
    }
  });

  it.each(['tab change', 'project switch', 'continued typing', 'new open request'] as const)(
    'does not auto-open after %s during the Save/validation boundary',
    async (change) => {
      const initial = useCandidateRepairStore.getState().entries[candidateId]!.source!;
      const repaired = 'schema: noveltea.project.workspace\nbroken: []\n';
      const saved = { ...initial, text: repaired, revision: `sha256:${'b'.repeat(64)}` };
      let finishValidation!: (status: {
        id: string;
        generation: number;
        ready: boolean;
        revision: string;
        diagnostics: never[];
      }) => void;
      vi.stubGlobal('noveltea', {
        ...window.noveltea,
        saveRepairCandidate: vi.fn().mockResolvedValue(saved),
        observeRepairCandidate: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              finishValidation = resolve;
            }),
        ),
        readRepairCandidate: vi.fn().mockResolvedValue(saved),
      });
      const commands: unknown[] = [];
      const onCommand = (event: Event) => commands.push((event as CustomEvent).detail);
      window.addEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
      try {
        render(<CandidateRepairEditor tab={tab} />);
        fireEvent.change(screen.getByRole('textbox', { name: 'Project YAML' }), {
          target: { value: repaired },
        });
        void useCandidateRepairStore.getState().saveAndOpen(candidateId, tab.id);
        await waitFor(() => expect(window.noveltea.observeRepairCandidate).toHaveBeenCalled());
        if (change === 'tab change') {
          const other = {
            ...tab,
            id: 'tab:unrelated',
            title: 'Other',
            resource: { kind: 'raw' as const, stableId: 'other', sourceId: 'other' },
          };
          useWorkbenchStore.getState().openTab(other);
          // Returning to the candidate should not revive a canceled request.
          useWorkbenchStore
            .getState()
            .activateTab(useWorkbenchStore.getState().activeGroupId, tab.id);
        } else if (change === 'project switch') {
          useProjectStore.setState({ projectInstanceId: 'another-project' });
        } else if (change === 'continued typing') {
          useCandidateRepairStore.getState().setBuffer(candidateId, repaired + '# more edits\n');
        } else {
          // The other Project may still be loading, so ProjectStore has not
          // changed yet; its user-initiated Open request still supersedes this.
          beginProjectOpenRequest();
        }
        finishValidation({
          id: candidateId,
          generation: 2,
          ready: true,
          revision: `sha256:${'c'.repeat(64)}`,
          diagnostics: [],
        });
        await waitFor(() =>
          expect(useCandidateRepairStore.getState().entries[candidateId]?.status?.ready).toBe(true),
        );
        expect(commands).toEqual([]);
      } finally {
        window.removeEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onCommand);
        vi.unstubAllGlobals();
      }
    },
  );
});
