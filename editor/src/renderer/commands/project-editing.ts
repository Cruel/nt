import { useCommandStore } from './command-store';
import type {
  CommandExecutionResult,
  CommandRequest,
  CommandBatchRequests,
  CommandTransactionRequest,
} from './command-types';
import {
  flushNativeField,
  flushNativeFields,
  endNativeFieldEditSession,
  discardNativeField,
  keepMineNativeField,
  nativeFieldDraftKey,
  nativeFieldKey,
  nativeFieldRecoveryPayload,
  stageNativeField,
  chooseCurrentNativeField,
  useNativeFieldDraftStore,
  type NativeFieldBase,
} from './native-field-drafts';
import type { JsonValue } from '@/project/json-value';
import { jsonValuesEqual, toJsonValue } from '@/project/json-value';
import { applyJsonPatch } from '@/project/json-patch';
import {
  getJsonAtPointer,
  hasJsonAtPointer,
  parseJsonPointer,
  buildJsonPointer,
} from '@/project/json-pointer';
import { diffJsonDocuments } from '@/project/project-external-reconciliation';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';
import { resolveGameplayInstanceRecord } from '../../shared/project-schema/authoring-archetypes';
import { gameplayRecordDescriptors, type GameplayRecordRef } from './gameplay-record-descriptors';
import { useProjectStore } from '@/project/project-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { NATIVE_FIELD_DRAFT_SCHEMA } from './native-field-drafts';
import {
  resolveProjectFieldIdentity,
  resolveExactInstanceFieldIdentity,
} from './project-field-identity';
import {
  applySemanticCollectionOperation,
  applySemanticItemPatch,
  type SemanticCollectionOperation,
} from './semantic-collection-planner';

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
  /** Explicit owner-validated exception for the infrastructure Instance registry. */
  scope?: 'exact-instance';
  /** Only used when rehydrating an already-existing recoverable field intent. */
  restoredBase?: NativeFieldBase;
}

const recoveryActions = new Map<
  string,
  {
    apply: () => Promise<boolean>;
    discard: () => Promise<boolean>;
  }
>();

function recoveryActionsForField(fieldKey: string) {
  let actions = recoveryActions.get(fieldKey);
  if (!actions) {
    actions = {
      apply: () => flushNativeField(fieldKey),
      discard: () => discardNativeField(fieldKey),
    };
    recoveryActions.set(fieldKey, actions);
  }
  return actions;
}

useProjectStore.subscribe((state, previous) => {
  if (
    state.projectInstanceId !== previous.projectInstanceId ||
    state.projectSessionId !== previous.projectSessionId
  )
    recoveryActions.clear();
});

