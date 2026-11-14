import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { ToolDiagnostic } from '../../shared/editor-tooling';
import { useCandidateRepairStore } from '../project/candidate-repair-store';
import { useProjectStore } from '../project/project-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import {
  useRepairPromptStore,
  repairPromptIsCurrent,
  repairPromptRunAuthorized,
} from '../project/repair-prompt-store';
import {
  repairDiagnosticKey,
  selectedRepairDiagnostics,
  buildRepairPrompt,
  candidateFormatRisk,
} from '../project/repair-prompt';

const diagnostics: ToolDiagnostic[] = [
  {
    severity: 'error',
    code: 'room.invalid',
    path: '/rooms/foyer/data/name',
    sourcePath: 'records/rooms/foyer.yaml',
    line: 9,
    column: 3,
    message: 'Invalid Room field',
    ownerPaths: ['/rooms/foyer'],
  },
  {
    severity: 'warning',
    code: 'asset.unused',
    path: '/assets/logo',
    sourcePath: 'records/assets/logo.yaml',
    line: 2,
    message: 'Unused Asset',
  },
  { severity: 'info', path: '/settings', message: 'Informational item' },
];

beforeEach(() => {
  useRepairPromptStore.setState({ visible: false, draft: null });
  useCandidateRepairStore.setState({ entries: {} });
});

