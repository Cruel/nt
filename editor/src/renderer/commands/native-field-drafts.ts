import { create } from 'zustand';
import { useProjectStore } from '@/project/project-store';
import { jsonValuesEqual, type JsonValue } from '@/project/json-value';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import type { CommandExecutionResult } from './command-types';

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
}

interface NativeFieldDraftState {
  entries: Record<string, NativeFieldDraft>;
}

export const useNativeFieldDraftStore = create<NativeFieldDraftState>()(() => ({ entries: {} }));
export const NATIVE_FIELD_DRAFT_SCHEMA = 'noveltea.editor.draft.native-field.v1';

type SubmitField = (value: JsonValue) => Promise<CommandExecutionResult>;
interface ScheduledField {
  submit: SubmitField;
  timer: ReturnType<typeof setTimeout> | null;
  firstEditAt: number;
  inFlight: Promise<boolean> | null;
}

const scheduled = new Map<string, ScheduledField>();
const TRAILING_MS = 150;
const MAX_WAIT_MS = 500;

export function nativeFieldKey(projectSessionId: string, projectInstanceId: string, path: string) {
  return JSON.stringify([projectSessionId, projectInstanceId, path]);
}

function sameProject(entry: NativeFieldDraft): boolean {
  const project = useProjectStore.getState();
  return (
    project.projectSessionId === entry.projectSessionId &&
    project.projectInstanceId === entry.projectInstanceId
  );
}

function clearEntry(key: string, sequence?: number) {
  const entry = useNativeFieldDraftStore.getState().entries[key];
  if (!entry || (sequence !== undefined && entry.sequence !== sequence)) return;
  // Remove the serialized draft in the same transition as the acknowledged
  // overlay, so a remount cannot replay a value that was just committed.
  const draftStore = useDraftDirtyStore.getState();
  for (const [draftKey, draft] of Object.entries(draftStore.entriesByKey)) {
    if (
      draft.schema === NATIVE_FIELD_DRAFT_SCHEMA &&
      draftKey.endsWith(`:native-field:${entry.path}`)
    )
      draftStore.clearDraftDirty(draftKey);
  }
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
  input: Omit<NativeFieldDraft, 'sequence' | 'error'>,
  submit: SubmitField,
) {
  const key = nativeFieldKey(input.projectSessionId, input.projectInstanceId, input.path);
  if (!sameProject({ ...input, sequence: 0, error: null })) return;
  const existing = useNativeFieldDraftStore.getState().entries[key];
  if (existing && jsonValuesEqual(existing.value, input.value) && !existing.error) return;
  useNativeFieldDraftStore.setState((state) => ({
    entries: {
      ...state.entries,
      [key]: { ...input, sequence: (state.entries[key]?.sequence ?? 0) + 1, error: null },
    },
  }));
  let field = scheduled.get(key);
  if (!field) {
    field = { submit, timer: null, firstEditAt: Date.now(), inFlight: null };
    scheduled.set(key, field);
  }
  field.submit = submit;
  if (!field.inFlight) schedule(key, field);
}

export function discardNativeField(key: string) {
  const field = scheduled.get(key);
  if (field?.timer) clearTimeout(field.timer);
  if (field) {
    field.timer = null;
    if (!field.inFlight) scheduled.delete(key);
  }
  clearEntry(key);
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
      if (!entry) return true;
      if (!sameProject(entry)) return false;
      let result: CommandExecutionResult;
      try {
        result = await field.submit(entry.value);
      } catch (error) {
        result = {
          ok: false,
          projectChanged: false,
          diagnostics: [{ severity: 'error', message: String(error) }],
        };
      }
      if (!sameProject(entry)) return false;
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
      clearEntry(key, entry.sequence);
      // Typing during an acknowledgment remains visible, and only the latest
      // subsequently typed value is sent, against the newly confirmed revision.
    }
  };
  field.inFlight = run().finally(() => {
    field.inFlight = null;
    const pending = useNativeFieldDraftStore.getState().entries[key];
    if (!pending) scheduled.delete(key);
    else if (!pending.error) {
      field.firstEditAt = Date.now();
      schedule(key, field);
    }
  });
  return field.inFlight;
}

/** Save/Undo/dependent-command barrier, filtered by logical Save unit when supplied. */
export async function flushNativeFields(saveUnitId?: string): Promise<boolean> {
  const entries = Object.entries(useNativeFieldDraftStore.getState().entries).filter(
    ([, entry]) => (!saveUnitId || entry.saveUnitId === saveUnitId) && sameProject(entry),
  );
  const results = await Promise.all(entries.map(([key]) => flushNativeField(key)));
  return results.every(Boolean);
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
