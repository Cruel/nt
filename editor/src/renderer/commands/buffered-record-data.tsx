import { useCallback, useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { buildJsonPointer, getJsonAtPointer, hasJsonAtPointer } from '@/project/json-pointer';
import type { CommandRequest } from './command-types';
import { jsonValuesEqual, type JsonValue } from '@/project/json-value';
import { useProjectStore } from '@/project/project-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import {
  NATIVE_FIELD_DRAFT_SCHEMA,
  nativeFieldDraftKey,
  nativeFieldKey,
  parseNativeFieldRecovery,
  useNativeFieldDraftStore,
} from './native-field-drafts';
import { projectEdits } from './project-editing';
import { mergeAuthoredValue } from './authored-record-fields';
import { nativeFieldJsonPatches } from './native-field-json-patches';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import { ProjectFieldError } from './use-project-field';

type RecordData = Record<string, unknown>;

interface BufferedRecordOptions<T extends object> {
  collection: string;
  id: string;
  tabId: string;
  data: T;
  /** Independently owned, stable top-level data fields. Never include source buffers. */
  fields: readonly (keyof T & string)[];
}

/** Presentation projection only: native ProjectSession remains the authority. */
export function useBufferedRecordData<T extends object>({
  collection,
  id,
  tabId,
  data,
  fields,
}: BufferedRecordOptions<T>) {
  const session = useProjectStore((state) => state.projectSessionId);
  const instance = useProjectStore((state) => state.projectInstanceId);
  const saveUnitId = recordSaveUnitId(collection, id);
  const fieldPath = useCallback(
    (field: string) => buildJsonPointer([collection, id, 'data', field]),
    [collection, id],
  );
  const paths = useMemo(() => fields.map(fieldPath), [fields, fieldPath]);
  const entries = useNativeFieldDraftStore(
    useShallow((state) =>
      paths.map((path) => state.entries[nativeFieldKey(session ?? '', instance ?? '', path)]),
    ),
  );
  const recovered = useDraftDirtyStore(
    useShallow((state) =>
      paths.map((path) => state.entriesByKey[nativeFieldDraftKey(saveUnitId, path)]),
    ),
  );
  const fieldCommand = useCallback(
    (path: string, label: string) =>
      (latest: JsonValue): CommandRequest => {
        const document = useProjectStore.getState().document;
        if (!document) throw new Error('The Project was closed before the edit.');
        if (!hasJsonAtPointer(document, path))
          return {
            type: 'project.addAtPath',
            label,
            payload: { path, value: latest },
            originSaveUnitId: saveUnitId,
            persistencePolicy: 'manual-save',
          };
        return {
          type: 'project.applyPatch',
          label,
          payload: nativeFieldJsonPatches(getJsonAtPointer(document, path), latest, path),
          originSaveUnitId: saveUnitId,
          persistencePolicy: 'manual-save',
        };
      },
    [saveUnitId],
  );

  const projected = useMemo(() => {
    const next: RecordData = { ...(data as RecordData) };
    for (const [index, field] of fields.entries()) {
      const entry = entries[index];
      const saved = recovered[index];
      const restored =
        saved?.schema === NATIVE_FIELD_DRAFT_SCHEMA
          ? parseNativeFieldRecovery(saved.payload)
          : null;
      if (entry || restored) next[field] = entry ? entry.value : restored!.value;
    }
    return next as T;
  }, [data, fields, entries, recovered]);

  useEffect(() => {
    if (!session || !instance) return;
    for (const [index, field] of fields.entries()) {
      const path = paths[index]!;
      if (entries[index]) continue;
      const saved = recovered[index];
      const restored =
        saved?.schema === NATIVE_FIELD_DRAFT_SCHEMA
          ? parseNativeFieldRecovery(saved.payload)
          : null;
      if (restored)
        projectEdits.field({
          tabId,
          saveUnitId,
          path,
          value: restored.value,
          restoredBase: restored.base,
          label: saved!.label ?? `Restore ${field}`,
          buildCommand: fieldCommand(path, saved!.label ?? `Restore ${field}`),
        });
    }
  }, [session, instance, tabId, fields, entries, recovered, saveUnitId, paths, fieldCommand]);

  function commit(next: T, label: string) {
    const changed = [...new Set([...Object.keys(projected), ...Object.keys(next)])].filter(
      (key) =>
        !jsonValuesEqual(
          (projected as RecordData)[key] as JsonValue | undefined,
          (next as RecordData)[key] as JsonValue | undefined,
        ),
    );
    if (changed.length === 0) return;
    if (
      changed.length === 1 &&
      fields.includes(changed[0] as keyof T & string) &&
      (next as RecordData)[changed[0]!] !== undefined
    ) {
      const field = changed[0]!;
      const path = fieldPath(field);
      const latestDraft =
        useNativeFieldDraftStore.getState().entries[
          nativeFieldKey(session ?? '', instance ?? '', path)
        ];
      const currentDocument = useProjectStore.getState().document;
      const acknowledgedValue =
        currentDocument && hasJsonAtPointer(currentDocument, path)
          ? getJsonAtPointer(currentDocument, path)
          : undefined;
      try {
        const merged = mergeAuthoredValue(
          (projected as RecordData)[field],
          (next as RecordData)[field],
          latestDraft?.value ?? acknowledgedValue,
        );
        const value = JSON.parse(JSON.stringify(merged)) as JsonValue;
        projectEdits.field({
          tabId,
          saveUnitId,
          path,
          value,
          label,
          buildCommand: fieldCommand(path, label),
        });
      } catch {
        usePendingInputStore.getState().setPendingInput(saveUnitId, `${path}/@conflict`, {
          value: JSON.stringify((next as RecordData)[field]),
          diagnosticCode: 'editor.pending-input.conflict',
        });
      }
      return;
    }
    // Rebase structural/optional edits at native dispatch. Never replay a
    // render-time whole-record snapshot after an unrelated field was accepted.
    const action = projectEdits.rebasedProjectRecordData({
      collection,
      id,
      before: projected,
      after: next,
      makeCommand: (rebased, record) => ({
        type: 'project.applyPatch',
        label,
        payload: nativeFieldJsonPatches(
          getJsonAtPointer(record, '/data'),
          rebased,
          buildJsonPointer([collection, id, 'data']),
        ),
        originSaveUnitId: saveUnitId,
        persistencePolicy: 'manual-save',
      }),
    });
    if (action) void projectEdits.execute(action);
  }

  const errors = paths.flatMap((path, index) => {
    const entry = entries[index];
    if (!entry?.error) return [];
    return [{ path, entry }];
  });

  return {
    data: projected,
    commit,
    errors: (
      <div className="space-y-1">
        {errors.map(({ path, entry }) => (
          <ProjectFieldError
            key={path}
            field={{
              error: entry.error,
              conflict: entry.conflict,
              flush: () => projectEdits.flushField(path),
              useCurrent: () => projectEdits.useCurrentField(path),
              keepMine: () => projectEdits.keepMineField(path),
            }}
          />
        ))}
      </div>
    ),
  };
}
