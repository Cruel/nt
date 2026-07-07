import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import type { SerializedEditorTabState } from '../../shared/project-schema/editor-project-state';

export type WorkbenchTabStatePayload = SerializedEditorTabState;

export interface WorkbenchEditorTabStateHandle<TTabState extends WorkbenchTabStatePayload = WorkbenchTabStatePayload> {
  captureTabState(): TTabState | null | undefined;
  restoreTabState(state: TTabState): void | Promise<void>;
}

export interface ScrollViewState {
  scrollTop: number;
  scrollLeft: number;
}

export interface SplitterViewState {
  sizes: number[];
}

export interface TreeExpansionState {
  expandedIds: string[];
}

export interface GraphViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface GraphSelectionState {
  selectedIds: string[];
}

export interface SourceEditorViewState {
  scroll?: ScrollViewState;
  selection?: unknown;
}

export type SourceEditorViewStates = Record<string, SourceEditorViewState>;

export interface SourceEditorViewStateHandle {
  captureViewState(): SourceEditorViewState;
  restoreViewState(state: SourceEditorViewState | null | undefined): void;
}

export function isScrollViewState(value: unknown): value is ScrollViewState {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as ScrollViewState).scrollTop === 'number'
    && Number.isFinite((value as ScrollViewState).scrollTop)
    && typeof (value as ScrollViewState).scrollLeft === 'number'
    && Number.isFinite((value as ScrollViewState).scrollLeft);
}

export function isSplitterViewState(value: unknown): value is SplitterViewState {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Array.isArray((value as SplitterViewState).sizes)
    && (value as SplitterViewState).sizes.every((size) => typeof size === 'number' && Number.isFinite(size));
}

export function isTreeExpansionState(value: unknown): value is TreeExpansionState {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Array.isArray((value as TreeExpansionState).expandedIds)
    && (value as TreeExpansionState).expandedIds.every((id) => typeof id === 'string');
}

export function isGraphViewportState(value: unknown): value is GraphViewportState {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as GraphViewportState).x === 'number'
    && Number.isFinite((value as GraphViewportState).x)
    && typeof (value as GraphViewportState).y === 'number'
    && Number.isFinite((value as GraphViewportState).y)
    && typeof (value as GraphViewportState).zoom === 'number'
    && Number.isFinite((value as GraphViewportState).zoom);
}

export function isGraphSelectionState(value: unknown): value is GraphSelectionState {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Array.isArray((value as GraphSelectionState).selectedIds)
    && (value as GraphSelectionState).selectedIds.every((id) => typeof id === 'string');
}

export function isSourceEditorViewState(value: unknown): value is SourceEditorViewState {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (!('scroll' in value) || isScrollViewState((value as SourceEditorViewState).scroll));
}

export function parseSourceEditorViewStates(value: unknown): SourceEditorViewStates | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, SourceEditorViewState] => typeof entry[0] === 'string' && isSourceEditorViewState(entry[1])),
  );
}

export function captureSourceEditorViewStates<T extends string>(handles: Partial<Record<T, SourceEditorViewStateHandle | null | undefined>>): SourceEditorViewStates {
  return Object.fromEntries(
    (Object.entries(handles) as Array<[string, SourceEditorViewStateHandle | null | undefined]>)
      .flatMap(([key, handle]) => handle ? [[key, handle.captureViewState()]] : []),
  );
}

export function restoreSourceEditorViewStates<T extends string>(
  handles: Partial<Record<T, SourceEditorViewStateHandle | null | undefined>>,
  states: Partial<Record<T, SourceEditorViewState>> | null | undefined,
): void {
  if (!states) return;
  for (const [key, state] of Object.entries(states) as Array<[T, SourceEditorViewState]>) {
    handles[key]?.restoreViewState(state);
  }
}

export function useSourceEditorViewStateRefs<T extends string>() {
  const refs = useRef<Partial<Record<T, SourceEditorViewStateHandle | null>>>({});
  const refFor = useCallback((key: T) => (handle: SourceEditorViewStateHandle | null) => {
    refs.current[key] = handle;
  }, []);
  return { refs, refFor };
}

interface WorkbenchTabStateStore {
  tabStatesById: Record<string, WorkbenchTabStatePayload>;
  setTabState: (tabId: string, state: WorkbenchTabStatePayload) => void;
  deleteTabState: (tabId: string) => void;
  clearTabStates: () => void;
  restoreSerializedTabStates: (statesById: Record<string, WorkbenchTabStatePayload>) => void;
  pruneTabStates: (tabIds: Iterable<string>) => void;
}

const handlesByTabId = new Map<string, WorkbenchEditorTabStateHandle>();

function cloneTabState(state: WorkbenchTabStatePayload): WorkbenchTabStatePayload {
  return {
    schema: state.schema,
    schemaVersion: state.schemaVersion,
    payload: state.payload === undefined ? undefined : toJsonValue(state.payload) as JsonValue,
  };
}

function restoreHandle(tabId: string, handle: WorkbenchEditorTabStateHandle, state: WorkbenchTabStatePayload | undefined): void {
  if (!state) return;
  void handle.restoreTabState(cloneTabState(state));
}

