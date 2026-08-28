import { useMemo } from 'react';
import {
  arePropertySchemasCompatible,
  authoredRuntimeValuesEqual,
  type AuthoredRuntimeValue,
  type OwnerDefaultProperty,
  type OwnerLocalProperty,
  type PropertyOwnerKind,
  type TraitDefinition,
  type TraitProperty,
} from '../../../shared/project-schema/authoring-properties';
import { PropertyManager, type PropertyManagerRow } from './PropertyManager';
import type { InheritedDefaultProperty } from './OwnerDefaultPropertiesEditor';
import {
  newTypedPropertyDraft,
  ownerLocalPropertyFromDraft,
  typedPropertyValueFromDraft,
  type TypedPropertyDraft,
} from './TypedPropertyFields';

interface TraitSource {
  traitId: string;
  trait: TraitDefinition;
  property: TraitProperty;
}

export interface OwnerPropertyTraitState {
  traits: string[];
  localProperties: OwnerLocalProperty[];
}

function traitSources(
  traits: Readonly<Record<string, TraitDefinition>>,
  attachedTraits: readonly string[],
) {
  const byProperty = new Map<string, TraitSource[]>();
  for (const traitId of attachedTraits) {
    const trait = traits[traitId];
    if (!trait) continue;
    for (const property of trait.properties) {
      const sources = byProperty.get(property.id) ?? [];
      sources.push({ traitId, trait, property });
      byProperty.set(property.id, sources);
    }
  }
  return byProperty;
}

function resolvedTraitDefault(sources: readonly TraitSource[]) {
  const defaults = sources.flatMap((source) =>
    source.property.defaultValue === undefined ? [] : [source.property.defaultValue],
  );
  if (defaults.length === 0) return { kind: 'missing' as const };
  if (defaults.every((value) => authoredRuntimeValuesEqual(value, defaults[0]!)))
    return { kind: 'value' as const, value: defaults[0]! };
  return { kind: 'conflict' as const };
}

function ownerLocalFromContract(
  contract: TraitProperty | OwnerDefaultProperty,
  value: AuthoredRuntimeValue,
): OwnerLocalProperty {
  return {
    id: contract.id,
    ...(contract.label ? { label: contract.label } : {}),
    ...(contract.description ? { description: contract.description } : {}),
    type: contract.type,
    nullable: contract.nullable,
    value,
    ...(contract.enumValues ? { enumValues: [...contract.enumValues] } : {}),
  };
}

