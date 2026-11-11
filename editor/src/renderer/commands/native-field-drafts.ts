import { create } from 'zustand';
import { useProjectStore } from '@/project/project-store';
import { getJsonAtPointer, hasJsonAtPointer } from '@/project/json-pointer';
import { jsonValuesEqual, type JsonValue } from '@/project/json-value';
import { editorI18n } from '@/i18n';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { resolveSaveUnitForTab } from '@/project/save-unit-registry';
import type { CommandExecutionResult } from './command-types';
import { measureProjectEdit } from './project-edit-timings';

// Only presentation and pending intent live here. Native ProjectSession and its
// acknowledged command history remain the sole source of saved/dirty truth.
export interface NativeFieldDraft {
  projectSessionId: string;
  projectInstanceId: string;
  saveUnitId: string;
  path: string;
  value: JsonValue;
  sequence: number;
  error: string | null;
  inputStartedAt: number;
  /** A narrow acknowledged baseline, not a copy of the whole Project. */
  base: NativeFieldBase;
}

interface NativeFieldBase {
  revision: number;
  exists: boolean;
  value?: JsonValue;
}

interface NativeFieldDraftState {
  entries: Record<string, NativeFieldDraft>;
}

export const useNativeFieldDraftStore = create<NativeFieldDraftState>()(() => ({ entries: {} }));
export const NATIVE_FIELD_DRAFT_SCHEMA = 'noveltea.editor.draft.native-field.v1';

// The queue evaluates this getter only when the command is actually planned,
// not when its place in the queue is reserved.
type SubmitField = (latestAtDispatch: () => JsonValue) => Promise<CommandExecutionResult>;
interface ScheduledField {
  submit: SubmitField;
  timer: ReturnType<typeof setTimeout> | null;
  firstEditAt: number;
  inFlight: Promise<boolean> | null;
  dispatched: boolean;
  discardRequested: boolean;
}

const scheduled = new Map<string, ScheduledField>();
const TRAILING_MS = 150;
const MAX_WAIT_MS = 500;

export function nativeFieldKey(projectSessionId: string, projectInstanceId: string, path: string) {
  return JSON.stringify([projectSessionId, projectInstanceId, path]);
}

/** A field belongs to its Save unit, not to an individual open tab. */
export function nativeFieldDraftKey(saveUnitId: string, path: string) {
  return `native-field:${JSON.stringify([saveUnitId, path])}`;
}

function sameProject(
  entry: Pick<NativeFieldDraft, 'projectSessionId' | 'projectInstanceId'>,
): boolean {
  const project = useProjectStore.getState();
  return (
    project.projectSessionId === entry.projectSessionId &&
    project.projectInstanceId === entry.projectInstanceId
  );
}

function fieldBase(path: string): NativeFieldBase {
  const project = useProjectStore.getState();
  const exists = Boolean(project.document && hasJsonAtPointer(project.document, path));
  return {
    revision: project.projectRevision,
    exists,
    ...(exists && project.document ? { value: getJsonAtPointer(project.document, path) } : {}),
  };
}

function fieldBaseMatches(base: NativeFieldBase, next: NativeFieldBase): boolean {
  // Revision changes caused by *disjoint* edits are safe to rebase. A changed
  // value at this very path is not, regardless of its document revision.
  return base.exists === next.exists && (!base.exists || jsonValuesEqual(base.value, next.value));
}

function clearEntry(key: string, sequence?: number) {
  const entry = useNativeFieldDraftStore.getState().entries[key];
  if (!entry || (sequence !== undefined && entry.sequence !== sequence)) return;
  // Remove the serialized draft in the same transition as the acknowledged
  // overlay, so a remount cannot replay a value that was just committed.
  useDraftDirtyStore.getState().clearDraftDirty(nativeFieldDraftKey(entry.saveUnitId, entry.path));
  useNativeFieldDraftStore.setState((state) => {
    const current = state.entries[key];
    if (!current || (sequence !== undefined && current.sequence !== sequence)) return state;
    const entries = { ...state.entries };
    delete entries[key];
    return { entries };
  });
}

