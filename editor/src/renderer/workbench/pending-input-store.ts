import { create } from 'zustand';
import type { JsonPointer } from '@/project/json-pointer';
import type { SaveUnitId } from '@/project/save-unit-types';
import type {
  EditorPendingRawInput,
  EditorRecoveryState,
} from '../../shared/project-schema/editor-project-state';
import {
  collectProjectValidationDiagnostics,
  createProjectValidationDiagnostic,
  type ProjectValidationDiagnostic,
} from '../../shared/project-schema/project-validation';

export type PendingInputEntries = Record<SaveUnitId, Record<JsonPointer, EditorPendingRawInput>>;

interface PendingInputStoreState {
  entriesBySaveUnitId: PendingInputEntries;
  setPendingInput: (
    saveUnitId: SaveUnitId,
    path: JsonPointer,
    input: EditorPendingRawInput,
  ) => void;
  clearPendingInput: (saveUnitId: SaveUnitId, path: JsonPointer) => void;
  clearPendingInputsForSaveUnit: (saveUnitId: SaveUnitId) => void;
  hydratePendingInputs: (recovery: EditorRecoveryState) => void;
  resetPendingInputs: () => void;
}

function cloneEntries(entries: PendingInputEntries): PendingInputEntries {
  return Object.fromEntries(
    Object.entries(entries).map(([saveUnitId, byPath]) => [
      saveUnitId,
      Object.fromEntries(Object.entries(byPath).map(([path, input]) => [path, { ...input }])),
    ]),
  );
}

export const usePendingInputStore = create<PendingInputStoreState>()((set) => ({
  entriesBySaveUnitId: {},
  setPendingInput: (saveUnitId, path, input) =>
    set((state) => ({
      entriesBySaveUnitId: {
        ...state.entriesBySaveUnitId,
        [saveUnitId]: {
          ...state.entriesBySaveUnitId[saveUnitId],
          [path]: { ...input },
        },
      },
    })),
  clearPendingInput: (saveUnitId, path) =>
    set((state) => {
      const existing = state.entriesBySaveUnitId[saveUnitId];
      if (!existing?.[path]) return state;
      const nextForUnit = { ...existing };
      delete nextForUnit[path];
      const entriesBySaveUnitId = { ...state.entriesBySaveUnitId };
      if (Object.keys(nextForUnit).length === 0) delete entriesBySaveUnitId[saveUnitId];
      else entriesBySaveUnitId[saveUnitId] = nextForUnit;
      return { entriesBySaveUnitId };
    }),
  clearPendingInputsForSaveUnit: (saveUnitId) =>
    set((state) => {
      if (!state.entriesBySaveUnitId[saveUnitId]) return state;
      const entriesBySaveUnitId = { ...state.entriesBySaveUnitId };
      delete entriesBySaveUnitId[saveUnitId];
      return { entriesBySaveUnitId };
    }),
  hydratePendingInputs: (recovery) =>
    set((state) => {
      const entriesBySaveUnitId = Object.fromEntries(
        Object.entries(recovery.saveUnitsById)
          .filter(([, entry]) => Object.keys(entry.pendingRawInputByPath).length > 0)
          .map(([saveUnitId, entry]) => [
            saveUnitId,
            Object.fromEntries(
              Object.entries(entry.pendingRawInputByPath).map(([path, input]) => [
                path,
                { ...input },
              ]),
            ),
          ]),
      );
      return JSON.stringify(entriesBySaveUnitId) === JSON.stringify(state.entriesBySaveUnitId)
        ? state
        : { entriesBySaveUnitId };
    }),
  resetPendingInputs: () => set({ entriesBySaveUnitId: {} }),
}));

export function selectPendingInput(
  state: Pick<PendingInputStoreState, 'entriesBySaveUnitId'>,
  saveUnitId: SaveUnitId,
  path: JsonPointer,
): EditorPendingRawInput | undefined {
  return state.entriesBySaveUnitId[saveUnitId]?.[path];
}

export function selectPendingSaveUnitIds(
  state: Pick<PendingInputStoreState, 'entriesBySaveUnitId'>,
): Set<SaveUnitId> {
  return new Set(
    Object.entries(state.entriesBySaveUnitId)
      .filter(([, byPath]) => Object.keys(byPath).length > 0)
      .map(([saveUnitId]) => saveUnitId),
  );
}

export function serializePendingInputs(
  state: Pick<PendingInputStoreState, 'entriesBySaveUnitId'>,
): PendingInputEntries {
  return cloneEntries(state.entriesBySaveUnitId);
}

function pendingInputMessage(path: JsonPointer): string {
  if (
    path.endsWith('/width') ||
    path.endsWith('/height') ||
    path.endsWith('/buildNumber') ||
    path.endsWith('/durationMs') ||
    path.endsWith('/versionCode')
  )
    return 'Enter a complete numeric value.';
  return 'Enter a complete value.';
}

export function collectPendingInputDiagnostics(
  state: Pick<PendingInputStoreState, 'entriesBySaveUnitId'>,
): ProjectValidationDiagnostic[] {
  return collectProjectValidationDiagnostics(
    Object.values(state.entriesBySaveUnitId).flatMap((byPath) =>
      Object.entries(byPath).map(([path, input]) =>
        createProjectValidationDiagnostic({
          code: input.diagnosticCode ?? 'editor.pending-input.invalid',
          severity: 'error',
          category: 'Project validation',
          path,
          message: pendingInputMessage(path),
          boundaries: ['authoring'],
          ownerPaths: [path],
        }),
      ),
    ),
  );
}
