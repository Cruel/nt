import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import {
  defaultValueForVariableType,
  isVariableDefaultValueCompatible,
  parseVariableData,
  type VariableData,
  type VariableType,
} from '../../shared/project-schema/authoring-variables';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonPatchOperation } from './json-patch';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';

export interface ReplaceVariableDataPayload {
  variableId: string;
  data: unknown;
}

export interface SetVariableTypePayload {
  variableId: string;
  type: VariableType;
  defaultValue?: unknown;
  enumValues?: string[];
}

export interface SetVariableDefaultValuePayload {
  variableId: string;
  defaultValue: unknown;
}

function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function pathForVariable(variableId: string) {
  return buildJsonPointer(['variables', variableId]);
}

function pathForVariableData(variableId: string) {
  return buildJsonPointer(['variables', variableId, 'data']);
}

function validateVariableTarget(document: JsonValue | unknown, variableId: string): EntityOperationDiagnostic | null {
  if (!isAuthoringProject(document)) return error('Current document is not a NovelTea authoring project.');
  if (!document.variables[variableId]) return error('Variable record does not exist.', pathForVariable(variableId));
  return null;
}

function variableDataPatch(variableId: string, data: VariableData): JsonPatchOperation {
  return { op: 'replace', path: pathForVariableData(variableId), value: toJsonValue(data) };
}

export function replaceVariableDataPatches(
  document: JsonValue | unknown,
  payload: ReplaceVariableDataPayload,
): EntityOperationResult {
  const targetError = validateVariableTarget(document, payload.variableId);
  if (targetError) return { patches: [], diagnostics: [targetError] };
  const data = parseVariableData(payload.data);
  if (!data) return { patches: [], diagnostics: [error('Variable data is invalid.', pathForVariableData(payload.variableId))] };
  if (!isVariableDefaultValueCompatible(data.type, data.defaultValue, data.enumValues)) {
    return {
      patches: [],
      diagnostics: [error(`Default value does not match ${data.type}.`, buildJsonPointer(['variables', payload.variableId, 'data', 'defaultValue']))],
    };
  }
  if (data.type === 'enum') {
    const values = data.enumValues ?? [];
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (!value.trim()) return { patches: [], diagnostics: [error('Enum values cannot be empty.', buildJsonPointer(['variables', payload.variableId, 'data', 'enumValues', String(index)]))] };
      if (seen.has(value)) return { patches: [], diagnostics: [error(`Duplicate enum value '${value}'.`, buildJsonPointer(['variables', payload.variableId, 'data', 'enumValues', String(index)]))] };
      seen.add(value);
    }
    if (values.length === 0) return { patches: [], diagnostics: [error('Enum variables require at least one enum value.', buildJsonPointer(['variables', payload.variableId, 'data', 'enumValues']))] };
  }
  return { patches: [variableDataPatch(payload.variableId, data)], affectedPaths: [pathForVariableData(payload.variableId)] };
}

export function setVariableTypePatches(
  document: JsonValue | unknown,
  payload: SetVariableTypePayload,
): EntityOperationResult {
  const targetError = validateVariableTarget(document, payload.variableId);
  if (targetError) return { patches: [], diagnostics: [targetError] };
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  const current = parseVariableData(document.variables[payload.variableId].data);
  if (!current) return { patches: [], diagnostics: [error('Variable data is invalid.', pathForVariableData(payload.variableId))] };
  const enumValues = payload.type === 'enum' ? (payload.enumValues?.length ? payload.enumValues : current.enumValues?.length ? current.enumValues : ['default']) : undefined;
  const defaultValue = payload.defaultValue !== undefined && isVariableDefaultValueCompatible(payload.type, payload.defaultValue, enumValues)
    ? payload.defaultValue
    : defaultValueForVariableType(payload.type, enumValues);
  const data: VariableData = {
    ...current,
    type: payload.type,
    defaultValue,
    enumValues,
  };
  if (payload.type !== 'enum') delete data.enumValues;
  return replaceVariableDataPatches(document, { variableId: payload.variableId, data });
}

export function setVariableDefaultValuePatches(
  document: JsonValue | unknown,
  payload: SetVariableDefaultValuePayload,
): EntityOperationResult {
  const targetError = validateVariableTarget(document, payload.variableId);
  if (targetError) return { patches: [], diagnostics: [targetError] };
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  const current = parseVariableData(document.variables[payload.variableId].data);
  if (!current) return { patches: [], diagnostics: [error('Variable data is invalid.', pathForVariableData(payload.variableId))] };
  if (!isVariableDefaultValueCompatible(current.type, payload.defaultValue, current.enumValues)) {
    return {
      patches: [],
      diagnostics: [error(`Default value does not match ${current.type}.`, buildJsonPointer(['variables', payload.variableId, 'data', 'defaultValue']))],
    };
  }
  return replaceVariableDataPatches(document, {
    variableId: payload.variableId,
    data: { ...current, defaultValue: payload.defaultValue },
  });
}
