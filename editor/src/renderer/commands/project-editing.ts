import { useCommandStore } from './command-store';
import type {
  CommandExecutionResult,
  CommandRequest,
  CommandTransactionRequest,
} from './command-types';
import {
  flushNativeField,
  flushNativeFields,
  discardNativeField,
  nativeFieldDraftKey,
  nativeFieldKey,
  stageNativeField,
} from './native-field-drafts';
import type { JsonValue } from '@/project/json-value';
import { toJsonValue } from '@/project/json-value';
import { applyJsonPatch } from '@/project/json-patch';
import { hasJsonAtPointer } from '@/project/json-pointer';
import { buildJsonPointer } from '@/project/json-pointer';
import { diffJsonDocuments } from '@/project/project-external-reconciliation';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';
import {
  resolveGameplayInstanceRecord,
  type GameplayInstanceKind,
} from '../../shared/project-schema/authoring-archetypes';
import type {
  AuthoringProject,
  AuthoringRecordBase,
} from '../../shared/project-schema/authoring-project';
import { defaultRoomData, parseRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  defaultCharacterData,
  parseCharacterData,
} from '../../shared/project-schema/authoring-characters';
import {
  defaultInteractableData,
  parseInteractableData,
} from '../../shared/project-schema/authoring-interactables';
import { useProjectStore } from '@/project/project-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { NATIVE_FIELD_DRAFT_SCHEMA } from './native-field-drafts';

/**
 * The single renderer entry point for Project mutations.
 *
 * Semantic/structural operations execute in the native revision-checked queue.
 * Representable field edits synchronously publish a small presentation draft,
 * then coalesce into that *same* queue. This never mutates the acknowledged
 * Project document or creates a second Project authority.
 *
 * Source-code text buffers are not Project field edits: their owner-specific
 * stage/save protocol remains in the Project source store.
 */
export interface ProjectFieldIntent<T extends JsonValue> {
  tabId: string;
  path: string;
  saveUnitId: string;
  value: T;
  label: string;
  buildCommand?: (value: T) => CommandRequest;
}

export const projectEdits = {
  execute: (request: CommandRequest | (() => CommandRequest)): Promise<CommandExecutionResult> => {
    let planned: CommandRequest | (() => CommandRequest);
    try {
      // Capture the intentional delta now, before earlier queued commands
      // change the acknowledged Project. Only its application is deferred.
      planned = typeof request === 'function' ? request : rebaseGameplayCommand(request);
    } catch (error) {
      // Let the command store convert a stale/deleted target into an ordinary
      // rejected command result instead of throwing from a UI event handler.
      planned = () => {
        throw error;
      };
    }
    return useCommandStore.getState().executeCommandAsync(planned);
  },

  batch(
    transaction: CommandTransactionRequest,
    requests: readonly CommandRequest[],
  ): Promise<CommandExecutionResult> {
    return useCommandStore.getState().executeCommandBatchAsync(transaction, requests);
  },

  undo(): Promise<CommandExecutionResult> {
    return useCommandStore.getState().undoAsync();
  },

  redo(): Promise<CommandExecutionResult> {
    return useCommandStore.getState().redoAsync();
  },

  field<T extends JsonValue>(intent: ProjectFieldIntent<T>): boolean {
    const { projectSessionId, projectInstanceId } = useProjectStore.getState();
    if (!projectSessionId || !projectInstanceId) return false;
    stageNativeField(
      {
        projectSessionId,
        projectInstanceId,
        saveUnitId: intent.saveUnitId,
        path: intent.path,
        value: intent.value,
      },
      (readAtDispatch) =>
        useCommandStore.getState().executeCommandAsync(
          () => {
            const value = readAtDispatch();
            return intent.buildCommand
              ? intent.buildCommand(value as T)
              : defaultProjectFieldCommand(intent, value);
          },
          { bufferedField: true },
        ),
    );
    // Persist the form representation in the same synchronous event as the
    // visible overlay. React effects may run after a close/reload begins.
    const drafts = useDraftDirtyStore.getState();
    const draftKey = nativeFieldDraftKey(intent.saveUnitId, intent.path);
    const existing = drafts.entriesByKey[draftKey];
    const fieldKey = nativeFieldKey(projectSessionId, projectInstanceId, intent.path);
    drafts.setDraftDirty(draftKey, {
      tabId: existing?.tabId ?? intent.tabId,
      dirty: true,
      label: intent.label,
      schema: NATIVE_FIELD_DRAFT_SCHEMA,
      payload: intent.value,
      apply: () => flushNativeField(fieldKey),
      discard: () => discardNativeField(fieldKey),
    });
    return true;
  },

  flush(saveUnitId?: string): Promise<boolean> {
    return flushNativeFields(saveUnitId);
  },

  flushField(path: string): Promise<boolean> {
    const { projectSessionId, projectInstanceId } = useProjectStore.getState();
    if (!projectSessionId || !projectInstanceId) return Promise.resolve(false);
    return flushNativeField(nativeFieldKey(projectSessionId, projectInstanceId, path));
  },
};

