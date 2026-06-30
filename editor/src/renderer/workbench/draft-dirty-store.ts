import { useEffect, useRef } from 'react';
import { create } from 'zustand';

export type DraftDirtyAction = () => boolean | Promise<boolean> | void | Promise<void>;

export interface DraftDirtyEntry {
  key: string;
  tabId: string;
  dirty: boolean;
  label?: string;
  apply?: DraftDirtyAction;
  discard?: DraftDirtyAction;
}

interface DraftDirtyStoreState {
  entriesByKey: Record<string, DraftDirtyEntry>;
  setDraftDirty: (key: string, entry: Omit<DraftDirtyEntry, 'key'>) => void;
  clearDraftDirty: (key: string) => void;
  clearDraftDirtyForTab: (tabId: string) => void;
  resetDraftDirty: () => void;
}

export const useDraftDirtyStore = create<DraftDirtyStoreState>()((set) => ({
  entriesByKey: {},
  setDraftDirty: (key, entry) => set((state) => {
    const existing = state.entriesByKey[key];
    if (!entry.dirty) {
      if (!existing) return state;
      const rest = { ...state.entriesByKey };
      delete rest[key];
      return { entriesByKey: rest };
    }
    if (
      existing &&
      existing.tabId === entry.tabId &&
      existing.dirty === true &&
      existing.label === entry.label &&
      existing.apply === entry.apply &&
      existing.discard === entry.discard
    ) {
      return state;
    }
    return {
      entriesByKey: {
        ...state.entriesByKey,
        [key]: { key, ...entry, dirty: true },
      },
    };
  }),
  clearDraftDirty: (key) => set((state) => {
    if (!state.entriesByKey[key]) return state;
    const rest = { ...state.entriesByKey };
    delete rest[key];
    return { entriesByKey: rest };
  }),
  clearDraftDirtyForTab: (tabId) => set((state) => {
    let removed = false;
    const entriesByKey = Object.fromEntries(
      Object.entries(state.entriesByKey).filter(([, entry]) => {
        const keep = entry.tabId !== tabId;
        if (!keep) removed = true;
        return keep;
      }),
    );
    return removed ? { entriesByKey } : state;
  }),
  resetDraftDirty: () => set({ entriesByKey: {} }),
}));

export function selectDraftDirtyByTabId(state: Pick<DraftDirtyStoreState, 'entriesByKey'>): Record<string, boolean> {
  const dirtyByTabId: Record<string, boolean> = {};
  for (const entry of Object.values(state.entriesByKey)) {
    if (entry.dirty) dirtyByTabId[entry.tabId] = true;
  }
  return dirtyByTabId;
}

export function selectDraftEntriesForTab(
  state: Pick<DraftDirtyStoreState, 'entriesByKey'>,
  tabId: string,
): DraftDirtyEntry[] {
  return Object.values(state.entriesByKey).filter((entry) => entry.tabId === tabId && entry.dirty);
}

export async function runDraftActions(entries: DraftDirtyEntry[], action: 'apply' | 'discard'): Promise<boolean> {
  for (const entry of entries) {
    const handler = entry[action];
    if (!handler) return false;
    const result = await handler();
    if (result === false) return false;
  }
  return true;
}

export interface EditorDraftDirtyOptions {
  key?: string;
  label?: string;
  apply?: DraftDirtyAction;
  discard?: DraftDirtyAction;
}

export function useEditorDraftDirty(tabId: string | undefined, dirty: boolean, options: EditorDraftDirtyOptions = {}) {
  const setDraftDirty = useDraftDirtyStore((state) => state.setDraftDirty);
  const clearDraftDirty = useDraftDirtyStore((state) => state.clearDraftDirty);
  const key = options.key ?? tabId;
  const actionsRef = useRef<Pick<EditorDraftDirtyOptions, 'apply' | 'discard'>>({});
  const applyWrapperRef = useRef<DraftDirtyAction>(() => actionsRef.current.apply?.());
  const discardWrapperRef = useRef<DraftDirtyAction>(() => actionsRef.current.discard?.());
  actionsRef.current.apply = options.apply;
  actionsRef.current.discard = options.discard;
  const hasApply = typeof options.apply === 'function';
  const hasDiscard = typeof options.discard === 'function';

  useEffect(() => {
    if (!tabId || !key) return undefined;
    setDraftDirty(key, {
      tabId,
      dirty,
      label: options.label,
      apply: hasApply ? applyWrapperRef.current : undefined,
      discard: hasDiscard ? discardWrapperRef.current : undefined,
    });
    return () => clearDraftDirty(key);
  }, [clearDraftDirty, dirty, hasApply, hasDiscard, key, options.label, setDraftDirty, tabId]);
}
