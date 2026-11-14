import { create } from 'zustand';
import {
  REPAIR_HARNESSES,
  type RepairHarness,
  type RepairModelCatalog,
} from '../../shared/repair-harness';

interface RepairToolCatalogState {
  harnesses: RepairHarness[];
  catalogs: Partial<Record<RepairHarness, RepairModelCatalog>>;
  /** A failed probe does not invalidate the last known installed tools. */
  probed: boolean;
}

export const useRepairToolCatalogStore = create<RepairToolCatalogState>()(() => ({
  harnesses: [],
  catalogs: {},
  probed: false,
}));

let pendingRefresh: Promise<void> | null = null;

/**
 * Preload once when the editor starts; refresh on Repair open. Keep old results
 * visible while rechecking. Native catalog queries can take several seconds and
 * already have their own TTL, so share in-flight work across callers.
 */
export function refreshRepairToolCatalog(force = false): Promise<void> {
  if (pendingRefresh) return pendingRefresh;
  const request = (async () => {
    let installed: RepairHarness[];
    try {
      installed = (await window.noveltea.probeRepairHarnesses()).filter((harness) =>
        REPAIR_HARNESSES.includes(harness),
      );
    } catch {
      useRepairToolCatalogStore.setState({ probed: true });
      return;
    }
    const current = useRepairToolCatalogStore.getState();
    // Don't rerender selectors when nothing changed.
    if (
      !current.probed ||
      installed.length !== current.harnesses.length ||
      installed.some((harness, index) => current.harnesses[index] !== harness)
    )
      useRepairToolCatalogStore.setState({ harnesses: installed, probed: true });

    await Promise.all(
      installed.map(async (harness) => {
        let catalog: RepairModelCatalog;
        try {
          catalog = await window.noveltea.repairModelCatalog(harness, force);
        } catch {
          catalog = { harness, status: 'unavailable', models: [] };
        }
        const old = useRepairToolCatalogStore.getState().catalogs[harness];
        // Preserve a usable list if a background refresh transiently fails.
        if (catalog.status !== 'available' && old?.status === 'available') return;
        if (
          old?.status === catalog.status &&
          old.models.length === catalog.models.length &&
          old.models.every((model, index) => model === catalog.models[index])
        )
          return;
        useRepairToolCatalogStore.setState((state) => ({
          catalogs: { ...state.catalogs, [harness]: catalog },
        }));
      }),
    );
  })();
  pendingRefresh = request;
  void request.finally(() => {
    if (pendingRefresh === request) pendingRefresh = null;
  });
  return request;
}
