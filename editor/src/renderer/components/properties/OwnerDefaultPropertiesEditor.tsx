import { useMemo } from 'react';
import {
  arePropertySchemasCompatible,
  authoredRuntimeValuesEqual,
  type AuthoredRuntimeValue,
  type OwnerDefaultProperty,
  type PropertyOwnerKind,
  type TraitDefinition,
  type TraitProperty,
} from '../../../shared/project-schema/authoring-properties';
import { PropertyManager, type PropertyManagerRow } from './PropertyManager';
import {
  newTypedPropertyDraft,
  ownerDefaultPropertyFromDraft,
  typedPropertyValueFromDraft,
  type TypedPropertyDraft,
} from './TypedPropertyFields';

export interface InheritedDefaultProperty {
  property: OwnerDefaultProperty;
  sourceLabel: string;
}

interface EffectiveRow {
  id: string;
  contract: OwnerDefaultProperty | TraitProperty;
  defaultValue?: AuthoredRuntimeValue;
  source: 'local' | 'inherited' | 'trait';
  sourceLabel: string;
  traitIds: string[];
  inheritedSchema: boolean;
}

function cloneDefault(contract: OwnerDefaultProperty | TraitProperty): OwnerDefaultProperty {
  return {
    id: contract.id,
    ...(contract.label ? { label: contract.label } : {}),
    ...(contract.description ? { description: contract.description } : {}),
    type: contract.type,
    nullable: contract.nullable,
    ...(contract.defaultValue === undefined ? {} : { defaultValue: contract.defaultValue }),
    ...(contract.enumValues ? { enumValues: [...contract.enumValues] } : {}),
  };
}

function buildRows(
  traits: Readonly<Record<string, TraitDefinition>>,
  ownerKind: PropertyOwnerKind,
  attachedTraits: readonly string[],
  inheritedProperties: readonly InheritedDefaultProperty[],
  localProperties: readonly OwnerDefaultProperty[],
): EffectiveRow[] {
  const rows = new Map<string, EffectiveRow>();
  for (const traitId of attachedTraits) {
    const trait = traits[traitId];
    if (!trait || !trait.ownerKinds.includes(ownerKind)) continue;
    for (const property of trait.properties) {
      const existing = rows.get(property.id);
      if (!existing) {
        rows.set(property.id, {
          id: property.id,
          contract: structuredClone(property),
          ...(property.defaultValue === undefined ? {} : { defaultValue: property.defaultValue }),
          source: 'trait',
          sourceLabel: trait.label,
          traitIds: [traitId],
          inheritedSchema: true,
        });
        continue;
      }
      if (!arePropertySchemasCompatible(existing.contract, property)) continue;
      existing.traitIds.push(traitId);
      existing.sourceLabel = existing.traitIds.map((id) => traits[id]?.label ?? id).join(', ');
      if (existing.defaultValue === undefined && property.defaultValue !== undefined)
        existing.defaultValue = property.defaultValue;
      else if (
        existing.defaultValue !== undefined &&
        property.defaultValue !== undefined &&
        !authoredRuntimeValuesEqual(existing.defaultValue, property.defaultValue)
      )
        delete existing.defaultValue;
    }
  }
  for (const inherited of inheritedProperties) {
    const existing = rows.get(inherited.property.id);
    rows.set(inherited.property.id, {
      id: inherited.property.id,
      contract: structuredClone(inherited.property),
      ...(inherited.property.defaultValue === undefined
        ? existing?.defaultValue === undefined
          ? {}
          : { defaultValue: existing.defaultValue }
        : { defaultValue: inherited.property.defaultValue }),
      source: 'inherited',
      sourceLabel: inherited.sourceLabel,
      traitIds: existing?.traitIds ?? [],
      inheritedSchema: true,
    });
  }
  for (const property of localProperties) {
    const existing = rows.get(property.id);
    rows.set(property.id, {
      id: property.id,
      contract: structuredClone(property),
      ...(property.defaultValue === undefined
        ? existing?.defaultValue === undefined
          ? {}
          : { defaultValue: existing.defaultValue }
        : { defaultValue: property.defaultValue }),
      source: 'local',
      sourceLabel: 'local',
      traitIds: existing?.traitIds ?? [],
      inheritedSchema: existing?.inheritedSchema ?? false,
    });
  }
  return [...rows.values()];
}