describe('scoped Project diagnostic prompts', () => {
  it('filters errors, warnings, and one exact diagnostic without an incidental info item', () => {
    expect(selectedRepairDiagnostics(diagnostics, 'all')).toEqual(diagnostics.slice(0, 2));
    expect(selectedRepairDiagnostics(diagnostics, 'errors')).toEqual([diagnostics[0]]);
    expect(
      selectedRepairDiagnostics(diagnostics, 'one', repairDiagnosticKey(diagnostics[1]!)),
    ).toEqual([diagnostics[1]]);
    expect(selectedRepairDiagnostics(diagnostics, 'one', 'a removed diagnostic')).toEqual([]);
    expect(
      buildRepairPrompt({
        root: '/p',
        kind: 'active',
        scope: 'one',
        diagnostics,
        selectedKey: 'removed',
      }),
    ).toBeNull();
  });

  it('provides a source anchor and compact Project-only guidance', () => {
    const prompt = buildRepairPrompt({
      root: '/candidate with spaces',
      kind: 'active',
      scope: 'one',
      diagnostics,
      selectedKey: repairDiagnosticKey(diagnostics[0]!),
    })!;
    expect(prompt).toContain('Project root: /candidate with spaces');
    expect(prompt).toContain('records/rooms/foyer.yaml:9:3');
    expect(prompt).not.toContain('Unused Asset');
    expect(prompt).toContain('Read, search, and modify files only inside this Project root');
    expect(prompt).toContain('Follow the Project AGENTS.md');
    expect(prompt).not.toContain('noveltea validate');
    expect(prompt).not.toContain('Dependency context');
  });
  it('shows saved-versus-working values and blocks unsupported editor-state repair', () => {
    const savedDocument = { rooms: { foyer: { data: { name: 'Saved', description: 'Same' } } } };
    const workingDocument = { rooms: { foyer: { data: { name: '', description: 'Same' } } } };
    const prompt = buildRepairPrompt({
      root: '/projects/feature-lab',
      kind: 'active',
      scope: 'one',
      diagnostics,
      selectedKey: repairDiagnosticKey(diagnostics[0]!),
      savedDocument,
      workingDocument,
    })!;
    expect(prompt).toContain('Saved "Saved"; editor working "".');
    expect(prompt).toContain('Read, search, and modify files only inside this Project root');
    expect(prompt).toContain('Editor diagnostics may come from unsaved working state');
    expect(prompt).toContain('never by editing .noveltea/ recovery files');
    expect(prompt).toContain('report the blocker immediately and stop');
    expect(prompt).toContain('do not search for undocumented APIs or workarounds');
    const candidate = buildRepairPrompt({
      root: '/projects/feature-lab',
      kind: 'candidate',
      scope: 'errors',
      diagnostics,
    })!;
    expect(candidate).not.toContain('Editor diagnostics may come from unsaved working state');
  });

  it('does not attribute a diagnostic to unrelated unsaved edits', () => {
    const base = { rooms: { foyer: { data: { name: 'Saved', description: 'Same' } } } };
    const modified = { rooms: { foyer: { data: { name: 'Saved', description: 'Changed' } } } };
    const input = {
      root: '/project',
      kind: 'active' as const,
      scope: 'errors' as const,
      diagnostics,
    };
    expect(
      buildRepairPrompt({ ...input, savedDocument: base, workingDocument: modified }),
    ).toContain('Other unsaved edits exist in /rooms/foyer; they may not cause this issue.');
    expect(
      buildRepairPrompt({ ...input, savedDocument: base, workingDocument: base }),
    ).not.toContain('Other unsaved edits');
    expect(buildRepairPrompt(input)).not.toContain('Saved/working comparison unavailable.');
  });
  it('feeds the real active Project saved-versus-working values into the Fix prompt', () => {
    const beforeProject = useProjectStore.getState();
    const beforeWorkspace = useWorkspaceStore.getState();
    try {
      useProjectStore.setState({
        projectPath: '/projects/feature-lab',
        projectSessionId: 'session-working',
        projectRevision: 17,
        savedDocument: { rooms: { foyer: { data: { name: 'a.a' } } } },
        document: { rooms: { foyer: { data: { name: '' } } } },
      });
      useWorkspaceStore.setState({ diagnostics: [diagnostics[0]!] });
      expect(
        useRepairPromptStore.getState().request({
          kind: 'active',
          id: 'session-working',
          scope: 'errors',
        }),
      ).toBe(true);
      const prompt = useRepairPromptStore.getState().draft?.text;
      expect(prompt).toContain('Saved "a.a"; editor working "".');
      expect(prompt).toContain('Read, search, and modify files only inside this Project root');
    } finally {
      useProjectStore.setState(beforeProject);
      useWorkspaceStore.setState(beforeWorkspace);
    }
  });

  it('includes warnings only for Fix All and keeps the prompt short', () => {
    const common = { root: '/p', kind: 'candidate' as const, diagnostics };
    const all = buildRepairPrompt({ ...common, scope: 'all' })!;
    const errors = buildRepairPrompt({ ...common, scope: 'errors' })!;
    expect(all).toContain('Unused Asset');
    expect(errors).not.toContain('Unused Asset');
    expect(errors).toContain('Scope: all errors');
    expect(errors.split('\n').length).toBeLessThan(12);
  });

  it('does not recommend an out-of-root diagnostic source path', () => {
    const prompt = buildRepairPrompt({
      root: '/project',
      kind: 'candidate',
      scope: 'errors',
      diagnostics: [
        {
          severity: 'error',
          path: '/unknown',
          sourcePath: '../outside/private.yaml',
          message: 'bad',
        },
        {
          severity: 'error',
          path: '/unknown',
          sourcePath: '/home/user/dev/nt/internal.cpp',
          message: 'bad',
        },
        {
          severity: 'error',
          path: '/unknown',
          sourcePath: 'C:\\dev\\nt\\internal.cpp',
          message: 'bad',
        },
      ],
    })!;
    expect(prompt).not.toContain('private.yaml');
    expect(prompt).not.toContain('internal.cpp');
    expect(prompt).toContain('Read, search, and modify files only inside this Project root');
  });
  it('detects manifest schema-version risk independently of broken YAML syntax', () => {
    expect(
      candidateFormatRisk('schema: noveltea.project.workspace\nschemaVersion: 99\nbroken: ['),
    ).toBe('newer');
    expect(candidateFormatRisk('schemaVersion: 0')).toBe('older');
    expect(candidateFormatRisk('schemaVersion: 1')).toBe('current');
    expect(candidateFormatRisk('schemaVersion: 4\nschemaVersion: 1')).toBe('unknown');
    expect(candidateFormatRisk('schemaVersion: ?')).toBe('unknown');
    expect(candidateFormatRisk(undefined)).toBe('unknown');
  });

  it('does not silently retarget a corrected diagnostic and preserves editable text until a new scope', () => {
    const candidate = useCandidateRepairStore.getState();
    candidate.register('candidate-1', '/repair', 'strong', diagnostics);
    const prompt = useRepairPromptStore.getState();
    expect(
      prompt.request({
        kind: 'candidate',
        id: 'candidate-1',
        scope: 'one',
        selectedKey: repairDiagnosticKey(diagnostics[0]!),
      }),
    ).toBe(true);
    prompt.setText('my edited repair instructions');
    const before = useRepairPromptStore.getState().draft!;
    expect(repairPromptIsCurrent(before)).toBe(true);
    useCandidateRepairStore.setState((state) => ({
      entries: {
        ...state.entries,
        'candidate-1': { ...state.entries['candidate-1']!, diagnostics: [diagnostics[1]!] },
      },
    }));
    expect(repairPromptIsCurrent(before)).toBe(false);
    expect(useRepairPromptStore.getState().draft?.text).toBe('my edited repair instructions');
    expect(
      prompt.request({
        kind: 'candidate',
        id: 'candidate-1',
        scope: 'one',
        selectedKey: repairDiagnosticKey(diagnostics[0]!),
      }),
    ).toBe(false);
    expect(prompt.request({ kind: 'candidate', id: 'candidate-1', scope: 'errors' })).toBe(false);
    expect(prompt.request({ kind: 'candidate', id: 'candidate-1', scope: 'all' })).toBe(true);
    expect(repairPromptIsCurrent(useRepairPromptStore.getState().draft!)).toBe(true);
  });

  it('invalidates prompts when a failed candidate source changes locally or is saved', () => {
    const store = useCandidateRepairStore.getState();
    store.register('editing', '/candidate', 'strong', [diagnostics[0]!]);
    useCandidateRepairStore.setState((state) => ({
      entries: {
        ...state.entries,
        editing: {
          ...state.entries.editing!,
          source: {
            root: '/candidate',
            sourcePath: 'project.yaml',
            text: 'schemaVersion: 1\nbroken: [',
            revision: 'old',
            recognition: 'strong',
          },
          buffer: 'schemaVersion: 1\nbroken: [',
        },
      },
    }));
    const request = { kind: 'candidate' as const, id: 'editing', scope: 'errors' as const };
    expect(useRepairPromptStore.getState().request(request)).toBe(true);
    const draft = useRepairPromptStore.getState().draft!;
    store.setBuffer('editing', 'schemaVersion: 1\nrepaired: true');
    expect(repairPromptIsCurrent(draft)).toBe(false);
    expect(useRepairPromptStore.getState().request(request)).toBe(false);
    store.setBuffer('editing', 'schemaVersion: 1\nbroken: [');
    expect(repairPromptIsCurrent(draft)).toBe(true);
    useCandidateRepairStore.setState((state) => ({
      entries: {
        ...state.entries,
        editing: { ...state.entries.editing!, diagnosticsNeedRefresh: true },
      },
    }));
    expect(repairPromptIsCurrent(draft)).toBe(false);
    expect(useRepairPromptStore.getState().request(request)).toBe(false);
  });

  it('refuses a future Run when the candidate schema version is still unknown', () => {
    useCandidateRepairStore
      .getState()
      .register('unread', '/candidate', 'strong', [diagnostics[0]!]);
    expect(
      useRepairPromptStore.getState().request({ kind: 'candidate', id: 'unread', scope: 'errors' }),
    ).toBe(true);
    const draft = useRepairPromptStore.getState().draft!;
    expect(draft.formatRisk).toBe('unknown');
    expect(draft.manifestAbsent).toBe(false);
    expect(repairPromptRunAuthorized(draft)).toBe(false);
    expect(draft.text).toContain('1. [error] room.invalid');
  });

  it('gates future Run separately for weak evidence and newer schema, never Copy', () => {
    const candidate = useCandidateRepairStore.getState();
    candidate.register('weak', '/candidate', 'weak', [diagnostics[0]!]);
    useCandidateRepairStore.setState((state) => ({
      entries: {
        ...state.entries,
        weak: {
          ...state.entries.weak!,
          source: {
            root: '/candidate',
            sourcePath: 'project.yaml',
            text: 'schemaVersion: 99\nbroken: [',
            revision: 'rev',
            recognition: 'weak',
          },
          buffer: 'schemaVersion: 99\nbroken: [',
        },
      },
    }));
    const prompt = useRepairPromptStore.getState();
    expect(prompt.request({ kind: 'candidate', id: 'weak', scope: 'errors' })).toBe(true);
    expect(useRepairPromptStore.getState().draft?.formatRisk).toBe('newer');
    expect(repairPromptRunAuthorized(useRepairPromptStore.getState().draft!)).toBe(false);
    prompt.setAuthorization('authorizeWeak', true);
    expect(repairPromptRunAuthorized(useRepairPromptStore.getState().draft!)).toBe(false);
    prompt.setAuthorization('authorizeNewer', true);
    expect(repairPromptRunAuthorized(useRepairPromptStore.getState().draft!)).toBe(true);
    candidate.revokeRoot('/candidate');
    expect(repairPromptRunAuthorized(useRepairPromptStore.getState().draft!)).toBe(false);
  });
});
