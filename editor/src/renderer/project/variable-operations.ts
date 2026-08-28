import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import {
  defaultValueForVariableType,
  isVariableValueCompatible,
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

function validateVariableTarget(
  document: unknown,
  variableId: string,
): EntityOperationDiagnostic | null {
  if (!isAuthoringProject(document)) return error('Current document is not a NovelTea project.');
  if (!document.variables[variableId])
    return error('Variable record does not exist.', pathForVariable(variableId));
  return null;
}

function variableDataPatch(variableId: string, data: VariableData): JsonPatchOperation {
  return { op: 'replace', path: pathForVariableData(variableId), value: toJsonValue(data) };
}

export function replaceVariableDataPatches(
  document: unknown,
  payload: ReplaceVariableDataPayload,
): EntityOperationResult {
  const targetError = validateVariableTarget(document, payload.variableId);
  if (targetError) return { patches: [], diagnostics: [targetError] };
  const data = parseVariableData(payload.data);
  if (!data)
    return {
      patches: [],
      diagnostics: [error('Variable data is invalid.', pathForVariableData(payload.variableId))],
    };
  if (!isVariableValueCompatible(data.type, data.value, data.enumValues, data.nullable)) {
    return {
      patches: [],
      diagnostics: [
        error(
          `Value does not match ${data.type}.`,
          buildJsonPointer(['variables', payload.variableId, 'data', 'value']),
        ),
      ],
    };
  }
  if (data.type === 'enum') {
    const values = data.enumValues ?? [];
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (!value.trim())
        return {
          patches: [],
          diagnostics: [
            error(
              'Enum values cannot be empty.',
              buildJsonPointer([
                'variables',
                payload.variableId,
                'data',
                'enumValues',
                String(index),
              ]),
            ),
          ],
        };
      if (seen.has(value))
        return {
          patches: [],
          diagnostics: [
            error(
              `Duplicate enum value '${value}'.`,
              buildJsonPointer([
                'variables',
                payload.variableId,
                'data',
                'enumValues',
                String(index),
              ]),
            ),
          ],
        };
      seen.add(value);
    }
    if (values.length === 0)
      return {
        patches: [],
        diagnostics: [
          error(
            'Enum variables require at least one enum value.',
            buildJsonPointer(['variables', payload.variableId, 'data', 'enumValues']),
          ),
        ],
      };
  }
  return {
    patches: [variableDataPatch(payload.variableId, data)],
    affectedPaths: [pathForVariableData(payload.variableId)],
  };
}

export function setVariableTypePatches(
  document: unknown,
  payload: SetVariableTypePayload,
): EntityOperationResult {
  const targetError = validateVariableTarget(document, payload.variableId);
  if (targetError) return { patches: [], diagnostics: [targetError] };
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const current = parseVariableData(document.variables[payload.variableId].data);
  if (!current)
    return {
      patches: [],
      diagnostics: [error('Variable data is invalid.', pathForVariableData(payload.variableId))],
    };
  const enumValues =
    payload.type === 'enum'
      ? payload.enumValues?.length
        ? payload.enumValues
        : current.enumValues?.length
          ? current.enumValues
          : ['default']
      : undefined;
  const value =
    payload.defaultValue !== undefined &&
    isVariableValueCompatible(payload.type, payload.defaultValue, enumValues, current.nullable)
      ? payload.defaultValue
      : defaultValueForVariableType(payload.type, enumValues);
  const data: VariableData = {
    ...current,
    type: payload.type,
    value,
    enumValues,
  };
  if (payload.type !== 'enum') delete data.enumValues;
  return replaceVariableDataPatches(document, { variableId: payload.variableId, data });
}

export function setVariableDefaultValuePatches(
  document: unknown,
  payload: SetVariableDefaultValuePayload,
): EntityOperationResult {
  const targetError = validateVariableTarget(document, payload.variableId);
  if (targetError) return { patches: [], diagnostics: [targetError] };
  if (!isAuthoringProject(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const current = parseVariableData(document.variables[payload.variableId].data);
  if (!current)
    return {
      patches: [],
      diagnostics: [error('Variable data is invalid.', pathForVariableData(payload.variableId))],
    };
  if (
    !isVariableValueCompatible(
      current.type,
      payload.defaultValue,
      current.enumValues,
      current.nullable,
    )
  ) {
    return {
      patches: [],
      diagnostics: [
        error(
          `Value does not match ${current.type}.`,
          buildJsonPointer(['variables', payload.variableId, 'data', 'value']),
        ),
      ],
    };
  }
  return replaceVariableDataPatches(document, {
    variableId: payload.variableId,
    data: { ...current, value: payload.defaultValue },
  });
}
