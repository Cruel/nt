import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import { parseDialogueData, validateDialogueData, type DialogueData } from '../../shared/project-schema/authoring-dialogues';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonPatchOperation } from './json-patch';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';

export interface ReplaceDialogueDataPayload {
  dialogueId: string;
  data: DialogueData | unknown;
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
  document: JsonValue | unknown,
  payload: ReplaceDialogueDataPayload,
): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  const record = document.dialogues[payload.dialogueId];
  if (!record) return { patches: [], diagnostics: [error('Dialogue record does not exist.', pathForDialogue(payload.dialogueId))] };
  const data = parseDialogueData(payload.data);
  if (!data) return { patches: [], diagnostics: [error('Dialogue data is invalid.', pathForDialogueData(payload.dialogueId))] };
  const diagnostics = validateDialogueData(document, payload.dialogueId, { ...record, data });
  const failure = diagnostics.find((item) => item.severity === 'error');
  if (failure) return { patches: [], diagnostics: [error(failure.message, failure.path)] };
  const patch: JsonPatchOperation = { op: 'replace', path: pathForDialogueData(payload.dialogueId), value: toJsonValue(data) };
  return { patches: [patch], affectedPaths: [patch.path] };
}