export function OwnerDefaultPropertiesEditor({
  ownerLabel,
  ownerKind,
  properties,
  inheritedProperties = [],
  inheritedTraits = [],
  attachedTraits,
  traits,
  onChange,
  usageCountFor,
  traitColorFor,
}: {
  ownerLabel: string;
  ownerKind: PropertyOwnerKind;
  properties: readonly OwnerDefaultProperty[];
  inheritedProperties?: readonly InheritedDefaultProperty[];
  inheritedTraits?: readonly string[];
  attachedTraits: readonly string[];
  traits: Readonly<Record<string, TraitDefinition>>;
  onChange: (state: { properties: OwnerDefaultProperty[]; traits: string[] }) => void;
  usageCountFor?: (propertyId: string) => number;
  traitColorFor?: (traitId: string) => string | null;
}) {
  const effectiveRows = useMemo(
    () => buildRows(traits, ownerKind, attachedTraits, inheritedProperties, properties),
    [attachedTraits, inheritedProperties, ownerKind, properties, traits],
  );
  const localById = useMemo(() => new Map(properties.map((item) => [item.id, item])), [properties]);
  const localTraitIds = useMemo(
    () => attachedTraits.filter((id) => !inheritedTraits.includes(id)),
    [attachedTraits, inheritedTraits],
  );
  const effectiveTraits = (localIds: readonly string[]) => [
    ...inheritedTraits,
    ...localIds.filter((id) => !inheritedTraits.includes(id)),
  ];
  const availableTraits = useMemo(
    () =>
      Object.entries(traits)
        .filter(
          ([id, trait]) => !attachedTraits.includes(id) && trait.ownerKinds.includes(ownerKind),
        )
        .sort(([, left], [, right]) => left.label.localeCompare(right.label)),
    [attachedTraits, ownerKind, traits],
  );
  const rows = useMemo<PropertyManagerRow[]>(
    () =>
      effectiveRows.map((row) => {
        const local = localById.get(row.id);
        return {
          id: row.id,
          label: row.contract.label,
          description: row.contract.description,
          type: row.contract.type,
          nullable: row.contract.nullable,
          enumValues: row.contract.enumValues,
          ...(row.defaultValue === undefined ? {} : { value: row.defaultValue }),
          valueState: row.defaultValue === undefined ? 'missing' : 'normal',
          sourceLabel: row.sourceLabel,
          usageCount: usageCountFor?.(row.id) ?? 0,
          traitSources: row.traitIds.map((traitId) => ({
            id: traitId,
            label: traits[traitId]?.label ?? traitId,
            color: traitColorFor?.(traitId) ?? null,
          })),
          editMode: row.inheritedSchema ? 'value' : 'schema',
          actionLabel: row.inheritedSchema ? (local ? 'Edit Default' : 'Set Default') : undefined,
          resettable: !!local && row.inheritedSchema,
          deletable: !!local && !row.inheritedSchema,
        };
      }),
    [effectiveRows, localById, traitColorFor, traits, usageCountFor],
  );

  const createProperty = (draft: TypedPropertyDraft) => {
    const parsed = ownerDefaultPropertyFromDraft(draft);
    if (!parsed.ok) return parsed.message;
    if (effectiveRows.some((row) => row.id === parsed.property.id))
      return `Property '${parsed.property.id}' is already effective. Edit the existing row instead.`;
    onChange({
      properties: [...properties, parsed.property],
      traits: effectiveTraits(localTraitIds),
    });
    return null;
  };

  const editProperty = (row: PropertyManagerRow, draft: TypedPropertyDraft) => {
    const parsed = ownerDefaultPropertyFromDraft(draft);
    if (!parsed.ok) return parsed.message;
    if (properties.some((item) => item.id === parsed.property.id && item.id !== row.id))
      return `Property '${parsed.property.id}' already exists on this owner.`;
    const local = localById.get(row.id);
    if (!local) return 'Property no longer exists.';
    onChange({
      properties: properties.map((item) => (item.id === row.id ? parsed.property : item)),
      traits: effectiveTraits(localTraitIds),
    });
    return null;
  };

  const setDefault = (row: PropertyManagerRow, draft: TypedPropertyDraft) => {
    const effective = effectiveRows.find((candidate) => candidate.id === row.id);
    if (!effective) return 'Property no longer exists.';
    if (!draft.valuePresent) {
      onChange({
        properties: properties.filter((item) => item.id !== row.id),
        traits: effectiveTraits(localTraitIds),
      });
      return null;
    }
    const parsed = typedPropertyValueFromDraft(draft);
    if (!parsed.ok) return parsed.message;
    const replacement: OwnerDefaultProperty = {
      ...cloneDefault(effective.contract),
      defaultValue: parsed.value,
    };
    const local = localById.get(row.id);
    onChange({
      properties: local
        ? properties.map((item) => (item.id === row.id ? replacement : item))
        : [...properties, replacement],
      traits: effectiveTraits(localTraitIds),
    });
    return null;
  };

  const attachTrait = (traitId: string) => {
    const trait = traits[traitId];
    if (!trait) return 'Trait no longer exists.';
    for (const member of trait.properties) {
      const row = effectiveRows.find((candidate) => candidate.id === member.id);
      if (row && !arePropertySchemasCompatible(row.contract, member))
        return `Cannot attach '${trait.label}': Property '${member.id}' has an incompatible effective schema.`;
      if (
        member.defaultValue !== undefined &&
        row?.source === 'trait' &&
        row.defaultValue !== undefined &&
        !authoredRuntimeValuesEqual(member.defaultValue, row.defaultValue)
      )
        return `Cannot attach '${trait.label}': Property '${member.id}' has a conflicting Trait Default.`;
    }
    onChange({
      properties: [...properties],
      traits: effectiveTraits([...localTraitIds, traitId]),
    });
    return null;
  };

  return (
    <PropertyManager
      title="Properties"
      description={`Typed Property schemas and optional Defaults for ${ownerLabel}.`}
      valueLabel="Default"
      valueOptional
      rows={rows}
      emptyLabel="No Property contracts."
      addLabel="Add Property"
      createTitle="Add Property"
      editDescription={(row) =>
        row?.editMode === 'value'
          ? 'The inherited Property schema is read-only. This owner may provide a more-specific Default.'
          : 'Reusable Property contracts may omit their Default until a more-specific consumer supplies one.'
      }
      newDraft={newTypedPropertyDraft}
      onCreate={createProperty}
      onEdit={editProperty}
      onSetValue={setDefault}
      onReset={(row) => {
        onChange({
          properties: properties.filter((item) => item.id !== row.id),
          traits: effectiveTraits(localTraitIds),
        });
        return null;
      }}
      onDelete={(row) => {
        onChange({
          properties: properties.filter((item) => item.id !== row.id),
          traits: effectiveTraits(localTraitIds),
        });
        return null;
      }}
      traits={{
        attached: attachedTraits.map((id) => ({
          id,
          label: traits[id]?.label ?? id,
          color: traitColorFor?.(id) ?? null,
          inherited: inheritedTraits.includes(id),
          removable: !inheritedTraits.includes(id),
        })),
        available: availableTraits.map(([id, trait]) => ({
          id,
          label: trait.label,
          color: traitColorFor?.(id) ?? null,
        })),
        onAttach: attachTrait,
        onDetach: (traitId) => {
          onChange({
            properties: [...properties],
            traits: effectiveTraits(localTraitIds.filter((candidate) => candidate !== traitId)),
          });
          return null;
        },
      }}
      modeMarker="default"
    />
  );
}
