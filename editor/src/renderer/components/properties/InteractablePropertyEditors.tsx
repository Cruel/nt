import { useMemo } from 'react';
import { resolveArchetypeConfiguration } from '../../../shared/project-schema/authoring-archetypes';
import {
  effectiveInteractableFeatureProperties,
  effectiveInteractableFeatureTraits,
  effectiveInteractableInstanceProperties,
  effectiveInteractableInstanceTraits,
} from '../../../shared/project-schema/authoring-interactable-properties';
import {
  parseInteractableData,
  type InteractableInstanceData,
} from '../../../shared/project-schema/authoring-interactables';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  arePropertySchemasCompatible,
  type OwnerDefaultProperty,
  type OwnerLocalProperty,
} from '../../../shared/project-schema/authoring-properties';
import { ownerLocalPropertyReferences } from '@/project/owner-local-property-references';
import { useEntityUsagesStore } from '@/project/entity-usages-store';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { OwnerDefaultPropertiesEditor } from './OwnerDefaultPropertiesEditor';
import { PropertyManager, type PropertyManagerRow } from './PropertyManager';
import {
  newTypedPropertyDraft,
  ownerLocalPropertyFromDraft,
  typedPropertyValueFromDraft,
  type TypedPropertyDraft,
} from './TypedPropertyFields';

function traitChoices(project: AuthoringProject, attached: readonly string[]) {
  return Object.entries(project.traits)
    .filter(([id, trait]) => !attached.includes(id) && trait.ownerKinds.includes('interactable'))
    .sort(([, left], [, right]) => left.label.localeCompare(right.label));
}

export function InteractableDefinitionPropertiesEditor({
  project,
  definitionId,
  properties,
  attachedTraits,
  onChange,
}: {
  project: AuthoringProject;
  definitionId: string;
  properties: readonly OwnerDefaultProperty[];
  attachedTraits: readonly string[];
  onChange: (state: { properties: OwnerDefaultProperty[]; traits: string[] }) => void;
}) {
  const record = project.interactables[definitionId];
  const inheritedConfiguration = useMemo(() => {
    if (!record?.archetype) return null;
    return resolveArchetypeConfiguration(project, record.archetype.$ref.id);
  }, [project, record?.archetype]);
  const inheritedProperties = useMemo(() => {
    if (!record?.archetype) return [];
    return (inheritedConfiguration?.defaultProperties ?? []).map((property) => ({
      property,
      sourceLabel: project.archetypes[record.archetype!.$ref.id]?.label ?? 'Archetype',
    }));
  }, [inheritedConfiguration, project.archetypes, record?.archetype]);

  return (
    <OwnerDefaultPropertiesEditor
      ownerLabel={`Interactable definition '${record?.label ?? definitionId}'`}
      ownerKind="interactable"
      traits={project.traits}
      attachedTraits={attachedTraits}
      properties={properties}
      inheritedProperties={inheritedProperties}
      inheritedTraits={inheritedConfiguration?.traits ?? []}
      traitColorFor={(traitId) => project.editor.recordMetadata.traits?.[traitId]?.color ?? null}
      onChange={onChange}
    />
  );
}

