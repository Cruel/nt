import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { JsonValue } from '@/project/json-value';
import type { SerializedEditorDraftState } from '../../shared/project-schema/editor-project-state';

export type DraftDirtyAction = () => boolean | Promise<boolean> | void | Promise<void>;

export interface DraftDirtyEntry {
  key: string;
  tabId: string;
  dirty: boolean;
  label?: string;
  schema?: string;
  schemaVersion?: number;
  payload?: JsonValue;
  apply?: DraftDirtyAction;
  discard?: DraftDirtyAction;
}

interface DraftDirtyStoreState {
  entriesByKey: Record<string, DraftDirtyEntry>;
  setDraftDirty: (key: string, entry: Omit<DraftDirtyEntry, 'key'>) => void;
  restoreSerializedDrafts: (draftsByKey: Record<string, SerializedEditorDraftState>) => void;
  clearDraftDirty: (key: string) => void;
  clearDraftDirtyForTab: (tabId: string) => void;
  resetDraftDirty: () => void;
}

function jsonPayloadEqual(left: JsonValue | undefined, right: JsonValue | undefined) {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

export const useDraftDirtyStore = create<DraftDirtyStoreState>()((set) => ({
  entriesByKey: {},
  setDraftDirty: (key, entry) =>
    set((state) => {
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
        existing.schema === entry.schema &&
        existing.schemaVersion === entry.schemaVersion &&
        jsonPayloadEqual(existing.payload, entry.payload) &&
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
  restoreSerializedDrafts: (draftsByKey) =>
    set({
      entriesByKey: Object.fromEntries(
        Object.entries(draftsByKey).map(([key, draft]) => [
          key,
          {
            key,
            tabId: draft.tabId,
            dirty: true,
            label: draft.label,
            schema: draft.schema,
            schemaVersion: draft.schemaVersion,
            payload: draft.payload as JsonValue,
          } satisfies DraftDirtyEntry,
        ]),
      ),
    }),
  clearDraftDirty: (key) =>
    set((state) => {
      if (!state.entriesByKey[key]) return state;
      const rest = { ...state.entriesByKey };
      delete rest[key];
      return { entriesByKey: rest };
    }),
  clearDraftDirtyForTab: (tabId) =>
    set((state) => {
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

export function selectDraftDirtyByTabId(
  state: Pick<DraftDirtyStoreState, 'entriesByKey'>,
): Record<string, boolean> {
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

export function serializeDraftDirtyState(
  state: Pick<DraftDirtyStoreState, 'entriesByKey'>,
): Record<string, SerializedEditorDraftState> {
  return Object.fromEntries(
    Object.entries(state.entriesByKey)
      .filter(
        ([, entry]) =>
          entry.dirty && entry.schema && entry.schemaVersion && entry.payload !== undefined,
      )
      .map(([key, entry]) => [
        key,
        {
          schema: entry.schema!,
          schemaVersion: entry.schemaVersion!,
          tabId: entry.tabId,
          label: entry.label,
          payload: entry.payload,
        } satisfies SerializedEditorDraftState,
      ]),
  );
}

export async function runDraftActions(
  entries: DraftDirtyEntry[],
  action: 'apply' | 'discard',
): Promise<boolean> {
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
  schema?: string;
  schemaVersion?: number;
  payload?: JsonValue;
  apply?: DraftDirtyAction;
  discard?: DraftDirtyAction;
  preserveOnUnmount?: boolean;
}

export function restoredDraftPayload<T extends JsonValue>(
  key: string,
  schema: string,
): T | undefined {
  const entry = useDraftDirtyStore.getState().entriesByKey[key];
  return entry?.schema === schema ? (entry.payload as T | undefined) : undefined;
}

export function useEditorDraftDirty(
  tabId: string | undefined,
  dirty: boolean,
  options: EditorDraftDirtyOptions = {},
) {
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
  const preserveOnUnmount = options.preserveOnUnmount === true;

  useEffect(() => {
    if (!tabId || !key) return undefined;
    setDraftDirty(key, {
      tabId,
      dirty,
      label: options.label,
      schema: options.schema,
      schemaVersion: options.schemaVersion,
      payload: options.payload,
      apply: hasApply ? applyWrapperRef.current : undefined,
      discard: hasDiscard ? discardWrapperRef.current : undefined,
    });
    return () => {
      if (preserveOnUnmount && dirty) {
        setDraftDirty(key, {
          tabId,
          dirty: true,
          label: options.label,
          schema: options.schema,
          schemaVersion: options.schemaVersion,
          payload: options.payload,
        });
        return;
      }
      clearDraftDirty(key);
    };
  }, [
    clearDraftDirty,
    dirty,
    hasApply,
    hasDiscard,
    key,
    options.label,
    options.payload,
    preserveOnUnmount,
    options.schema,
    options.schemaVersion,
    setDraftDirty,
    tabId,
  ]);
}
