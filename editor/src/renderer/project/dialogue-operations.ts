import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import {
  parseDialogueData,
  validateDialogueData,
} from '../../shared/project-schema/authoring-dialogues';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonPatchOperation } from './json-patch';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';
import {
  preserveStructuredMessageIdentityPatches,
  type StructuredMessageOwnerMove,
} from './structured-message-operations';

export interface ReplaceDialogueDataPayload {
  dialogueId: string;
  data: unknown;
  semanticOwnerMoves?: StructuredMessageOwnerMove[];
}

function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function pathForDialogue(dialogueId: string) {
  return buildJsonPointer(['dialogues', dialogueId]);
}

function pathForDialogueData(dialogueId: string) {
  return buildJsonPointer(['dialogues', dialogueId, 'data']);
}

export function replaceDialogueDataPatches(
  document: unknown,
  payload: ReplaceDialogueDataPayload,
): EntityOperationResult {
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const record = document.dialogues[payload.dialogueId];
  if (!record)
    return {
      patches: [],
      diagnostics: [error('Dialogue record does not exist.', pathForDialogue(payload.dialogueId))],
    };
  const data = parseDialogueData(payload.data);
  if (!data)
    return {
      patches: [],
      diagnostics: [error('Dialogue data is invalid.', pathForDialogueData(payload.dialogueId))],
    };
  const diagnostics = validateDialogueData(document, payload.dialogueId, { ...record, data });
  const failure = diagnostics.find((item) => item.severity === 'error');
  if (failure) return { patches: [], diagnostics: [error(failure.message, failure.path)] };
  const messageIdentity = preserveStructuredMessageIdentityPatches(
    document,
    payload.semanticOwnerMoves ?? [],
  );
  if (messageIdentity.conflict)
    return {
      patches: [],
      diagnostics: [error(messageIdentity.conflict.message, messageIdentity.conflict.path)],
    };
  const patch: JsonPatchOperation = {
    op: 'replace',
    path: pathForDialogueData(payload.dialogueId),
    value: toJsonValue(data),
  };
  return {
    patches: [patch, ...messageIdentity.patches],
    affectedPaths: [patch.path, ...messageIdentity.affectedPaths],
  };
}