function schedule(key: string, field: ScheduledField) {
  if (field.timer) clearTimeout(field.timer);
  const elapsed = Date.now() - field.firstEditAt;
  const delay = Math.max(0, Math.min(TRAILING_MS, MAX_WAIT_MS - elapsed));
  field.timer = setTimeout(() => {
    field.timer = null;
    void flushNativeField(key);
  }, delay);
}

/** Synchronous, field-granular overlay publication. No Project clone or IPC. */
export function stageNativeField(
  input: Omit<NativeFieldDraft, 'sequence' | 'error' | 'inputStartedAt' | 'base'>,
  submit: SubmitField,
) {
  const key = nativeFieldKey(input.projectSessionId, input.projectInstanceId, input.path);
  if (!sameProject(input)) return;
  const existing = useNativeFieldDraftStore.getState().entries[key];
  if (existing && jsonValuesEqual(existing.value, input.value) && !existing.error) return;
  useNativeFieldDraftStore.setState((state) => ({
    entries: {
      ...state.entries,
      [key]: {
        ...input,
        base: state.entries[key]?.base ?? fieldBase(input.path),
        sequence: (state.entries[key]?.sequence ?? 0) + 1,
        error: null,
        inputStartedAt: performance.now(),
      },
    },
  }));
  let field = scheduled.get(key);
  if (!field) {
    field = {
      submit,
      timer: null,
      firstEditAt: Date.now(),
      inFlight: null,
      dispatched: false,
      discardRequested: false,
    };
    scheduled.set(key, field);
  }
  field.submit = submit;
  if (!field.inFlight) schedule(key, field);
}

/** Never claim that an already dispatched native edit has been discarded.
 * Its owner must await acknowledgment and perform an authoritative discard. */
export async function discardNativeField(key: string): Promise<boolean> {
  const field = scheduled.get(key);
  if (field?.timer) clearTimeout(field.timer);
  if (!field) {
    clearEntry(key);
    return true;
  }
  field.timer = null;
  if (field.inFlight) {
    if (field.dispatched) return false;
    const sequenceAtDiscard = useNativeFieldDraftStore.getState().entries[key]?.sequence;
    field.discardRequested = true;
    await field.inFlight;
    if (field.dispatched) return false;
    const next = useNativeFieldDraftStore.getState().entries[key];
    if (next && next.sequence !== sequenceAtDiscard) {
      // A new edit arrived during cancellation. Retain it as a fresh pending
      // generation rather than letting an older close/discard erase it.
      field.discardRequested = false;
      field.firstEditAt = Date.now();
      scheduled.set(key, field);
      schedule(key, field);
      return false;
    }
  }
  scheduled.delete(key);
  clearEntry(key);
  return true;
}