export const projectEdits = {
  execute: (request: CommandRequest | (() => CommandRequest)): Promise<CommandExecutionResult> => {
    // Never infer an edit's baseline from a ready-made replaceData proposal.
    // Composite editors must explicitly capture before/after at the event.
    return useCommandStore.getState().executeCommandAsync(request);
  },

  batch(
    transaction: CommandTransactionRequest,
    requests: CommandBatchRequests,
  ): Promise<CommandExecutionResult> {
    return useCommandStore.getState().executeCommandBatchAsync(transaction, requests);
  },

  recordField(options: {
    record: GameplayRecordRef;
    field: string;
    value: JsonValue;
    label: string;
  }): CommandRequest {
    return gameplayRecordFieldCommand(options);
  },

  recordData(options: {
    record: GameplayRecordRef;
    before: unknown;
    after: unknown;
    label: string;
  }): (() => CommandRequest) | null {
    return rebasedGameplayDataCommand(options);
  },

  /** A stable-ID list action, evaluated in the native command queue. */
  recordList(options: {
    record: GameplayRecordRef;
    field: string;
    action: SemanticCollectionOperation;
    label: string;
  }): () => CommandRequest {
    const { record, field, action, label } = options;
    return () => {
      const latest = latestGameplayRecord(record);
      const items = getJsonAtPointer(latest, field);
      const next = applySemanticCollectionOperation(items, action);
      return gameplayRecordFieldCommand({ record, field, value: next, label });
    };
  },

  /** Late-bound, field-granular delta for one stable-ID collection entry. */
  recordItem(options: {
    record: GameplayRecordRef;
    field: string;
    id: string;
    before: unknown;
    after: unknown;
    label: string;
  }): (() => CommandRequest) | null {
    const { record, field, id, before, after, label } = options;
    const previous = toJsonValue(before);
    const nextValue = toJsonValue(after);
    if (jsonValuesEqual(previous, nextValue)) return null;
    return () => {
      const latest = latestGameplayRecord(record);
      const items = getJsonAtPointer(latest, field);
      const next = applySemanticItemPatch(items, { id, before: previous, after: nextValue });
      return gameplayRecordFieldCommand({ record, field, value: next, label });
    };
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
    // Reject a contradictory caller before it can create an overlay or a
    // recoverable draft under a different owner from the native attribution.
    const identity = {
      projectSessionId,
      projectInstanceId,
      saveUnitId: intent.saveUnitId,
      path: intent.path,
    };
    if (intent.scope === 'exact-instance')
      resolveExactInstanceFieldIdentity(identity, useProjectStore.getState().document);
    else resolveProjectFieldIdentity(identity);
    const fieldKey = nativeFieldKey(projectSessionId, projectInstanceId, intent.path);
    stageNativeField(
      {
        projectSessionId,
        projectInstanceId,
        saveUnitId: intent.saveUnitId,
        path: intent.path,
        value: intent.value,
        restoredBase: intent.restoredBase,
      },
      (readAtDispatch) =>
        useCommandStore.getState().executeCommandAsync(
          () => {
            const value = readAtDispatch();
            const command = intent.buildCommand
              ? intent.buildCommand(value as T)
              : defaultProjectFieldCommand(intent, value);
            if (
              command.originSaveUnitId !== intent.saveUnitId ||
              command.persistencePolicy !== 'manual-save'
            )
              throw new Error('Project field command has contradictory Save-owner attribution.');
            const editSessionId =
              useNativeFieldDraftStore.getState().entries[fieldKey]?.editSessionId;
            return editSessionId ? { ...command, editSessionId } : command;
          },
          { bufferedField: true },
        ),
    );
    // Persist the form representation in the same synchronous event as the
    // visible overlay. React effects may run after a close/reload begins.
    const drafts = useDraftDirtyStore.getState();
    const draftKey = nativeFieldDraftKey(intent.saveUnitId, intent.path);
    const existing = drafts.entriesByKey[draftKey];
    const entry = useNativeFieldDraftStore.getState().entries[fieldKey];
    if (!entry) return false;
    const actions = recoveryActionsForField(fieldKey);
    drafts.setDraftDirty(draftKey, {
      tabId: existing?.tabId ?? intent.tabId,
      dirty: true,
      label: intent.label,
      schema: NATIVE_FIELD_DRAFT_SCHEMA,
      payload: nativeFieldRecoveryPayload(entry),
      ...actions,
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

  endFieldSession(path: string): void {
    const { projectSessionId, projectInstanceId } = useProjectStore.getState();
    if (projectSessionId && projectInstanceId)
      endNativeFieldEditSession(nativeFieldKey(projectSessionId, projectInstanceId, path));
  },

  useCurrentField(path: string): Promise<boolean> {
    const { projectSessionId, projectInstanceId } = useProjectStore.getState();
    if (!projectSessionId || !projectInstanceId) return Promise.resolve(false);
    return chooseCurrentNativeField(nativeFieldKey(projectSessionId, projectInstanceId, path));
  },

  keepMineField(path: string): Promise<boolean> {
    const { projectSessionId, projectInstanceId } = useProjectStore.getState();
    if (!projectSessionId || !projectInstanceId) return Promise.resolve(false);
    return keepMineNativeField(nativeFieldKey(projectSessionId, projectInstanceId, path));
  },
};

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

function latestGameplayRecord({ collection, id }: GameplayRecordRef): JsonValue {
  const project = useProjectStore.getState().document;
  if (!isAuthoringProjectView(project)) throw new Error('The Project is no longer open.');
  const descriptor = gameplayRecordDescriptors[collection];
  const record = project[collection][id];
  if (!record)
    throw new Error(`The ${descriptor.kind} ${id} was deleted before the edit completed.`);
  const effective = resolveGameplayInstanceRecord(project, descriptor.kind, record);
  if (!effective)
    throw new Error(`The ${descriptor.kind} ${id} no longer has valid archetype data.`);
  return descriptor.readData(effective, id);
}

/**
 * Use the narrow native field patch for ordinary records; preserve the
 * semantic override planner for archetyped records. The command is built
 * after all earlier native acknowledgments, never from a render-time object.
 */
function gameplayRecordFieldCommand({
  record: { collection, id },
  field,
  value,
  label,
}: {
  record: GameplayRecordRef;
  field: string;
  value: JsonValue;
  label: string;
}): CommandRequest {
  const project = useProjectStore.getState().document;
  if (!isAuthoringProjectView(project)) throw new Error('The Project is no longer open.');
  const descriptor = gameplayRecordDescriptors[collection];
  const record = project[collection][id];
  if (!record)
    throw new Error(`The ${descriptor.kind} ${id} was deleted before the edit completed.`);
  if (
    !field.startsWith('/') ||
    field === '/' ||
    buildJsonPointer(parseJsonPointer(field)) !== field
  )
    throw new Error(`Invalid relative record field path: ${field}`);
  const saveUnitId = recordSaveUnitId(collection, id);
  const path = buildJsonPointer([collection, id, 'data', ...parseJsonPointer(field)]);
  if (!record.archetype) return defaultProjectFieldCommand({ path, saveUnitId, label }, value);
  const before = latestGameplayRecord({ collection, id });
  const patches = [
    {
      op: hasJsonAtPointer(before, field) ? 'replace' : 'add',
      path: field,
      value,
    } as const,
  ];
  const after = applyJsonPatch(before, patches).document;
  return {
    type: `${descriptor.kind}.replaceData`,
    payload: { [`${descriptor.kind}Id`]: id, data: after },
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
function rebasedGameplayDataCommand({
  record,
  before,
  after,
  label,
}: {
  record: GameplayRecordRef;
  before: unknown;
  after: unknown;
  label: string;
}): (() => CommandRequest) | null {
  const previous = toJsonValue(before);
  const changes = diffJsonDocuments(previous, toJsonValue(after));
  if (!changes.length) return null;
  return () => {
    const latest = latestGameplayRecord(record);
    // The event-time delta may rebase across disjoint acknowledgments, but
    // must not silently overwrite a different edit at the same semantic path.
    for (const change of changes) {
      const beforeExists = hasJsonAtPointer(previous, change.path);
      const latestExists = hasJsonAtPointer(latest, change.path);
      if (
        beforeExists !== latestExists ||
        (beforeExists &&
          !jsonValuesEqual(
            getJsonAtPointer(previous, change.path),
            getJsonAtPointer(latest, change.path),
          ))
      )
        throw new Error(`Record field '${change.path}' changed before this edit was applied.`);
    }
    const { kind } = gameplayRecordDescriptors[record.collection];
    return {
      type: `${kind}.replaceData`,
      payload: {
        [`${kind}Id`]: record.id,
        data: applyJsonPatch(latest, changes).document,
      },
      label,
      originSaveUnitId: recordSaveUnitId(record.collection, record.id),
      persistencePolicy: 'manual-save',
    };
  };
}
