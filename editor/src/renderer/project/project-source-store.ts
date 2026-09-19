import { create } from 'zustand';
import type { ProjectSourceFile } from '../../shared/project-source-files';

interface ProjectSourceStoreState {
  projectSessionId: string | null;
  files: readonly ProjectSourceFile[];
  textById: Readonly<Record<string, string>>;
  loading: boolean;
  error: string | null;
  clear: () => void;
  refresh: (projectSessionId: string) => Promise<void>;
}

const READ_BATCH_SIZE = 8;

export const useProjectSourceStore = create<ProjectSourceStoreState>()((set, get) => ({
  projectSessionId: null,
  files: [],
  textById: {},
  loading: false,
  error: null,
  clear: () =>
    set({ projectSessionId: null, files: [], textById: {}, loading: false, error: null }),
  refresh: async (projectSessionId) => {
    if (get().projectSessionId === projectSessionId && get().loading) return;
    set({ projectSessionId, loading: true, error: null });
    try {
      const listed = await window.noveltea.listProjectSourceFiles({ projectSessionId });
      if (get().projectSessionId !== projectSessionId) return;
      const textById: Record<string, string> = {};
      const textFiles = listed.files.filter((file) => file.text);
      for (let index = 0; index < textFiles.length; index += READ_BATCH_SIZE) {
        const batch = textFiles.slice(index, index + READ_BATCH_SIZE);
        const response = await window.noveltea.readProjectTextSources({
          projectSessionId,
          entries: batch.map((file) => ({
            readKey: file.id,
            projectRelativePath: file.projectRelativePath,
            expectedContentHash: null,
          })),
        });
        if (get().projectSessionId !== projectSessionId) return;
        for (const entry of response.entries)
          if (entry.status === 'ready') textById[entry.readKey] = entry.text;
      }
      set({ files: listed.files, textById, loading: false, error: null });
    } catch (error) {
      if (get().projectSessionId !== projectSessionId) return;
      set({
        files: [],
        textById: {},
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));

export function findProjectSourceByAssetId(
  files: readonly ProjectSourceFile[],
  assetId: string,
): ProjectSourceFile | null {
  return files.find((file) => file.assetIds?.includes(assetId)) ?? null;
}
