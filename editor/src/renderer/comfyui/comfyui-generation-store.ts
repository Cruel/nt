import { create } from 'zustand';
import type { ImportedAssetMetadata } from '../../shared/asset-import';
import type { ComfyUiWorkflowId } from '../../shared/comfyui-workflows';

export interface GeneratedImageRevision {
  id: string;
  assetId?: string;
  assetAddedAt?: string;
  deletedAt?: string;
  asset: ImportedAssetMetadata;
  promptId?: string;
  workflowId: ComfyUiWorkflowId;
  mode: 'generate' | 'edit';
  prompt: string;
  seed?: number;
  projectRelativePath: string;
  previewUrl: string;
  absolutePath?: string;
  createdAt: string;
}

interface ComfyUiGenerationStore {
  revisionsByTabId: Record<string, GeneratedImageRevision[]>;
  selectedRevisionByTabId: Record<string, string | null>;
  appendRevisions: (tabId: string, revisions: GeneratedImageRevision[]) => void;
  selectRevision: (tabId: string, revisionId: string | null) => void;
  markRevisionAssetAdded: (tabId: string, revisionId: string, assetId?: string) => void;
  deleteRevision: (tabId: string, revisionId: string) => void;
  clearTab: (tabId: string) => void;
  clearProjectSession: () => void;
}

export const useComfyUiGenerationStore = create<ComfyUiGenerationStore>()((set) => ({
  revisionsByTabId: {},
  selectedRevisionByTabId: {},
  appendRevisions: (tabId, revisions) => set((state) => ({
    revisionsByTabId: {
      ...state.revisionsByTabId,
      [tabId]: [...(state.revisionsByTabId[tabId] ?? []), ...revisions],
    },
    selectedRevisionByTabId: {
      ...state.selectedRevisionByTabId,
      [tabId]: revisions.at(-1)?.id ?? state.selectedRevisionByTabId[tabId] ?? null,
    },
  })),
  selectRevision: (tabId, revisionId) => set((state) => ({
    selectedRevisionByTabId: { ...state.selectedRevisionByTabId, [tabId]: revisionId },
  })),
  markRevisionAssetAdded: (tabId, revisionId, assetId) => set((state) => {
    const revisions = state.revisionsByTabId[tabId] ?? [];
    return {
      revisionsByTabId: {
        ...state.revisionsByTabId,
        [tabId]: revisions.map((revision) => revision.id === revisionId
          ? { ...revision, assetId, assetAddedAt: new Date().toISOString() }
          : revision),
      },
      selectedRevisionByTabId: state.selectedRevisionByTabId,
    };
  }),
  deleteRevision: (tabId, revisionId) => set((state) => {
    const revisions = state.revisionsByTabId[tabId] ?? [];
    const nextRevisions = revisions.filter((revision) => revision.id !== revisionId);
    const selected = state.selectedRevisionByTabId[tabId];
    return {
      revisionsByTabId: {
        ...state.revisionsByTabId,
        [tabId]: nextRevisions,
      },
      selectedRevisionByTabId: {
        ...state.selectedRevisionByTabId,
        [tabId]: selected === revisionId ? nextRevisions.at(-1)?.id ?? null : selected ?? null,
      },
    };
  }),
  clearTab: (tabId) => set((state) => {
    const { [tabId]: _removedRevisions, ...revisionsByTabId } = state.revisionsByTabId;
    const { [tabId]: _removedSelection, ...selectedRevisionByTabId } = state.selectedRevisionByTabId;
    return { revisionsByTabId, selectedRevisionByTabId };
  }),
  clearProjectSession: () => set({ revisionsByTabId: {}, selectedRevisionByTabId: {} }),
}));