export function flushNativeField(key: string): Promise<boolean> {
  const field = scheduled.get(key);
  if (!field) return Promise.resolve(!useNativeFieldDraftStore.getState().entries[key]);
  if (field.timer) clearTimeout(field.timer);
  field.timer = null;
  if (field.inFlight) return field.inFlight;
  const run = async () => {
    while (true) {
      const entry = useNativeFieldDraftStore.getState().entries[key];
      if (!entry || field.discardRequested) return !entry;
      if (!sameProject(entry)) return false;
      let result: CommandExecutionResult;
      let dispatchedSequence: number | undefined;
      const nativeStartedAt = performance.now();
      try {
        result = await field.submit(() => {
          if (field.discardRequested) throw new Error('This field edit was discarded.');
          const current = useNativeFieldDraftStore.getState().entries[key];
          if (!current || !sameProject(current))
            throw new Error('This field edit no longer belongs to the active Project.');
          if (!fieldBaseMatches(current.base, fieldBase(current.path)))
            throw new Error(editorI18n.t('projectField.conflict', { ns: 'workspace' }));
          dispatchedSequence = current.sequence;
          field.dispatched = true;
          return current.value;
        });
      } catch (error) {
        result = {
          ok: false,
          projectChanged: false,
          diagnostics: [{ severity: 'error', message: String(error) }],
        };
      }
      if (!sameProject(entry)) return false;
      if (field.discardRequested && dispatchedSequence === undefined) return false;
      measureProjectEdit('flush-to-native-ack', nativeStartedAt, {
        path: entry.path,
        sequence: entry.sequence,
        ok: result.ok,
      });
      if (!result.ok) {
        const message = result.diagnostics[0]?.message ?? 'Native field edit was rejected.';
        useNativeFieldDraftStore.setState((state) => {
          const current = state.entries[key];
          return current
            ? { entries: { ...state.entries, [key]: { ...current, error: message } } }
            : state;
        });
        return false;
      }
      clearEntry(key, dispatchedSequence);
      const newer = useNativeFieldDraftStore.getState().entries[key];
      if (newer && dispatchedSequence !== undefined && newer.sequence !== dispatchedSequence) {
        // Our own accepted command is now the baseline for the next unsent
        // intent in this same typing session.
        useNativeFieldDraftStore.setState((state) => {
          const current = state.entries[key];
          if (!current || current.sequence === dispatchedSequence) return state;
          return {
            entries: { ...state.entries, [key]: { ...current, base: fieldBase(current.path) } },
          };
        });
      }
      // Typing during an acknowledgment remains visible, and only the latest
      // subsequently typed value is sent, against the newly confirmed revision.
    }
  };
  field.inFlight = run().finally(() => {
    field.inFlight = null;
    field.dispatched = false;
    const pending = useNativeFieldDraftStore.getState().entries[key];
    if (!pending || field.discardRequested) scheduled.delete(key);
    else if (!pending.error) {
      field.firstEditAt = Date.now();
      schedule(key, field);
    }
  });
  return field.inFlight;
}

/** Save/Undo/dependent-command barrier, filtered by logical Save unit when supplied. */
export async function flushNativeFields(saveUnitId?: string): Promise<boolean> {
  // A new field can be edited while the first native acknowledgment is in
  // flight. Repeat until the selected logical units have no staged intents.
  for (;;) {
    const entries = Object.entries(useNativeFieldDraftStore.getState().entries).filter(
      ([, entry]) => (!saveUnitId || entry.saveUnitId === saveUnitId) && sameProject(entry),
    );
    if (entries.length === 0) return true;
    const results = await Promise.all(entries.map(([key]) => flushNativeField(key)));
    if (!results.every(Boolean)) return false;
  }
}

useProjectStore.subscribe((state, previous) => {
  if (
    state.projectSessionId === previous.projectSessionId &&
    state.projectInstanceId === previous.projectInstanceId
  )
    return;
  for (const [key, field] of scheduled) {
    if (field.timer) clearTimeout(field.timer);
    scheduled.delete(key);
  }
  useNativeFieldDraftStore.setState({ entries: {} });
});

// Tab lifetime is not field lifetime. When any view closes (including through
// workbench operations outside the close dialog), move the single serialized
// owner's tab reference to a surviving view of the same Save unit. Never
// discard an edit merely because its original view disappeared.
useWorkbenchStore.subscribe((state) => {
  const drafts = useDraftDirtyStore.getState();
  for (const [key, entry] of Object.entries(drafts.entriesByKey)) {
    if (entry.schema !== NATIVE_FIELD_DRAFT_SCHEMA || state.tabsById[entry.tabId]) continue;
    const nextView = Object.values(state.tabsById).find((tab) => {
      const resolution = resolveSaveUnitForTab(tab, useProjectStore.getState().document);
      return (
        resolution.status === 'savable' &&
        key.startsWith(`native-field:[${JSON.stringify(resolution.descriptor.id)},`)
      );
    });
    if (nextView) drafts.setDraftDirty(key, { ...entry, tabId: nextView.id });
  }
});
