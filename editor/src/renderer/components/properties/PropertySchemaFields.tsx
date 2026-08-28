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
  parseEnumValuesText,
  variableValueToText,
  type VariableType,
} from '../../../shared/project-schema/authoring-variables';
import { propertyValueTypeValues, type TypedPropertyDraft } from './property-editor-draft';

export function PropertySchemaFields({
  draft,
  onChange,
  idLabel,
  descriptionPlaceholder,
  readOnly = false,
}: {
  draft: TypedPropertyDraft;
  onChange: (draft: TypedPropertyDraft) => void;
  idLabel?: string;
  descriptionPlaceholder?: string;
  readOnly?: boolean;
}) {
  const { t } = useTranslation('workspace');
  const resolvedIdLabel = idLabel ?? t('propertyManager.fields.id');
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

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{resolvedIdLabel}</Label>
          <Input
            className="font-mono"
            value={draft.id}
            onChange={(event) => onChange({ ...draft, id: event.currentTarget.value })}
            placeholder="has-key"
            disabled={readOnly}
          />
        </div>
        <div className="space-y-1.5">
          <Label>
            {t('propertyManager.fields.label')}{' '}
            <span className="font-normal text-muted-foreground">
              {t('propertyManager.fields.optional')}
            </span>
          </Label>
          <Input
            value={draft.label}
            onChange={(event) => onChange({ ...draft, label: event.currentTarget.value })}
            placeholder={t('propertyManager.fields.labelPlaceholder')}
            disabled={readOnly}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>
          {t('propertyManager.fields.description')}{' '}
          <span className="font-normal text-muted-foreground">
            {t('propertyManager.fields.optional')}
          </span>
        </Label>
        <Input
          value={draft.description}
          onChange={(event) => onChange({ ...draft, description: event.currentTarget.value })}
          placeholder={descriptionPlaceholder}
          disabled={readOnly}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-[180px_120px]">
        <div className="space-y-1.5">
          <Label>{t('propertyManager.fields.type')}</Label>
          <Select
            value={draft.type}
            disabled={readOnly}
            onValueChange={(value) => value && changeType(value as VariableType)}
          >
            <SelectTrigger className="!h-8 w-full" aria-label={t('propertyManager.fields.type')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {propertyValueTypeValues.map((type) => (
                <SelectItem key={type} value={type}>
                  {t(`propertyManager.types.${type}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{t('propertyManager.fields.nullable')}</Label>
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
              aria-label={t('propertyManager.fields.nullable')}
              disabled={readOnly}
            />
          </div>
        </div>
      </div>

      {draft.type === 'enum' ? (
        <div className="space-y-1.5">
          <Label>{t('propertyManager.fields.enumValues')}</Label>
          <Input
            value={draft.enumText}
            disabled={readOnly}
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