export const useWorkbenchTabStateStore = create<WorkbenchTabStateStore>()((set) => ({
  tabStatesById: {},
  setTabState: (tabId, state) => set((current) => ({
    tabStatesById: {
      ...current.tabStatesById,
      [tabId]: cloneTabState(state),
    },
  })),
  deleteTabState: (tabId) => set((current) => {
    if (!current.tabStatesById[tabId]) return current;
    const next = { ...current.tabStatesById };
    delete next[tabId];
    return { tabStatesById: next };
  }),
  clearTabStates: () => set({ tabStatesById: {} }),
  restoreSerializedTabStates: (statesById) => set({
    tabStatesById: Object.fromEntries(
      Object.entries(statesById).map(([tabId, state]) => [tabId, cloneTabState(state)]),
    ),
  }),
  pruneTabStates: (tabIds) => set((current) => {
    const keep = new Set(tabIds);
    const next = Object.fromEntries(Object.entries(current.tabStatesById).filter(([tabId]) => keep.has(tabId)));
    if (Object.keys(next).length === Object.keys(current.tabStatesById).length) return current;
    return { tabStatesById: next };
  }),
}));

export function captureScrollViewState(element: Element | null | undefined): ScrollViewState | undefined {
  if (!(element instanceof HTMLElement)) return undefined;
  return {
    scrollTop: element.scrollTop,
    scrollLeft: element.scrollLeft,
  };
}

export function restoreScrollViewState(element: Element | null | undefined, state: ScrollViewState | null | undefined): void {
  if (!(element instanceof HTMLElement) || !state) return;
  element.scrollTop = Number.isFinite(state.scrollTop) ? state.scrollTop : 0;
  element.scrollLeft = Number.isFinite(state.scrollLeft) ? state.scrollLeft : 0;
}

export function captureWorkbenchTabState(tabId: string): WorkbenchTabStatePayload | undefined {
  const handle = handlesByTabId.get(tabId);
  if (!handle) return useWorkbenchTabStateStore.getState().tabStatesById[tabId];
  const captured = handle.captureTabState();
  if (!captured) return useWorkbenchTabStateStore.getState().tabStatesById[tabId];
  useWorkbenchTabStateStore.getState().setTabState(tabId, captured);
  return useWorkbenchTabStateStore.getState().tabStatesById[tabId];
}

export function captureWorkbenchTabStates(tabIds: Iterable<string>): Record<string, WorkbenchTabStatePayload> {
  for (const tabId of tabIds) captureWorkbenchTabState(tabId);
  return serializeWorkbenchTabStates(tabIds);
}

export function restoreWorkbenchTabState(tabId: string): void {
  const handle = handlesByTabId.get(tabId);
  if (!handle) return;
  restoreHandle(tabId, handle, useWorkbenchTabStateStore.getState().tabStatesById[tabId]);
}

export function registerWorkbenchTabStateHandle<TTabState extends WorkbenchTabStatePayload>(
  tabId: string,
  handle: WorkbenchEditorTabStateHandle<TTabState>,
): () => void {
  handlesByTabId.set(tabId, handle as WorkbenchEditorTabStateHandle);
  restoreHandle(tabId, handle as WorkbenchEditorTabStateHandle, useWorkbenchTabStateStore.getState().tabStatesById[tabId]);
  return () => {
    if (handlesByTabId.get(tabId) === handle) handlesByTabId.delete(tabId);
  };
}

export function useWorkbenchEditorTabState<TTabState extends WorkbenchTabStatePayload>(
  tabId: string,
  handle: WorkbenchEditorTabStateHandle<TTabState>,
): void {
  useEffect(() => registerWorkbenchTabStateHandle(tabId, handle), [handle, tabId]);
}

export function setWorkbenchTabState(tabId: string, state: WorkbenchTabStatePayload): void {
  useWorkbenchTabStateStore.getState().setTabState(tabId, state);
}

export function deleteWorkbenchTabState(tabId: string): void {
  useWorkbenchTabStateStore.getState().deleteTabState(tabId);
}

export function clearWorkbenchTabStates(): void {
  handlesByTabId.clear();
  useWorkbenchTabStateStore.getState().clearTabStates();
}

export function restoreSerializedWorkbenchTabStates(statesById: Record<string, WorkbenchTabStatePayload>): void {
  useWorkbenchTabStateStore.getState().restoreSerializedTabStates(statesById);
  for (const [tabId, handle] of handlesByTabId) {
    restoreHandle(tabId, handle, statesById[tabId]);
  }
}

export function pruneWorkbenchTabStates(tabIds: Iterable<string>): void {
  useWorkbenchTabStateStore.getState().pruneTabStates(tabIds);
}

export function serializeWorkbenchTabStates(tabIds?: Iterable<string>): Record<string, WorkbenchTabStatePayload> {
  const states = useWorkbenchTabStateStore.getState().tabStatesById;
  const allowed = tabIds ? new Set(tabIds) : null;
  return Object.fromEntries(
    Object.entries(states)
      .filter(([tabId]) => !allowed || allowed.has(tabId))
      .map(([tabId, state]) => [tabId, cloneTabState(state)]),
  );
}
