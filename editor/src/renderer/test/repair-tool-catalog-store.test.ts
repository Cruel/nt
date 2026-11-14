import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  refreshRepairToolCatalog,
  useRepairToolCatalogStore,
} from '../project/repair-tool-catalog-store';

beforeEach(() => {
  useRepairToolCatalogStore.setState({ harnesses: [], catalogs: {}, probed: false });
  vi.mocked(window.noveltea.probeRepairHarnesses).mockReset();
  vi.mocked(window.noveltea.repairModelCatalog).mockReset();
});

describe('editor-wide repair tool discovery', () => {
  it('preloads model catalogs for all installed tools before Repair is opened', async () => {
    vi.mocked(window.noveltea.probeRepairHarnesses).mockResolvedValue(['codex', 'opencode']);
    vi.mocked(window.noveltea.repairModelCatalog).mockImplementation(async (harness) => ({
      harness,
      status: 'available',
      models: harness === 'codex' ? ['gpt-6-luna'] : ['openai/gpt-6.1-sol'],
    }));

    await refreshRepairToolCatalog();
    expect(useRepairToolCatalogStore.getState()).toMatchObject({
      probed: true,
      harnesses: ['codex', 'opencode'],
      catalogs: {
        codex: { status: 'available', models: ['gpt-6-luna'] },
        opencode: { status: 'available', models: ['openai/gpt-6.1-sol'] },
      },
    });
    expect(window.noveltea.repairModelCatalog).toHaveBeenCalledWith('codex', false);
    expect(window.noveltea.repairModelCatalog).toHaveBeenCalledWith('opencode', false);
  });

  it('keeps cached choices through an in-flight refresh and applies a changed catalog in place', async () => {
    useRepairToolCatalogStore.setState({
      harnesses: ['codex'],
      probed: true,
      catalogs: { codex: { harness: 'codex', status: 'available', models: ['gpt-6-luna'] } },
    });
    let resolveProbe!: (installed: ('codex' | 'opencode')[]) => void;
    vi.mocked(window.noveltea.probeRepairHarnesses).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );
    vi.mocked(window.noveltea.repairModelCatalog).mockImplementation(async (harness) => ({
      harness,
      status: 'available',
      models: ['gpt-6-luna', 'gpt-6-high'],
    }));

    const refreshing = refreshRepairToolCatalog(true);
    const concurrent = refreshRepairToolCatalog(true);
    expect(concurrent).toBe(refreshing);
    expect(useRepairToolCatalogStore.getState().catalogs.codex?.models).toEqual(['gpt-6-luna']);
    resolveProbe(['codex']);
    await refreshing;
    expect(useRepairToolCatalogStore.getState().catalogs.codex?.models).toEqual([
      'gpt-6-luna',
      'gpt-6-high',
    ]);
    expect(window.noveltea.repairModelCatalog).toHaveBeenCalledWith('codex', true);
    expect(window.noveltea.probeRepairHarnesses).toHaveBeenCalledTimes(1);
  });

  it('does not clear a usable model catalog after a transient background failure', async () => {
    useRepairToolCatalogStore.setState({
      harnesses: ['codex'],
      probed: true,
      catalogs: { codex: { harness: 'codex', status: 'available', models: ['gpt-6-luna'] } },
    });
    vi.mocked(window.noveltea.probeRepairHarnesses).mockResolvedValue(['codex']);
    vi.mocked(window.noveltea.repairModelCatalog).mockRejectedValue(new Error('offline'));
    await refreshRepairToolCatalog(true);
    expect(useRepairToolCatalogStore.getState().catalogs.codex?.models).toEqual(['gpt-6-luna']);
    vi.mocked(window.noveltea.probeRepairHarnesses).mockRejectedValue(new Error('offline'));
    await refreshRepairToolCatalog(true);
    expect(useRepairToolCatalogStore.getState().harnesses).toEqual(['codex']);
  });
});
