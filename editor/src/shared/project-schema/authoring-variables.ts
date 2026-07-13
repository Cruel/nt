import { z } from 'zod';
import type { AuthoredRuntimeValue } from './authoring-properties';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';

export const variableTypeValues = ['boolean', 'integer', 'number', 'string', 'enum'] as const;
export const variableScopeValues = ['global'] as const;

export type VariableType = (typeof variableTypeValues)[number];
export type VariableScope = (typeof variableScopeValues)[number];

const variableDefaultValueSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.string(),
]);

export const variableRefSchema = z.object({ $var: z.string().min(1) }).strict();

export const variableDataSchema = z.object({
  kind: z.literal('variable').default('variable'),
  type: z.enum(variableTypeValues),
  defaultValue: variableDefaultValueSchema,
  scope: z.enum(variableScopeValues).default('global'),
  enumValues: z.array(z.string()).optional(),
}).strict();

export type VariableRef = z.infer<typeof variableRefSchema>;
export type VariableData = z.infer<typeof variableDataSchema>;

export interface VariableSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(path: string, message: string, severity: 'error' | 'warning' | 'info' = 'error'): VariableSchemaDiagnostic {
  return { severity, path, message, category: 'authoring-variables' };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizedEnumValues(enumValues: readonly string[] | undefined): string[] {
  return (enumValues ?? []).map((value) => value.trim()).filter(Boolean);
}

export function variableRef(variableId: string): VariableRef {
  return { $var: variableId };
}

export function isVariableRef(value: unknown): value is VariableRef {
  return variableRefSchema.safeParse(value).success;
}

export function parseVariableData(value: unknown): VariableData | null {
  const parsed = variableDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultValueForVariableType(type: VariableType, enumValues?: readonly string[]): Exclude<AuthoredRuntimeValue, null> {
  if (type === 'boolean') return false;
  if (type === 'integer') return 0;
  if (type === 'number') return 0;
  if (type === 'string') return '';
  return normalizedEnumValues(enumValues)[0] ?? 'default';
}

export function defaultVariableData(type: VariableType = 'boolean'): VariableData {
  if (type === 'enum') {
    return variableDataSchema.parse({
      kind: 'variable',
      type,
      scope: 'global',
      enumValues: ['default'],
      defaultValue: 'default',
    });
  }
  return variableDataSchema.parse({
    kind: 'variable',
    type,
    scope: 'global',
    defaultValue: defaultValueForVariableType(type),
  });
}

export function isVariableDefaultValueCompatible(type: VariableType, value: unknown, enumValues?: readonly string[]): value is Exclude<AuthoredRuntimeValue, null> {
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer') return isFiniteNumber(value) && Number.isInteger(value);
  if (type === 'number') return isFiniteNumber(value);
  if (type === 'string') return typeof value === 'string';
  const values = normalizedEnumValues(enumValues);
  return typeof value === 'string' && values.includes(value);
}

export function normalizeVariableDefaultValue(type: VariableType, value: unknown, enumValues?: readonly string[]): Exclude<AuthoredRuntimeValue, null> {
  if (isVariableDefaultValueCompatible(type, value, enumValues)) return value;
  return defaultValueForVariableType(type, enumValues);
}

export function variableDefaultValueToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

export function parseVariableDefaultText(
  type: VariableType,
  text: string,
  enumValues?: readonly string[],
): { ok: true; value: Exclude<AuthoredRuntimeValue, null> } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (type === 'boolean') {
    if (trimmed === 'true') return { ok: true, value: true };
    if (trimmed === 'false') return { ok: true, value: false };
    return { ok: false, message: 'Boolean defaults must be true or false.' };
  }
  if (type === 'integer') {
    const value = Number(trimmed);
    if (Number.isInteger(value)) return { ok: true, value };
    return { ok: false, message: 'Integer defaults must be whole numbers.' };
  }
  if (type === 'number') {
    const value = Number(trimmed);
    if (Number.isFinite(value)) return { ok: true, value };
    return { ok: false, message: 'Number defaults must be finite numbers.' };
  }
  if (type === 'string') return { ok: true, value: text };
  const values = normalizedEnumValues(enumValues);
  if (values.includes(text)) return { ok: true, value: text };
  return { ok: false, message: 'Enum defaults must match one of the enum values.' };
}

export function parseEnumValuesText(text: string): string[] {
  return text.split(',').flatMap((part) => part.split('\n')).map((value) => value.trim()).filter(Boolean);
}

function enumDiagnostics(data: VariableData, base: string): VariableSchemaDiagnostic[] {
  if (data.type !== 'enum') return [];
  const diagnostics: VariableSchemaDiagnostic[] = [];
  const values = data.enumValues ?? [];
  if (values.length === 0) {
    diagnostics.push(diagnostic(`${base}/enumValues`, 'Enum variables require at least one enum value.'));
  }
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (!value.trim()) diagnostics.push(diagnostic(`${base}/enumValues/${index}`, 'Enum values cannot be empty.'));
    if (seen.has(value)) diagnostics.push(diagnostic(`${base}/enumValues/${index}`, `Duplicate enum value '${value}'.`));
    seen.add(value);
  });
  return diagnostics;
}

export function validateVariableData(
  _project: AuthoringProject,
  variableId: string,
  record: AuthoringRecordBase,
): VariableSchemaDiagnostic[] {
  const diagnostics: VariableSchemaDiagnostic[] = [];
  const parsed = variableDataSchema.safeParse(record.data);
  const base = `/variables/${variableId}/data`;
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(diagnostic(`${base}/${issue.path.map(String).join('/')}`, issue.message));
    }
    return diagnostics;
  }
  const data = parsed.data;
  diagnostics.push(...enumDiagnostics(data, base));
  if (!isVariableDefaultValueCompatible(data.type, data.defaultValue, data.enumValues)) {
    diagnostics.push(diagnostic(`${base}/defaultValue`, `Default value does not match ${data.type}.`));
  }
  return diagnostics;
}
