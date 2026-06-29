import { create } from 'zustand';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import type { ReferenceTarget } from '../../shared/project-schema/authoring-project';
import type { ReferenceUsage } from '../../shared/project-schema/authoring-references';

export interface EntityUsagesResult {
  target: ReferenceTarget;
  usages: ReferenceUsage[];
  requestedAt: number;
}

interface EntityUsagesStore {
  result: EntityUsagesResult | null;
  setUsages: (target: ReferenceTarget, usages: ReferenceUsage[]) => void;
  clearUsages: () => void;
}

export const useEntityUsagesStore = create<EntityUsagesStore>()((set) => ({
  result: null,
  setUsages: (target, usages) => set({ result: { target, usages, requestedAt: Date.now() } }),
  clearUsages: () => set({ result: null }),
}));

export function usageSourceIsRecord(sourceCollection: AuthoringCollectionKey | 'project'): sourceCollection is AuthoringCollectionKey {
  return sourceCollection !== 'project';
}
