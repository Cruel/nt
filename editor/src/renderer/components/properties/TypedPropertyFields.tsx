import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  propertyValueTypeValues,
  type AuthoredRuntimeValue,
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
    valueText: variableValueToText(property.value),
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

function typeLabel(type: VariableType) {
  if (type === 'boolean') return 'Boolean';
  if (type === 'integer') return 'Integer';
  if (type === 'number') return 'Number';
  if (type === 'string') return 'String';
  return 'Enum';
}

export function TypedPropertyFields({
  draft,
  onChange,
  idLabel = 'ID',
  valueLabel = 'Value',
  descriptionPlaceholder,
}: {
  draft: TypedPropertyDraft;
  onChange: (draft: TypedPropertyDraft) => void;
  idLabel?: string;
  valueLabel?: string;
  descriptionPlaceholder?: string;
}) {
  const changeType = (type: VariableType) => {
    const enumValues = type === 'enum' ? ['default'] : undefined;
    onChange({
      ...draft,
      type,
      enumText: type === 'enum' ? 'default' : draft.enumText,
      valueText: variableValueToText(defaultValueForVariableType(type, enumValues)),
    });
  };

  const enumValues = parseEnumValuesText(draft.enumText);
  const nullSelected = draft.nullable && draft.valueText === 'null';

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{idLabel}</Label>
          <Input
            className="font-mono"
            value={draft.id}
            onChange={(event) => onChange({ ...draft, id: event.currentTarget.value })}
            placeholder="has-key"
          />
        </div>
        <div className="space-y-1.5">
          <Label>
            Label <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            value={draft.label}
            onChange={(event) => onChange({ ...draft, label: event.currentTarget.value })}
            placeholder="Uses the ID when empty"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          value={draft.description}
          onChange={(event) => onChange({ ...draft, description: event.currentTarget.value })}
          placeholder={descriptionPlaceholder}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-[180px_120px_1fr]">
        <div className="space-y-1.5">
          <Label>Type</Label>
          <Select
            value={draft.type}
            onValueChange={(value) => value && changeType(value as VariableType)}
          >
            <SelectTrigger className="!h-8 w-full" aria-label="Type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {propertyValueTypeValues.map((type) => (
                <SelectItem key={type} value={type}>
                  {typeLabel(type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Nullable</Label>
          <div className="flex h-8 items-center gap-2">
            <Switch
              checked={draft.nullable}
              onCheckedChange={(nullable) =>
                onChange({
                  ...draft,
                  nullable,
                  valueText:
                    !nullable && draft.valueText === 'null'
                      ? variableValueToText(defaultValueForVariableType(draft.type, enumValues))
                      : draft.valueText,
                })
              }
              aria-label="Nullable"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>{valueLabel}</Label>
          {draft.nullable ? (
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={nullSelected}
                onCheckedChange={(checked) =>
                  onChange({
                    ...draft,
                    valueText: checked
                      ? 'null'
                      : variableValueToText(defaultValueForVariableType(draft.type, enumValues)),
                  })
                }
                aria-label={`${valueLabel} is null`}
              />
              Null
            </div>
          ) : null}
          {!nullSelected ? (
            draft.type === 'boolean' ? (
              <div className="flex h-8 items-center gap-2">
                <Switch
                  checked={draft.valueText === 'true'}
                  onCheckedChange={(checked) => onChange({ ...draft, valueText: String(checked) })}
                  aria-label={valueLabel}
                />
                <span className="text-sm text-muted-foreground">{draft.valueText}</span>
              </div>
            ) : draft.type === 'enum' ? (
              <Select
                value={draft.valueText}
                onValueChange={(value) => value && onChange({ ...draft, valueText: value })}
              >
                <SelectTrigger className="!h-8 w-full" aria-label={valueLabel}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {enumValues.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                className="h-8"
                type={draft.type === 'integer' || draft.type === 'number' ? 'number' : 'text'}
                step={draft.type === 'integer' ? 1 : draft.type === 'number' ? 'any' : undefined}
                value={draft.valueText}
                onChange={(event) => onChange({ ...draft, valueText: event.currentTarget.value })}
              />
            )
          ) : null}
        </div>
      </div>

      {draft.type === 'enum' ? (
        <div className="space-y-1.5">
          <Label>Enum values</Label>
          <Input
            value={draft.enumText}
            onChange={(event) => {
              const enumText = event.currentTarget.value;
              const values = parseEnumValuesText(enumText);
              onChange({
                ...draft,
                enumText,
                valueText:
                  draft.valueText === 'null' || values.includes(draft.valueText)
                    ? draft.valueText
                    : (values[0] ?? ''),
              });
            }}
            placeholder="idle, active, complete"
          />
        </div>
      ) : null}
    </>
  );
}