function rebaseGameplayCommand(request: CommandRequest): CommandRequest | (() => CommandRequest) {
  const kind = request.type.replace(/\.replaceData$/u, '');
  if (kind !== 'room' && kind !== 'character' && kind !== 'interactable') return request;
  const payload = request.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return request;
  const values = payload as Record<string, unknown>;
  const id = values[`${kind}Id`];
  if (typeof id !== 'string' || !values.data || typeof values.data !== 'object') return request;
  const readData: RecordDataReader<JsonValue> = (_project, record) =>
    toJsonValue(
      kind === 'room'
        ? (parseRoomData(record.data) ?? defaultRoomData(record.label ?? id))
        : kind === 'character'
          ? (parseCharacterData(record.data) ?? defaultCharacterData(record.label ?? id))
          : (parseInteractableData(record.data) ?? defaultInteractableData(record.label ?? id)),
    );
  const previous = latestGameplayRecord(kind, id, readData);
  const changes = diffJsonDocuments(previous, toJsonValue(values.data));
  if (!changes.length) return request;
  return () => ({
    ...request,
    payload: {
      ...values,
      data: applyJsonPatch(latestGameplayRecord(kind, id, readData), changes).document,
    },
  });
}

/** Re-evaluate path existence only when this intent reaches the acknowledged
 * Project, so optional settings created by earlier queued edits are not lost. */
export function defaultProjectFieldCommand(
  intent: Pick<ProjectFieldIntent<JsonValue>, 'path' | 'saveUnitId' | 'label'>,
  value: JsonValue,
): CommandRequest {
  const document = useProjectStore.getState().document;
  if (!document) throw new Error('No Project is open.');
  return {
    type: hasJsonAtPointer(document, intent.path) ? 'project.replaceAtPath' : 'project.addAtPath',
    label: intent.label,
    payload: { path: intent.path, value },
    originSaveUnitId: intent.saveUnitId,
    persistencePolicy: 'manual-save',
  };
}

type RecordDataReader<T> = (project: AuthoringProject, record: AuthoringRecordBase) => T;

function latestGameplayRecord<T>(
  kind: GameplayInstanceKind,
  id: string,
  readData: RecordDataReader<T>,
): T {
  const project = useProjectStore.getState().document;
  if (!isAuthoringProjectView(project)) throw new Error('The Project is no longer open.');
  const collection = `${kind}s` as 'rooms' | 'characters' | 'interactables';
  const record = project[collection][id];
  if (!record) throw new Error(`The ${kind} ${id} was deleted before the edit completed.`);
  const effective = resolveGameplayInstanceRecord(project, kind, record);
  if (!effective) throw new Error(`The ${kind} ${id} no longer has valid archetype data.`);
  return readData(project, effective);
}

/**
 * Use the narrow native field patch for ordinary records; preserve the
 * semantic override planner for archetyped records. The command is built
 * after all earlier native acknowledgments, never from a render-time object.
 */
export function gameplayRecordFieldCommand<T>(
  kind: GameplayInstanceKind,
  id: string,
  relativePath: string,
  value: JsonValue,
  label: string,
  readData: RecordDataReader<T>,
): CommandRequest {
  const project = useProjectStore.getState().document;
  if (!isAuthoringProjectView(project)) throw new Error('The Project is no longer open.');
  const collection = `${kind}s` as 'rooms' | 'characters' | 'interactables';
  const record = project[collection][id];
  if (!record) throw new Error(`The ${kind} ${id} was deleted before the edit completed.`);
  const saveUnitId = recordSaveUnitId(collection, id);
  const path = buildJsonPointer([collection, id, 'data']) + relativePath;
  if (!record.archetype) return defaultProjectFieldCommand({ path, saveUnitId, label }, value);
  const before = toJsonValue(latestGameplayRecord(kind, id, readData));
  const patches = [
    {
      op: hasJsonAtPointer(before, relativePath) ? 'replace' : 'add',
      path: relativePath,
      value,
    } as const,
  ];
  const after = applyJsonPatch(before, patches).document;
  return {
    type: `${kind}.replaceData`,
    payload: { [`${kind}Id`]: id, data: after },
    label,
    originSaveUnitId: saveUnitId,
    persistencePolicy: 'manual-save',
  };
}

/**
 * Legacy composite editors may still construct a whole-record proposal.
 * Calculate the actual delta at the event and apply it to the latest native
 * acknowledgment when its queue slot executes. Disjoint edits cannot be
 * overwritten by a proposal assembled from an older render.
 */
export function rebasedGameplayDataCommand<T>(
  kind: GameplayInstanceKind,
  id: string,
  before: T,
  after: T,
  label: string,
  readData: RecordDataReader<T>,
): (() => CommandRequest) | null {
  const changes = diffJsonDocuments(toJsonValue(before), toJsonValue(after));
  if (!changes.length) return null;
  return () => {
    const latest = latestGameplayRecord(kind, id, readData);
    return {
      type: `${kind}.replaceData`,
      payload: {
        [`${kind}Id`]: id,
        data: applyJsonPatch(toJsonValue(latest), changes).document,
      },
      label,
      originSaveUnitId: recordSaveUnitId(
        `${kind}s` as 'rooms' | 'characters' | 'interactables',
        id,
      ),
      persistencePolicy: 'manual-save',
    };
  };
}
