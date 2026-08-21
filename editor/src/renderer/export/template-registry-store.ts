import { create } from 'zustand';
import type { InstalledTemplate } from '../../shared/project-schema/platform-export-contracts';

interface TemplateRegistryStoreState {
  templates: InstalledTemplate[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  ensureLoaded: () => Promise<InstalledTemplate[]>;
  refresh: () => Promise<InstalledTemplate[]>;
}

let loadPromise: Promise<InstalledTemplate[]> | null = null;

async function loadTemplates(): Promise<InstalledTemplate[]> {
  return window.noveltea.listPlayerTemplates();
}

export const useTemplateRegistryStore = create<TemplateRegistryStoreState>()((set, get) => ({
  templates: [],
  loaded: false,
  loading: false,
  error: null,
  async ensureLoaded() {
    if (get().loaded) return get().templates;
    if (loadPromise) return loadPromise;
    set({ loading: true, error: null });
    loadPromise = loadTemplates()
      .then((templates) => {
        set({ templates, loaded: true, loading: false, error: null });
        return templates;
      })
      .catch((error: unknown) => {
        set({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        loadPromise = null;
      });
    return loadPromise;
  },
  async refresh() {
    if (loadPromise) await loadPromise;
    set({ loading: true, error: null });
    loadPromise = loadTemplates()
      .then((templates) => {
        set({ templates, loaded: true, loading: false, error: null });
        return templates;
      })
      .catch((error: unknown) => {
        set({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        loadPromise = null;
      });
    return loadPromise;
  },
}));
