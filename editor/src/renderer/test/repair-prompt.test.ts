import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { ToolDiagnostic } from '../../shared/editor-tooling';
import type { AuthoringDependencyGraphSnapshot } from '../../shared/authoring-dependency-contracts';
import { useCandidateRepairStore } from '../project/candidate-repair-store';
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

function graph(): AuthoringDependencyGraphSnapshot {
  return {
    graph: {
      edgesById: new Map([
        [
          'reference',
          { sourcePath: '/rooms/foyer/data/visual', targetPath: '/assets/logo/data/source' },
        ],
        ['unrelated', { sourcePath: '/rooms/other/data/visual', targetPath: '/assets/other' }],
      ]),
    },
  } as unknown as AuthoringDependencyGraphSnapshot;
}

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

  it('retains source anchors, exact files, graph-confirmed dependency context, and narrow non-target constraints', () => {
    const prompt = buildRepairPrompt({
      root: '/candidate with spaces',
      kind: 'active',
      scope: 'one',
      diagnostics,
      selectedKey: repairDiagnosticKey(diagnostics[0]!),
      graph: graph(),
    })!;
    expect(prompt).toContain('Project root: /candidate with spaces');
    expect(prompt).toContain('records/rooms/foyer.yaml:9:3');
    expect(prompt).toContain('Dependency context');
    expect(prompt).toContain('/assets/logo (records/assets/logo.yaml)');
    expect(prompt).not.toContain('Unused Asset');
    expect(prompt).not.toContain('/assets/other');
    expect(prompt).toContain('Do not change unrelated records');
    expect(prompt).toContain('noveltea repair project');
    expect(prompt).toContain('noveltea validate` only after');
  });

  it('includes warnings only for Fix All and does not fabricate unverified dependencies', () => {
    const common = { root: '/p', kind: 'candidate' as const, diagnostics };
    const all = buildRepairPrompt({ ...common, scope: 'all' })!;
    const errors = buildRepairPrompt({ ...common, scope: 'errors' })!;
    expect(all).toContain('Unused Asset');
    expect(errors).not.toContain('Unused Asset');
    expect(errors).toContain('No additional dependency paths verified');
    expect(errors).toContain('only after the manifest and Project can be parsed');
  });

  it('locates physical Layout YAML for stable IDs with underscores', () => {
    const prompt = buildRepairPrompt({
      root: '/project',
      kind: 'active',
      scope: 'errors',
      diagnostics: [
        { severity: 'error', path: '/layouts/room_1/data/style', message: 'Invalid Layout style' },
      ],
    });
    expect(prompt).toContain('records/layouts/room_1/layout.yaml');
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
    expect(draft.text).toContain('Selected diagnostics:');
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
