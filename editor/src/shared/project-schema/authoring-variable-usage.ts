import type { AuthoringProject } from './authoring-project';
import { isVariableDefaultValueCompatible, parseVariableData } from './authoring-variables';

export type VariableUsageValidationResult =
  | { ok: true }
  | { ok: false; kind: 'missing'; message: string }
  | { ok: false; kind: 'type-mismatch'; message: string };

export function validateVariableRuntimeValue(
  project: AuthoringProject,
  variableId: string,
  value: unknown,
): VariableUsageValidationResult {
  const record = project.variables[variableId];
  if (!record) {
    return { ok: false, kind: 'missing', message: `Missing variable '${variableId}'.` };
  }

  const variable = parseVariableData(record.data);
  if (!variable || !isVariableDefaultValueCompatible(variable.type, value, variable.enumValues)) {
    return {
      ok: false,
      kind: 'type-mismatch',
      message: `Value does not match variable '${variableId}'.`,
    };
  }

  return { ok: true };
}
