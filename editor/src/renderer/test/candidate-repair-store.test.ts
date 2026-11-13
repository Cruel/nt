import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { useCandidateRepairStore } from '../project/candidate-repair-store';
import type { CandidateRepairSource } from '../../shared/project-candidate-repair';

const initial: CandidateRepairSource = {
  root: '/candidate',
  sourcePath: 'project.yaml',
  text: 'schema: noveltea.project.workspace\nbroken: [\n',
  revision: `sha256:${'a'.repeat(64)}`,
  recognition: 'strong',
};

beforeEach(() => {
  vi.stubGlobal('noveltea', {
    ...window.noveltea,
    readRepairCandidate: vi.fn(),
    saveRepairCandidate: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useCandidateRepairStore.setState({ entries: {} });
});

describe('candidate repair renderer buffer', () => {
  it('allows fresh native validation diagnostics after candidate Save and an external source refresh', async () => {
    const read = vi.spyOn(window.noveltea, 'readRepairCandidate').mockResolvedValue(initial);
    const store = useCandidateRepairStore.getState();
    store.register('current', initial.root, 'strong', [
      { severity: 'error', path: '/project.yaml', message: 'Old parsing issue' },
    ]);
    await store.load('current');
    store.setBuffer('current', 'repaired source');
    useCandidateRepairStore.setState((state) => ({
      entries: {
        ...state.entries,
        current: {
          ...state.entries.current!,
          source: {
            ...initial,
            text: 'repaired source',
            revision: `sha256:${'b'.repeat(64)}`,
          },
          diagnostics: [],
          diagnosticsNeedRefresh: true,
        },
      },
    }));
    read.mockResolvedValue({
      ...initial,
      text: 'repaired source',
      revision: `sha256:${'b'.repeat(64)}`,
    });
    store.applyStatus({
      id: 'current',
      generation: 2,
      ready: false,
      revision: null,
      diagnostics: [{ severity: 'warning', path: '/project.yaml', message: 'New warning' }],
    });
    await vi.waitFor(() =>
      expect(useCandidateRepairStore.getState().entries.current?.loading).toBe(false),
    );
    let entry = useCandidateRepairStore.getState().entries.current!;
    expect(entry.diagnosticsNeedRefresh).toBe(false);
    expect(entry.diagnostics).toMatchObject([{ message: 'New warning' }]);

    // Later external source updates are independently validated. A matching
    // native status and source read must not discard the newly checked errors.
    read.mockResolvedValue({
      ...initial,
      text: 'newer malformed source',
      revision: `sha256:${'c'.repeat(64)}`,
    });
    store.applyStatus({
      id: 'current',
      generation: 3,
      ready: false,
      revision: null,
      diagnostics: [{ severity: 'error', path: '/project.yaml', message: 'New parse error' }],
    });
    await vi.waitFor(() =>
      expect(useCandidateRepairStore.getState().entries.current?.source?.revision).toBe(
        `sha256:${'c'.repeat(64)}`,
      ),
    );
    entry = useCandidateRepairStore.getState().entries.current!;
    expect(entry.diagnostics).toMatchObject([{ message: 'New parse error' }]);
    expect(entry.diagnosticsNeedRefresh).toBe(false);
  });

  it('refreshes physical diagnostics without replacing unsaved source or promoting Projects', async () => {
    const read = vi.spyOn(window.noveltea, 'readRepairCandidate').mockResolvedValue(initial);
    const open = vi.spyOn(window.noveltea, 'openProject');
    const store = useCandidateRepairStore.getState();
    store.register('repair-status', initial.root, 'strong', []);
    await store.load('repair-status');
    store.setBuffer('repair-status', 'unsaved candidate edit');
    const external = {
      ...initial,
      text: 'repaired by external process',
      revision: `sha256:${'d'.repeat(64)}`,
    };
    read.mockResolvedValue(external);
    store.applyStatus({
      id: 'repair-status',
      generation: 3,
      ready: true,
      revision: `sha256:${'e'.repeat(64)}`,
      diagnostics: [
        {
          severity: 'warning',
          path: '/records/rooms/study.yaml',
          sourcePath: 'records/rooms/study.yaml',
          line: 7,
          column: 4,
          message: 'Physical source warning',
        },
      ],
    });
    await vi.waitFor(() =>
      expect(useCandidateRepairStore.getState().entries['repair-status']?.diskSource).toEqual(
        external,
      ),
    );
    const entry = useCandidateRepairStore.getState().entries['repair-status']!;
    expect(entry.buffer).toBe('unsaved candidate edit');
    expect(entry.diagnostics[0]).toMatchObject({
      sourcePath: 'records/rooms/study.yaml',
      line: 7,
    });
    expect(open).not.toHaveBeenCalled();
    store.applyStatus({
      id: 'repair-status',
      generation: 2,
      ready: false,
      revision: null,
      diagnostics: [],
    });
    expect(useCandidateRepairStore.getState().entries['repair-status']?.status?.ready).toBe(true);
    store.revokeRoot(initial.root);
    store.applyStatus({
      id: 'repair-status',
      generation: 4,
      ready: true,
      revision: `sha256:${'f'.repeat(64)}`,
      diagnostics: [],
    });
    expect(useCandidateRepairStore.getState().entries['repair-status']?.admitted).toBe(true);
    expect(useCandidateRepairStore.getState().entries['repair-status']?.status).toBeUndefined();
  });

  it('keeps local source edits independent from the disk and admitted Project', async () => {
    const read = vi.spyOn(window.noveltea, 'readRepairCandidate').mockResolvedValue(initial);
    useCandidateRepairStore.getState().register('repair-1', initial.root, 'strong', []);
    await useCandidateRepairStore.getState().load('repair-1');
    expect(read).toHaveBeenCalledWith('repair-1');
    useCandidateRepairStore.getState().setBuffer('repair-1', 'my invalid yaml: [');
    const external = {
      ...initial,
      text: 'different disk source',
      revision: `sha256:${'b'.repeat(64)}`,
    };
    read.mockResolvedValue(external);
    await useCandidateRepairStore.getState().load('repair-1', true);
    const conflicted = useCandidateRepairStore.getState().entries['repair-1']!;
    expect(conflicted.source?.revision).toBe(initial.revision);
    expect(conflicted.buffer).toBe('my invalid yaml: [');
    expect(conflicted.diskText).toBe('different disk source');
    const save = vi.spyOn(window.noveltea, 'saveRepairCandidate');
    expect(await useCandidateRepairStore.getState().save('repair-1')).toBe(false);
    expect(save).not.toHaveBeenCalled();
    useCandidateRepairStore.getState().useDisk('repair-1');
    expect(useCandidateRepairStore.getState().entries['repair-1']?.buffer).toBe(external.text);
    expect(useCandidateRepairStore.getState().entries['repair-1']?.source?.revision).toBe(
      external.revision,
    );
  });

  it('retains later typing after an in-flight source Save finishes', async () => {
    let acknowledge!: (value: CandidateRepairSource) => void;
    vi.spyOn(window.noveltea, 'readRepairCandidate').mockResolvedValue(initial);
    vi.spyOn(window.noveltea, 'saveRepairCandidate').mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const store = useCandidateRepairStore.getState();
    store.register('repair-2', initial.root, 'strong', []);
    await store.load('repair-2');
    store.setBuffer('repair-2', 'first edit');
    const saving = store.save('repair-2');
    store.setBuffer('repair-2', 'second edit');
    acknowledge({ ...initial, text: 'first edit', revision: `sha256:${'c'.repeat(64)}` });
    expect(await saving).toBe(false); // Later keystrokes remain dirty.
    expect(useCandidateRepairStore.getState().entries['repair-2']?.buffer).toBe('second edit');
    expect(useCandidateRepairStore.getState().entries['repair-2']?.source?.text).toBe('first edit');
  });
});
