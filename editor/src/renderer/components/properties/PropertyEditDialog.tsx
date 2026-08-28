import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from 'react-i18next';
import { TypedPropertyFields } from './TypedPropertyFields';
import { PropertyValueInput } from './PropertyValueInput';
import { parseEnumValuesText } from '../../../shared/project-schema/authoring-variables';
import type { TypedPropertyDraft } from './property-editor-draft';

export function PropertyEditDialog({
  open,
  mode,
  draft,
  title,
  description,
  submitLabel,
  valueLabel,
  valueOptional,
  schemaReadOnly = false,
  descriptionPlaceholder,
  message,
  onDraftChange,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  mode: 'schema' | 'value';
  draft: TypedPropertyDraft;
  title: string;
  description?: string;
  submitLabel: string;
  valueLabel: string;
  valueOptional?: boolean;
  schemaReadOnly?: boolean;
  descriptionPlaceholder?: string;
  message?: string | null;
  onDraftChange: (draft: TypedPropertyDraft) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation('workspace');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-[min(620px,calc(100vw-2rem))]">
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
        {mode === 'schema' ? (
          <TypedPropertyFields
            draft={draft}
            onChange={onDraftChange}
            valueLabel={valueLabel}
            valueOptional={valueOptional}
            schemaReadOnly={schemaReadOnly}
            descriptionPlaceholder={descriptionPlaceholder}
          />
        ) : (
          <PropertyValueInput
            schema={{
              type: draft.type,
              nullable: draft.nullable,
              ...(draft.type === 'enum' ? { enumValues: parseEnumValuesText(draft.enumText) } : {}),
            }}
            valueText={draft.valueText}
            onValueTextChange={(valueText) => onDraftChange({ ...draft, valueText })}
            label={valueLabel}
            optional={valueOptional}
            present={draft.valuePresent}
            onPresentChange={(valuePresent) => onDraftChange({ ...draft, valuePresent })}
          />
        )}
        {message ? <p className="text-xs text-destructive">{message}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('propertyManager.actions.cancel')}
          </Button>
          <Button onClick={onSubmit} disabled={mode === 'schema' && !draft.id.trim()}>
            {submitLabel}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
