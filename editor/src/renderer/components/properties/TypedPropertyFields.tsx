import { parseEnumValuesText } from '../../../shared/project-schema/authoring-variables';
import { PropertySchemaFields } from './PropertySchemaFields';
import { PropertyValueInput } from './PropertyValueInput';
import type { TypedPropertyDraft } from './property-editor-draft';

export {
  newTypedPropertyDraft,
  ownerDefaultPropertyFromDraft,
  ownerLocalPropertyFromDraft,
  propertyTypeLabel,
  typedPropertyDraftForSchema,
  typedPropertyDraftFromOwnerDefault,
  typedPropertyDraftFromOwnerLocal,
  typedPropertyValueFromDraft,
} from './property-editor-draft';
export type { TypedPropertyDraft } from './property-editor-draft';

export function TypedPropertyFields({
  draft,
  onChange,
  idLabel,
  valueLabel,
  valueOptional = false,
  descriptionPlaceholder,
  schemaReadOnly = false,
}: {
  draft: TypedPropertyDraft;
  onChange: (draft: TypedPropertyDraft) => void;
  idLabel?: string;
  valueLabel?: string;
  valueOptional?: boolean;
  descriptionPlaceholder?: string;
  schemaReadOnly?: boolean;
}) {
  return (
    <>
      <PropertySchemaFields
        draft={draft}
        onChange={onChange}
        idLabel={idLabel}
        descriptionPlaceholder={descriptionPlaceholder}
        readOnly={schemaReadOnly}
      />
      <PropertyValueInput
        schema={{
          type: draft.type,
          nullable: draft.nullable,
          ...(draft.type === 'enum' ? { enumValues: parseEnumValuesText(draft.enumText) } : {}),
        }}
        valueText={draft.valueText}
        onValueTextChange={(valueText) => onChange({ ...draft, valueText })}
        label={valueLabel}
        optional={valueOptional}
        present={draft.valuePresent}
        onPresentChange={(valuePresent) => onChange({ ...draft, valuePresent })}
      />
    </>
  );
}
