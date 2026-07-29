import { create } from 'zustand';
import type { EditorPreviewSplitOrientation } from '@/components/editor-preview-layout';

interface EditorPreviewSplitSyncState {
  sizes: Record<EditorPreviewSplitOrientation, number | null>;
  sourceIds: Record<EditorPreviewSplitOrientation, string | null>;
  setSize: (orientation: EditorPreviewSplitOrientation, size: number, sourceId?: string) => void;
}

const SYNC_EPSILON = 0.01;

export const DEFAULT_EDITOR_PREVIEW_SPLIT_SYNC_SIZES: EditorPreviewSplitSyncState['sizes'] = {
  vertical: null,
  horizontal: null,
};

export const DEFAULT_EDITOR_PREVIEW_SPLIT_SYNC_SOURCE_IDS: EditorPreviewSplitSyncState['sourceIds'] =
  {
    vertical: null,
    horizontal: null,
  };

export const useEditorPreviewSplitSyncStore = create<EditorPreviewSplitSyncState>((set) => ({
  sizes: DEFAULT_EDITOR_PREVIEW_SPLIT_SYNC_SIZES,
  sourceIds: DEFAULT_EDITOR_PREVIEW_SPLIT_SYNC_SOURCE_IDS,
  setSize: (orientation, size, sourceId) =>
    set((state) => {
      const current = state.sizes[orientation];
      if (current !== null && Math.abs(current - size) <= SYNC_EPSILON) return state;
      return {
        sizes: {
          ...state.sizes,
          [orientation]: size,
        },
        sourceIds: {
          ...state.sourceIds,
          [orientation]: sourceId ?? null,
        },
      };
    }),
}));
