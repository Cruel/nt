import {
  propertyValueTypeValues,
  type AuthoredRuntimeValue,
  type OwnerDefaultProperty,
  type OwnerLocalProperty,
} from '../../../shared/project-schema/authoring-properties';
import {
  defaultValueForVariableType,
  parseEnumValuesText,
  parseVariableValueText,
  variableValueToText,
  type VariableType,
} from '../../../shared/project-schema/authoring-variables';

export interface TypedPropertyDraft {
  id: string;
  label: string;
  description: string;
  type: VariableType;
  nullable: boolean;
  valuePresent: boolean;
  valueText: string;
  enumText: string;
}

export function newTypedPropertyDraft(id = ''): TypedPropertyDraft {
  return {
    id,
    label: '',
    description: '',
    type: 'boolean',
    nullable: false,
    valuePresent: true,
    valueText: 'false',
    enumText: 'default',
  };
}

export function typedPropertyDraftFromOwnerLocal(property: OwnerLocalProperty): TypedPropertyDraft {
  return {
    id: property.id,
    label: property.label ?? '',
    description: property.description ?? '',
    type: property.type,
    nullable: property.nullable,
    valuePresent: true,
    valueText: variableValueToText(property.value),
    enumText: property.enumValues?.join(', ') ?? 'default',
  };
}

export function typedPropertyDraftFromOwnerDefault(
  property: OwnerDefaultProperty,
): TypedPropertyDraft {
  const enumValues = property.enumValues;
  return {
    id: property.id,
    label: property.label ?? '',
    description: property.description ?? '',
    type: property.type,
    nullable: property.nullable,
    valuePresent: property.defaultValue !== undefined,
    valueText: variableValueToText(
      property.defaultValue ?? defaultValueForVariableType(property.type, enumValues),
    ),
    enumText: enumValues?.join(', ') ?? 'default',
  };
}

export function typedPropertyDraftForSchema(
  property: {
    id: string;
    label?: string;
    description?: string;
    type: VariableType;
    nullable: boolean;
    enumValues?: readonly string[];
  },
  value: AuthoredRuntimeValue | undefined,
  valuePresent = value !== undefined,
): TypedPropertyDraft {
  return {
    id: property.id,
    label: property.label ?? '',
    description: property.description ?? '',
    type: property.type,
    nullable: property.nullable,
    valuePresent,
    valueText: variableValueToText(
      value ?? defaultValueForVariableType(property.type, property.enumValues),
    ),
    enumText: property.enumValues?.join(', ') ?? 'default',
  };
}

export function typedPropertyValueFromDraft(
  draft: TypedPropertyDraft,
):
  | { ok: true; value: AuthoredRuntimeValue; enumValues?: string[] }
  | { ok: false; message: string } {
  const enumValues = draft.type === 'enum' ? parseEnumValuesText(draft.enumText) : undefined;
  if (draft.type === 'enum' && (!enumValues || enumValues.length === 0))
    return { ok: false, message: 'Enum properties require at least one value.' };
  if (enumValues && new Set(enumValues).size !== enumValues.length)
    return { ok: false, message: 'Enum values must be unique.' };
  const parsed = parseVariableValueText(draft.type, draft.valueText, enumValues, draft.nullable);
  return parsed.ok
    ? { ok: true, value: parsed.value, ...(enumValues ? { enumValues } : {}) }
    : parsed;
}

export function ownerLocalPropertyFromDraft(
  draft: TypedPropertyDraft,
): { ok: true; property: OwnerLocalProperty } | { ok: false; message: string } {
  const parsed = typedPropertyValueFromDraft(draft);
  if (!parsed.ok) return parsed;
  const id = draft.id.trim();
  if (!id) return { ok: false, message: 'Property ID is required.' };
  return {
    ok: true,
    property: {
      id,
      ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      type: draft.type,
      nullable: draft.nullable,
      value: parsed.value,
      ...(parsed.enumValues ? { enumValues: parsed.enumValues } : {}),
    },
  };
}

export function ownerDefaultPropertyFromDraft(
  draft: TypedPropertyDraft,
): { ok: true; property: OwnerDefaultProperty } | { ok: false; message: string } {
  const id = draft.id.trim();
  if (!id) return { ok: false, message: 'Property ID is required.' };
  const enumValues = draft.type === 'enum' ? parseEnumValuesText(draft.enumText) : undefined;
  if (draft.type === 'enum' && (!enumValues || enumValues.length === 0))
    return { ok: false, message: 'Enum properties require at least one value.' };
  if (enumValues && new Set(enumValues).size !== enumValues.length)
    return { ok: false, message: 'Enum values must be unique.' };
  let defaultValue: AuthoredRuntimeValue | undefined;
  if (draft.valuePresent) {
    const parsed = parseVariableValueText(draft.type, draft.valueText, enumValues, draft.nullable);
    if (!parsed.ok) return parsed;
    defaultValue = parsed.value;
  }
  return {
    ok: true,
    property: {
      id,
      ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      type: draft.type,
      nullable: draft.nullable,
      ...(defaultValue === undefined ? {} : { defaultValue }),
      ...(enumValues ? { enumValues } : {}),
    },
  };
}

export function propertyTypeLabel(type: VariableType) {
  if (type === 'boolean') return 'Boolean';
  if (type === 'integer') return 'Integer';
  if (type === 'number') return 'Number';
  if (type === 'string') return 'String';
  return 'Enum';
}

export { propertyValueTypeValues };
