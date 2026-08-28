import type { AuthoringProject } from './authoring-project';
import { isVariableValueCompatible, parseVariableData } from './authoring-variables';

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
  if (
    !variable ||
    !isVariableValueCompatible(variable.type, value, variable.enumValues, variable.nullable)
  ) {
    return {
      ok: false,
      kind: 'type-mismatch',
      message: `Value does not match variable '${variableId}'.`,
    };
  }

  return { ok: true };
}
