import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RepairPromptDialog } from '../project/RepairPromptDialog';
import { useCandidateRepairStore } from '../project/candidate-repair-store';
import { useRepairPromptStore, repairPromptRunAuthorized } from '../project/repair-prompt-store';
import { useBottomPanelStore } from '../workbench/bottom-panel-store';
import { usePreferencesStore } from '../stores/preferences-store';

vi.mock('../workbench/terminal-window-host', () => ({
  launchWindowRepairTerminal: (request: unknown) =>
    window.noveltea.launchRepairHarness(request as never),
}));

const diagnostic = {
  severity: 'error' as const,
  path: '/project.yaml',
  sourcePath: 'project.yaml',
  line: 3,
  column: 7,
  message: 'Malformed Project manifest',
};

const writeText = vi.fn<(text: string) => Promise<void>>();
const launchRepairHarness = vi.fn();

beforeEach(() => {
  usePreferencesStore.getState().resetToDefaults();
  useBottomPanelStore.setState({ activePanelId: 'problems', visible: true });
  vi.mocked(window.noveltea.probeRepairHarnesses).mockResolvedValue([]);
  vi.mocked(window.noveltea.repairModelCatalog).mockImplementation(async (harness) => ({
    harness,
    status: 'unavailable',
    models: [],
  }));
  vi.mocked(window.noveltea.launchRepairHarness).mockImplementation(launchRepairHarness);
  useCandidateRepairStore.setState({ entries: {} });
  useRepairPromptStore.setState({ draft: null, visible: false });
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  useCandidateRepairStore.getState().register('unopened', '/candidate', 'weak', [diagnostic]);
  useCandidateRepairStore.setState((state) => ({
    entries: {
      ...state.entries,
      unopened: {
        ...state.entries.unopened!,
        source: {
          root: '/candidate',
          sourcePath: 'project.yaml',
          text: 'schema: noveltea.project.workspace\nschemaVersion: 9\nbroken: [',
          revision: `sha256:${'a'.repeat(64)}`,
          recognition: 'weak',
        },
        buffer: 'schema: noveltea.project.workspace\nschemaVersion: 9\nbroken: [',
      },
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  writeText.mockReset();
  launchRepairHarness.mockReset();
});

function showPrompt() {
  act(() => {
    useRepairPromptStore.getState().request({ kind: 'candidate', id: 'unopened', scope: 'errors' });
  });
}

describe('RepairPromptDialog', () => {
  it('copies the edited prompt when Run has no installed executable', async () => {
    render(<RepairPromptDialog />);
    showPrompt();
    const textarea = await screen.findByRole('textbox', { name: 'Editable repair prompt' });
    expect((textarea as HTMLTextAreaElement).value).toContain('Project Candidate: /candidate');
    fireEvent.change(textarea, { target: { value: 'user-modified prompt\nline 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('user-modified prompt\nline 2'));
    expect(screen.getByRole('status')).toHaveTextContent('No Project files were changed');
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(screen.getByTitle(/Install Claude Code, Codex or OpenCode/)).toBeInTheDocument();
  });

  it('warns and requires separate affirmative authorization for weak and newer-format Run', async () => {
    render(<RepairPromptDialog />);
    showPrompt();
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent('Potential data loss');
    const before = useRepairPromptStore.getState().draft!;
    expect(repairPromptRunAuthorized(before)).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /only weak Project evidence/i }));
    expect(repairPromptRunAuthorized(useRepairPromptStore.getState().draft!)).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /Potential data loss/i }));
    expect(repairPromptRunAuthorized(useRepairPromptStore.getState().draft!)).toBe(true);
    // Consent gates a future Run, not a copy into the user's own tool.
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  });

  it('launches the selected installed harness from the candidate capability with the edited prompt', async () => {
    vi.mocked(window.noveltea.probeRepairHarnesses).mockResolvedValue(['codex', 'opencode']);
    launchRepairHarness.mockResolvedValue({ sessions: [], selectedSessionId: 'new-terminal' });
    render(<RepairPromptDialog />);
    showPrompt();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Editable repair prompt' }), {
      target: { value: "repair diagnostic 'text'\nsecond line ; && $(touch /tmp/no)" },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /only weak Project evidence/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Potential data loss/i }));
    expect(await screen.findByRole('option', { name: 'Codex' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Installed AI tool' }), {
      target: { value: 'opencode' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(launchRepairHarness).toHaveBeenCalledWith({
        kind: 'candidate',
        id: 'unopened',
        candidateRevision: `sha256:${'a'.repeat(64)}`,
        harness: 'opencode',
        prompt: "repair diagnostic 'text'\nsecond line ; && $(touch /tmp/no)",
        authorizeWeak: true,
        authorizeOlder: false,
        authorizeNewer: true,
      }),
    );
    await waitFor(() => expect(useBottomPanelStore.getState().activePanelId).toBe('terminal'));
    expect(useRepairPromptStore.getState().visible).toBe(false);
  });

  it('retains the prompt when native preparation or launch fails', async () => {
    vi.mocked(window.noveltea.probeRepairHarnesses).mockResolvedValue(['codex']);
    launchRepairHarness.mockRejectedValue(
      new Error('AGENT_BOOTSTRAP_MANUAL_REPAIR_REQUIRED: Fix AGENTS.md'),
    );
    render(<RepairPromptDialog />);
    showPrompt();
    fireEvent.click(screen.getByRole('checkbox', { name: /only weak Project evidence/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Potential data loss/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('alert')
          .some((element) =>
            element.textContent?.includes('AGENT_BOOTSTRAP_MANUAL_REPAIR_REQUIRED'),
          ),
      ).toBe(true),
    );
    expect(useRepairPromptStore.getState().visible).toBe(true);
    expect(useBottomPanelStore.getState().activePanelId).toBe('problems');
  });

  it('selects discovered model, stores it editor-wide, and sends one explicit override', async () => {
    vi.mocked(window.noveltea.probeRepairHarnesses).mockResolvedValue(['codex']);
    vi.mocked(window.noveltea.repairModelCatalog).mockResolvedValue({
      harness: 'codex',
      status: 'available',
      models: ['gpt-6-fast', 'gpt-6-high'],
    });
    launchRepairHarness.mockResolvedValue({ sessions: [], selectedSessionId: 'new-terminal' });
    render(<RepairPromptDialog />);
    showPrompt();
    fireEvent.click(screen.getByRole('checkbox', { name: /only weak Project evidence/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Potential data loss/i }));
    await screen.findByRole('option', { name: 'gpt-6-high' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
      target: { value: 'gpt-6-high' },
    });
    expect(usePreferencesStore.getState().repair).toMatchObject({
      preferredHarness: null,
      modelByHarness: { codex: 'gpt-6-high', claude: '', opencode: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(launchRepairHarness).toHaveBeenCalledWith(
        expect.objectContaining({ harness: 'codex', model: 'gpt-6-high' }),
      ),
    );
  });

  it('keeps manual entry usable when model listing fails, without persisting bad IDs', async () => {
    vi.mocked(window.noveltea.probeRepairHarnesses).mockResolvedValue(['codex']);
    vi.mocked(window.noveltea.repairModelCatalog).mockRejectedValue(new Error('offline'));
    launchRepairHarness.mockResolvedValue({ sessions: [], selectedSessionId: 'new-terminal' });
    render(<RepairPromptDialog />);
    showPrompt();
    fireEvent.click(screen.getByRole('checkbox', { name: /only weak Project evidence/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Potential data loss/i }));
    expect(await screen.findByText(/Catalog unavailable/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
      target: { value: '__manual__' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Model ID override' }), {
      target: { value: 'bad model with spaces' },
    });
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(usePreferencesStore.getState().repair.modelByHarness.codex).toBe('');
    fireEvent.change(screen.getByRole('textbox', { name: 'Model ID override' }), {
      target: { value: 'openai/gpt-6#high' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(launchRepairHarness).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'openai/gpt-6#high' }),
      ),
    );
  });

  it('warns about disappeared saved models without silently selecting a substitute', async () => {
    usePreferencesStore.getState().setRepairHarness('codex');
    usePreferencesStore.getState().setRepairModel('codex', 'gpt-deprecated');
    vi.mocked(window.noveltea.probeRepairHarnesses).mockResolvedValue(['codex']);
    vi.mocked(window.noveltea.repairModelCatalog).mockResolvedValue({
      harness: 'codex',
      status: 'available',
      models: ['gpt-current'],
    });
    launchRepairHarness.mockResolvedValue({ sessions: [], selectedSessionId: 'new-terminal' });
    render(<RepairPromptDialog />);
    showPrompt();
    expect(await screen.findByRole('alert', { name: '' })).toHaveTextContent('Potential data loss');
    await waitFor(() =>
      expect(
        screen.getAllByRole('alert').some((item) => item.textContent?.includes('gpt-deprecated')),
      ).toBe(true),
    );
    expect(screen.getByRole('textbox', { name: 'Model ID override' })).toHaveValue(
      'gpt-deprecated',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /only weak Project evidence/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Potential data loss/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(launchRepairHarness).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-deprecated' }),
      ),
    );
  });

  it('retains the edited text but blocks stale copies until regeneration against current diagnostics', async () => {
    render(<RepairPromptDialog />);
    showPrompt();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Editable repair prompt' }), {
      target: { value: 'preserve this edit' },
    });
    act(() => {
      useCandidateRepairStore.setState((state) => ({
        entries: {
          ...state.entries,
          unopened: {
            ...state.entries.unopened!,
            diagnostics: [{ ...diagnostic, message: 'Changed diagnostic' }],
          },
        },
      }));
    });
    expect(
      screen
        .getAllByRole('alert')
        .some((alert) => alert.textContent?.includes('Project source or diagnostics changed')),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Editable repair prompt' })).toHaveValue(
      'preserve this edit',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate from current diagnostics' }));
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeEnabled();
    expect(
      (screen.getByRole('textbox', { name: 'Editable repair prompt' }) as HTMLTextAreaElement)
        .value,
    ).toContain('Changed diagnostic');
  });
});