export function InteractableInstancePropertiesEditor({
  project,
  instanceId,
  instance,
  onChange,
  compact = false,
}: {
  project: AuthoringProject;
  instanceId: string;
  instance: InteractableInstanceData;
  onChange: (
    instance: InteractableInstanceData,
    change?: { kind: 'rename'; fromId: string; toId: string },
  ) => void;
  compact?: boolean;
}) {
  const setUsages = useEntityUsagesStore((state) => state.setUsages);
  const setActiveBottomPanel = useBottomPanelStore((state) => state.setActivePanelId);
  const effectiveRows = useMemo(
    () => effectiveInteractableInstanceProperties(project, instance),
    [instance, project],
  );
  const usagesById = useMemo(
    () =>
      new Map(
        effectiveRows.map((row) => [
          row.id,
          ownerLocalPropertyReferences(project, { kind: 'interactable', id: instanceId }, row.id),
        ]),
      ),
    [effectiveRows, instanceId, project],
  );
  const effectiveTraits = useMemo(
    () => effectiveInteractableInstanceTraits(project, instance),
    [instance, project],
  );
  const definitionTraits = useMemo(
    () =>
      new Set(
        effectiveInteractableInstanceTraits(project, {
          ...instance,
          traits: { add: [], remove: [] },
        }),
      ),
    [instance, project],
  );
  const availableTraits = useMemo(
    () => traitChoices(project, effectiveTraits),
    [effectiveTraits, project],
  );
  const localById = useMemo(
    () => new Map(instance.localProperties.map((property) => [property.id, property])),
    [instance.localProperties],
  );
  const rows = useMemo<PropertyManagerRow[]>(
    () =>
      effectiveRows.map((row) => {
        const hasOverride = !row.localOnly && row.localProperty !== undefined;
        return {
          id: row.id,
          label: row.contract.label,
          description: row.contract.description,
          type: row.contract.type,
          nullable: row.contract.nullable,
          enumValues: row.contract.enumValues,
          ...(row.value === undefined ? {} : { value: row.value }),
          valueState: row.hasValue ? 'normal' : 'missing',
          usageCount: usagesById.get(row.id)?.length ?? 0,
          sourceLabel: row.localOnly
            ? 'local'
            : hasOverride
              ? 'override'
              : row.hasValue
                ? row.source
                : 'required',
          traitSources: row.traitIds.map((traitId) => ({
            id: traitId,
            label: project.traits[traitId]?.label ?? traitId,
            color: project.editor.recordMetadata.traits?.[traitId]?.color ?? null,
          })),
          appearance: row.localOnly ? 'local-only' : 'normal',
          editMode: row.localOnly ? 'schema' : 'value',
          actionLabel: row.localOnly ? undefined : 'Set Value',
          resettable: hasOverride,
          deletable: row.localOnly,
        };
      }),
    [effectiveRows, project.editor.recordMetadata.traits, project.traits, usagesById],
  );

  const withTraitSet = (traitIds: readonly string[]): InteractableInstanceData['traits'] => ({
    add: traitIds.filter((id) => !definitionTraits.has(id)),
    remove: [...definitionTraits].filter((id) => !traitIds.includes(id)),
  });

  const createProperty = (draft: TypedPropertyDraft) => {
    const parsed = ownerLocalPropertyFromDraft(draft);
    if (!parsed.ok) return parsed.message;
    if (effectiveRows.some((row) => row.id === parsed.property.id))
      return `Property '${parsed.property.id}' is already effective. Edit or override the existing row instead.`;
    onChange({ ...instance, localProperties: [...instance.localProperties, parsed.property] });
    return null;
  };

  const editProperty = (row: PropertyManagerRow, draft: TypedPropertyDraft) => {
    const parsed = ownerLocalPropertyFromDraft(draft);
    if (!parsed.ok) return parsed.message;
    if (
      instance.localProperties.some(
        (property) => property.id === parsed.property.id && property.id !== row.id,
      )
    )
      return `Property '${parsed.property.id}' already exists on this Instance.`;
    if (!localById.has(row.id)) return 'Instance-local Property no longer exists.';
    onChange(
      {
        ...instance,
        localProperties: instance.localProperties.map((property) =>
          property.id === row.id ? parsed.property : property,
        ),
      },
      row.id === parsed.property.id
        ? undefined
        : { kind: 'rename', fromId: row.id, toId: parsed.property.id },
    );
    return null;
  };

  const setValue = (row: PropertyManagerRow, draft: TypedPropertyDraft) => {
    const effective = effectiveRows.find((candidate) => candidate.id === row.id);
    if (!effective || effective.localOnly) return 'Inherited Property no longer exists.';
    const parsed = typedPropertyValueFromDraft(draft);
    if (!parsed.ok) return parsed.message;
    const contract = effective.contract;
    const replacement: OwnerLocalProperty = {
      id: contract.id,
      ...(contract.label ? { label: contract.label } : {}),
      ...(contract.description ? { description: contract.description } : {}),
      type: contract.type,
      nullable: contract.nullable,
      value: parsed.value,
      ...(contract.enumValues ? { enumValues: [...contract.enumValues] } : {}),
    };
    onChange({
      ...instance,
      localProperties: localById.has(row.id)
        ? instance.localProperties.map((property) =>
            property.id === row.id ? replacement : property,
          )
        : [...instance.localProperties, replacement],
    });
    return null;
  };

  const attachTrait = (traitId: string) => {
    const trait = project.traits[traitId];
    if (!trait) return 'Trait no longer exists.';
    for (const member of trait.properties) {
      const existing = effectiveRows.find((row) => row.id === member.id);
      if (existing && !arePropertySchemasCompatible(existing.contract, member))
        return `Cannot attach '${trait.label}': Property '${member.id}' has an incompatible effective schema.`;
    }
    const nextTraits = [...effectiveTraits, traitId];
    onChange({ ...instance, traits: withTraitSet(nextTraits) });
    return null;
  };

  return (
    <PropertyManager
      title="Instance Properties"
      description={`Exact state for '${instanceId}'.`}
      valueLabel="Value"
      rows={rows}
      emptyLabel="No Properties."
      addLabel="Add Property"
      createTitle="Add Instance Property"
      editTitle={(row) => `Edit ${row.label ?? row.id}`}
      valueEditTitle={() => 'Set Instance Value'}
      editDescription={(row) =>
        row?.editMode === 'value'
          ? 'Overrides the inherited effective Value for this exact Instance.'
          : 'A completely Instance-local typed Property and concrete Value.'
      }
      newDraft={newTypedPropertyDraft}
      onCreate={createProperty}
      onEdit={editProperty}
      onSetValue={setValue}
      onReset={(row) => {
        onChange({
          ...instance,
          localProperties: instance.localProperties.filter((property) => property.id !== row.id),
        });
        return null;
      }}
      onDelete={(row) => {
        onChange({
          ...instance,
          localProperties: instance.localProperties.filter((property) => property.id !== row.id),
        });
        return null;
      }}
      onShowUsages={(row) => {
        setUsages(
          { collection: 'interactables', id: instance.definition.$ref.id },
          usagesById.get(row.id) ?? [],
          `interactable-instance/${instanceId} · ${row.id}`,
        );
        setActiveBottomPanel('references');
      }}
      traits={{
        attached: effectiveTraits.map((id) => ({
          id,
          label: project.traits[id]?.label ?? id,
          color: project.editor.recordMetadata.traits?.[id]?.color ?? null,
          inherited: definitionTraits.has(id),
          removable: true,
        })),
        available: availableTraits.map(([id, trait]) => ({
          id,
          label: trait.label,
          color: project.editor.recordMetadata.traits?.[id]?.color ?? null,
        })),
        onAttach: attachTrait,
        onDetach: (traitId) => {
          onChange({
            ...instance,
            traits: withTraitSet(effectiveTraits.filter((candidate) => candidate !== traitId)),
          });
          return null;
        },
      }}
      compact={compact}
      anchor={`instance.properties.${instanceId}`}
      rowAnchor={(row) => `instance.property.${instanceId}.${row.id}`}
      modeMarker="instance"
    />
  );
}