export function OwnerLocalPropertiesEditor({
  ownerLabel,
  properties,
  onChange,
  usageCountFor,
  onShowUsages,
  traits = {},
  ownerKind,
  attachedTraits = [],
  inheritedTraits = [],
  inheritedProperties = [],
  traitColorFor,
  onTraitStateChange,
}: {
  ownerLabel: string;
  properties: readonly OwnerLocalProperty[];
  onChange: (
    properties: OwnerLocalProperty[],
    change?: { kind: 'rename'; fromId: string; toId: string },
  ) => void;
  usageCountFor?: (propertyId: string) => number;
  onShowUsages?: (propertyId: string) => void;
  traits?: Readonly<Record<string, TraitDefinition>>;
  ownerKind?: PropertyOwnerKind;
  attachedTraits?: readonly string[];
  inheritedTraits?: readonly string[];
  inheritedProperties?: readonly InheritedDefaultProperty[];
  traitColorFor?: (traitId: string) => string | null;
  onTraitStateChange?: (state: OwnerPropertyTraitState) => void;
}) {
  const sourcesByProperty = useMemo(
    () => traitSources(traits, attachedTraits),
    [attachedTraits, traits],
  );
  const inheritedByProperty = useMemo(
    () => new Map(inheritedProperties.map((entry) => [entry.property.id, entry])),
    [inheritedProperties],
  );
  const localByProperty = useMemo(
    () => new Map(properties.map((property) => [property.id, property])),
    [properties],
  );
  const effectivePropertyIds = useMemo(
    () => [...new Set([...sourcesByProperty.keys(), ...inheritedByProperty.keys()])],
    [inheritedByProperty, sourcesByProperty],
  );
  const localTraitIds = useMemo(
    () => attachedTraits.filter((id) => !inheritedTraits.includes(id)),
    [attachedTraits, inheritedTraits],
  );
  const availableTraits = useMemo(
    () =>
      Object.entries(traits)
        .filter(
          ([traitId, trait]) =>
            !attachedTraits.includes(traitId) &&
            (!ownerKind || trait.ownerKinds.includes(ownerKind)),
        )
        .sort(([, left], [, right]) => left.label.localeCompare(right.label)),
    [attachedTraits, ownerKind, traits],
  );

  const rows = useMemo<PropertyManagerRow[]>(() => {
    const effective = effectivePropertyIds.map((propertyId) => {
      const sources = sourcesByProperty.get(propertyId) ?? [];
      const inherited = inheritedByProperty.get(propertyId);
      const contract = inherited?.property ?? sources[0]!.property;
      const traitFallback = resolvedTraitDefault(sources);
      const fallback =
        inherited?.property.defaultValue !== undefined
          ? { kind: 'value' as const, value: inherited.property.defaultValue }
          : traitFallback;
      const local = localByProperty.get(propertyId);
      const value = local?.value ?? (fallback.kind === 'value' ? fallback.value : undefined);
      const valueState: PropertyManagerRow['valueState'] =
        fallback.kind === 'conflict' && !local
          ? 'conflict'
          : value === undefined
            ? 'missing'
            : 'normal';
      return {
        id: propertyId,
        label: contract.label,
        description: contract.description,
        type: contract.type,
        nullable: contract.nullable,
        enumValues: contract.enumValues,
        ...(value === undefined ? {} : { value }),
        valueState,
        sourceLabel: local ? 'override' : inherited ? inherited.sourceLabel : undefined,
        usageCount: usageCountFor?.(propertyId) ?? 0,
        traitSources: sources.map((source) => ({
          id: source.traitId,
          label: source.trait.label,
          color: traitColorFor?.(source.traitId) ?? null,
        })),
        editMode: 'value' as const,
        actionLabel: 'Set Value',
        resettable: !!local,
      };
    });
    const localOnly = properties
      .filter(
        (property) => !sourcesByProperty.has(property.id) && !inheritedByProperty.has(property.id),
      )
      .map<PropertyManagerRow>((property) => ({
        id: property.id,
        label: property.label,
        description: property.description,
        type: property.type,
        nullable: property.nullable,
        enumValues: property.enumValues,
        value: property.value,
        valueState: 'normal',
        usageCount: usageCountFor?.(property.id) ?? 0,
        editMode: 'schema',
        deletable: true,
      }));
    return [...effective, ...localOnly];
  }, [
    effectivePropertyIds,
    inheritedByProperty,
    localByProperty,
    properties,
    sourcesByProperty,
    traitColorFor,
    usageCountFor,
  ]);

  const createProperty = (draft: TypedPropertyDraft) => {
    const parsed = ownerLocalPropertyFromDraft(draft);
    if (!parsed.ok) return parsed.message;
    if (sourcesByProperty.has(parsed.property.id) || inheritedByProperty.has(parsed.property.id))
      return `Property '${parsed.property.id}' has an inherited schema; set its Value from the existing row.`;
    if (localByProperty.has(parsed.property.id))
      return `Property '${parsed.property.id}' already exists on this owner.`;
    onChange([...properties, parsed.property]);
    return null;
  };

  const editProperty = (row: PropertyManagerRow, draft: TypedPropertyDraft) => {
    const parsed = ownerLocalPropertyFromDraft(draft);
    if (!parsed.ok) return parsed.message;
    if (sourcesByProperty.has(parsed.property.id) || inheritedByProperty.has(parsed.property.id))
      return `Property '${parsed.property.id}' has an inherited schema; set its Value from the existing row.`;
    if (properties.some((property) => property.id === parsed.property.id && property.id !== row.id))
      return `Property '${parsed.property.id}' already exists on this owner.`;
    const previous = localByProperty.get(row.id);
    if (!previous) return 'Property no longer exists.';
    onChange(
      properties.map((property) => (property.id === row.id ? parsed.property : property)),
      row.id === parsed.property.id
        ? undefined
        : { kind: 'rename', fromId: row.id, toId: parsed.property.id },
    );
    return null;
  };

  const setValue = (row: PropertyManagerRow, draft: TypedPropertyDraft) => {
    if (!onTraitStateChange) return 'This Property cannot be overridden here.';
    const sources = sourcesByProperty.get(row.id) ?? [];
    const contract = inheritedByProperty.get(row.id)?.property ?? sources[0]?.property;
    if (!contract) return 'Property schema no longer exists.';
    const parsed = typedPropertyValueFromDraft(draft);
    if (!parsed.ok) return parsed.message;
    const replacement = ownerLocalFromContract(contract, parsed.value);
    const nextProperties = localByProperty.has(row.id)
      ? properties.map((property) => (property.id === row.id ? replacement : property))
      : [...properties, replacement];
    onTraitStateChange({ traits: [...localTraitIds], localProperties: nextProperties });
    return null;
  };

  const attachTrait = (traitId: string) => {
    if (!onTraitStateChange) return 'Traits cannot be attached here.';
    const trait = traits[traitId];
    if (!trait) return 'Trait no longer exists.';
    for (const contract of trait.properties) {
      const existingSources = sourcesByProperty.get(contract.id) ?? [];
      const incompatibleSource = existingSources.find(
        (source) => !arePropertySchemasCompatible(source.property, contract),
      );
      if (incompatibleSource)
        return `Cannot attach '${trait.label}': Property '${contract.id}' is incompatible with Trait '${incompatibleSource.trait.label}'.`;
      if (contract.defaultValue !== undefined) {
        const conflictingDefault = existingSources.find(
          (source) =>
            source.property.defaultValue !== undefined &&
            !authoredRuntimeValuesEqual(source.property.defaultValue, contract.defaultValue!),
        );
        if (conflictingDefault)
          return `Cannot attach '${trait.label}': Property '${contract.id}' has a Default that conflicts with Trait '${conflictingDefault.trait.label}'.`;
      }
      const inherited = inheritedByProperty.get(contract.id)?.property;
      if (inherited && !arePropertySchemasCompatible(inherited, contract))
        return `Cannot attach '${trait.label}': inherited Property '${contract.id}' has an incompatible schema.`;
      const local = localByProperty.get(contract.id);
      if (local && !arePropertySchemasCompatible(local, contract))
        return `Cannot attach '${trait.label}': local Property '${contract.id}' has an incompatible schema.`;
    }
    onTraitStateChange({
      traits: [...localTraitIds, traitId],
      localProperties: [...properties],
    });
    return null;
  };

  return (
    <PropertyManager
      title="Properties"
      description={`Typed state local to ${ownerLabel}, including contracts supplied by attached Traits.`}
      valueLabel="Value"
      rows={rows}
      emptyLabel="No local, inherited, or Trait Properties."
      addLabel="Add Property"
      createTitle="Add Property"
      editDescription={(row) =>
        row?.editMode === 'value'
          ? 'The inherited Property schema is read-only. This owner may provide a more-specific Value.'
          : `This declaration and concrete Value belong only to ${ownerLabel}.`
      }
      newDraft={newTypedPropertyDraft}
      onCreate={createProperty}
      onEdit={editProperty}
      onSetValue={setValue}
      onReset={(row) => {
        if (!onTraitStateChange) return 'This Property cannot be reset here.';
        onTraitStateChange({
          traits: [...localTraitIds],
          localProperties: properties.filter((property) => property.id !== row.id),
        });
        return null;
      }}
      onDelete={(row) => {
        onChange(properties.filter((property) => property.id !== row.id));
        return null;
      }}
      onShowUsages={onShowUsages ? (row) => onShowUsages(row.id) : undefined}
      traits={
        ownerKind && onTraitStateChange
          ? {
              attached: attachedTraits.map((traitId) => ({
                id: traitId,
                label: traits[traitId]?.label ?? traitId,
                color: traitColorFor?.(traitId) ?? null,
                inherited: inheritedTraits.includes(traitId),
                removable: !inheritedTraits.includes(traitId),
              })),
              available: availableTraits.map(([traitId, trait]) => ({
                id: traitId,
                label: trait.label,
                color: traitColorFor?.(traitId) ?? null,
              })),
              onAttach: attachTrait,
              onDetach: (traitId) => {
                onTraitStateChange({
                  traits: attachedTraits
                    .filter((id) => id !== traitId)
                    .filter((id) => !inheritedTraits.includes(id)),
                  localProperties: [...properties],
                });
                return null;
              },
            }
          : undefined
      }
      anchor="properties.local"
      modeMarker="value"
    />
  );
}
