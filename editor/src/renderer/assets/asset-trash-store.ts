import { create } from 'zustand';
import type { ProjectAssetTrashMove } from '../../shared/project-asset-audit';

interface DeletedAssetTrashEntry {
  assetId: string;
  projectFilePath: string;
  move: ProjectAssetTrashMove;
}

interface AssetTrashStore {
  deletedAssets: Record<string, DeletedAssetTrashEntry>;
  rememberDeletedAsset: (entry: DeletedAssetTrashEntry) => void;
  forgetDeletedAsset: (assetId: string) => void;
  clearProject: (projectFilePath: string | null) => void;
}

export const useAssetTrashStore = create<AssetTrashStore>()((set) => ({
  deletedAssets: {},
  rememberDeletedAsset: (entry) =>
    set((state) => ({
      deletedAssets: { ...state.deletedAssets, [entry.assetId]: entry },
    })),
  forgetDeletedAsset: (assetId) =>
    set((state) => {
      if (!state.deletedAssets[assetId]) return state;
      const { [assetId]: _removed, ...deletedAssets } = state.deletedAssets;
      return { deletedAssets };
    }),
  clearProject: (projectFilePath) =>
    set((state) => {
      if (!projectFilePath) return { deletedAssets: {} };
      const deletedAssets: Record<string, DeletedAssetTrashEntry> = {};
      for (const [assetId, entry] of Object.entries(state.deletedAssets)) {
        if (entry.projectFilePath !== projectFilePath) deletedAssets[assetId] = entry;
      }
      return { deletedAssets };
    }),
}));