export function InteractableInstanceFeatureOverridesEditor({
  project,
  instanceId,
  instance,
  featureId,
  featureLabel,
  onChange,
}: {
  project: AuthoringProject;
  instanceId: string;
  instance: InteractableInstanceData;
  featureId: string;
  featureLabel: string;
  onChange: (instance: InteractableInstanceData) => void;
}) {
  const effectiveRows = useMemo(
    () => effectiveInteractableFeatureProperties(project, instance, featureId),
    [featureId, instance, project],
  );
  const effectiveTraits = useMemo(
    () => effectiveInteractableFeatureTraits(project, instance, featureId),
    [featureId, instance, project],
  );
  const definition = project.interactables[instance.definition.$ref.id];
  const feature = parseInteractableData(definition?.data)?.features.find(
    (candidate) => candidate.id === featureId,
  );
  const inheritedTraits = useMemo(() => new Set(feature?.traits ?? []), [feature?.traits]);
  const availableTraits = useMemo(
    () =>
      Object.entries(project.traits)
        .filter(
          ([id, trait]) => !effectiveTraits.includes(id) && trait.ownerKinds.includes('feature'),
        )
        .sort(([, left], [, right]) => left.label.localeCompare(right.label)),
    [effectiveTraits, project.traits],
  );
  const override = instance.featureOverrides.find((candidate) => candidate.featureId === featureId);
  const rows = useMemo<PropertyManagerRow[]>(
    () =>
      effectiveRows.map((row) => ({
        id: row.id,
        label: row.contract.label,
        description: row.contract.description,
        type: row.contract.type,
        nullable: row.contract.nullable,
        enumValues: row.contract.enumValues,
        ...(row.value === undefined ? {} : { value: row.value }),
        valueState: row.hasValue ? 'normal' : 'missing',
        sourceLabel: row.overridden ? 'override' : row.hasValue ? row.source : 'required',
        traitSources: row.traitIds.map((traitId) => ({
          id: traitId,
          label: project.traits[traitId]?.label ?? traitId,
          color: project.editor.recordMetadata.traits?.[traitId]?.color ?? null,
        })),
        appearance: 'normal',
        editMode: 'value',
        actionLabel: 'Set Value',
        resettable: row.overridden,
        deletable: false,
      })),
    [effectiveRows, project.editor.recordMetadata.traits, project.traits],
  );

  const commitOverride = (
    nextTraits: InteractableInstanceData['featureOverrides'][number]['traits'],
    nextProperties: InteractableInstanceData['featureOverrides'][number]['properties'],
  ) => {
    const remaining = instance.featureOverrides.filter(
      (candidate) => candidate.featureId !== featureId,
    );
    const nextOverride = {
      featureId,
      traits: nextTraits,
      properties: nextProperties,
    };
    onChange({
      ...instance,
      featureOverrides:
        nextTraits.add.length || nextTraits.remove.length || nextProperties.length
          ? [...remaining, nextOverride]
          : remaining,
    });
  };
  const withTraitSet = (traitIds: readonly string[]) => ({
    add: traitIds.filter((id) => !inheritedTraits.has(id)),
    remove: [...inheritedTraits].filter((id) => !traitIds.includes(id)),
  });

  return (
    <PropertyManager
      title={featureLabel}
      description={`Exact Feature state for '${instanceId}#${featureId}'.`}
      valueLabel="Value"
      rows={rows}
      emptyLabel="No Feature Properties."
      valueEditTitle={() => 'Set Feature Value'}
      editDescription={() => 'Overrides the inherited effective Value for this exact Feature.'}
      onSetValue={(row, draft) => {
        const effective = effectiveRows.find((candidate) => candidate.id === row.id);
        if (!effective) return 'Feature Property no longer exists.';
        const parsed = typedPropertyValueFromDraft(draft);
        if (!parsed.ok) return parsed.message;
        const properties = [
          ...(override?.properties ?? []).filter((property) => property.propertyId !== row.id),
          { propertyId: row.id, value: parsed.value },
        ];
        commitOverride(override?.traits ?? { add: [], remove: [] }, properties);
        return null;
      }}
      onReset={(row) => {
        commitOverride(
          override?.traits ?? { add: [], remove: [] },
          (override?.properties ?? []).filter((property) => property.propertyId !== row.id),
        );
        return null;
      }}
      traits={{
        attached: effectiveTraits.map((id) => ({
          id,
          label: project.traits[id]?.label ?? id,
          color: project.editor.recordMetadata.traits?.[id]?.color ?? null,
          inherited: inheritedTraits.has(id),
          removable: true,
        })),
        available: availableTraits.map(([id, trait]) => ({
          id,
          label: trait.label,
          color: project.editor.recordMetadata.traits?.[id]?.color ?? null,
        })),
        onAttach: (traitId) => {
          const trait = project.traits[traitId];
          if (!trait) return 'Trait no longer exists.';
          for (const member of trait.properties) {
            const existing = effectiveRows.find((row) => row.id === member.id);
            if (existing && !arePropertySchemasCompatible(existing.contract, member))
              return `Cannot attach '${trait.label}': Property '${member.id}' has an incompatible effective schema.`;
          }
          commitOverride(withTraitSet([...effectiveTraits, traitId]), override?.properties ?? []);
          return null;
        },
        onDetach: (traitId) => {
          commitOverride(
            withTraitSet(effectiveTraits.filter((candidate) => candidate !== traitId)),
            override?.properties ?? [],
          );
          return null;
        },
      }}
      compact
      anchor={`instance.feature.${instanceId}.${featureId}`}
      rowAnchor={(row) => `instance.feature.property.${instanceId}.${featureId}.${row.id}`}
      modeMarker="instance-feature"
    />
  );
}
