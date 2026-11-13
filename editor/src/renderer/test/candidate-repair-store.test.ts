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
