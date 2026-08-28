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
import { useTranslation } from 'react-i18next';
import {
  defaultValueForVariableType,
  variableValueToText,
} from '../../../shared/project-schema/authoring-variables';
import type { VariableType } from '../../../shared/project-schema/authoring-variables';

export interface PropertyValueSchema {
  type: VariableType;
  nullable: boolean;
  enumValues?: readonly string[];
}

export function PropertyValueInput({
  schema,
  valueText,
  onValueTextChange,
  label,
  optional = false,
  present = true,
  onPresentChange,
  disabled = false,
}: {
  schema: PropertyValueSchema;
  valueText: string;
  onValueTextChange: (value: string) => void;
  label?: string;
  optional?: boolean;
  present?: boolean;
  onPresentChange?: (present: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('workspace');
  const resolvedLabel = label ?? t('propertyManager.fields.value');
  const enumValues = [...(schema.enumValues ?? [])];
  const nullSelected = schema.nullable && valueText === 'null';
  const fallback = () => variableValueToText(defaultValueForVariableType(schema.type, enumValues));

  return (
    <div className="space-y-1.5">
      <Label>{resolvedLabel}</Label>
      {optional ? (
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={present}
            onCheckedChange={onPresentChange}
            aria-label={t('propertyManager.fields.hasValue', { label: resolvedLabel })}
            disabled={disabled}
          />
          {t('propertyManager.fields.hasValue', { label: resolvedLabel })}
        </div>
      ) : null}
      {present && schema.nullable ? (
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={nullSelected}
            onCheckedChange={(checked) => onValueTextChange(checked ? 'null' : fallback())}
            aria-label={t('propertyManager.fields.valueIsNull', { label: resolvedLabel })}
            disabled={disabled}
          />
          {t('propertyManager.values.nullLabel')}
        </div>
      ) : null}
      {present && !nullSelected ? (
        schema.type === 'boolean' ? (
          <div className="flex h-8 items-center gap-2">
            <Switch
              checked={valueText === 'true'}
              onCheckedChange={(checked) => onValueTextChange(String(checked))}
              aria-label={resolvedLabel}
              disabled={disabled}
            />
            <span className="text-sm text-muted-foreground">{valueText}</span>
          </div>
        ) : schema.type === 'enum' ? (
          <Select
            value={valueText}
            onValueChange={(value) => value && onValueTextChange(value)}
            disabled={disabled}
          >
            <SelectTrigger className="!h-8 w-full" aria-label={resolvedLabel}>
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
            type={schema.type === 'integer' || schema.type === 'number' ? 'number' : 'text'}
            step={schema.type === 'integer' ? 1 : schema.type === 'number' ? 'any' : undefined}
            value={valueText}
            onChange={(event) => onValueTextChange(event.currentTarget.value)}
            disabled={disabled}
            aria-label={resolvedLabel}
          />
        )
      ) : null}
    </div>
  );
}
