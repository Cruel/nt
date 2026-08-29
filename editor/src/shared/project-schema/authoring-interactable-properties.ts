import {
  resolveArchetypeConfiguration,
  resolveGameplayInstanceRecord,
} from './authoring-archetypes';
import type { InteractableInstanceData } from './authoring-interactables';
import type { AuthoringProject } from './authoring-project';
import {
  arePropertySchemasCompatible,
  authoredRuntimeValuesEqual,
  type AuthoredRuntimeValue,
  type OwnerDefaultProperty,
  type OwnerLocalProperty,
  type TraitProperty,
} from './authoring-properties';

export type InteractablePropertyContract = OwnerDefaultProperty | TraitProperty;

export interface EffectiveInteractableProperty {
  id: string;
  contract: InteractablePropertyContract;
  defaultValue?: AuthoredRuntimeValue;
  source: 'definition' | 'archetype' | 'trait';
  traitIds: string[];
}

export interface EffectiveInteractableInstanceProperty extends EffectiveInteractableProperty {
  value?: AuthoredRuntimeValue;
  hasValue: boolean;
  localOnly: boolean;
  localProperty?: OwnerLocalProperty;
}

export interface EffectiveInteractableFeatureProperty {
  id: string;
  contract: InteractablePropertyContract;
  value?: AuthoredRuntimeValue;
  hasValue: boolean;
  overridden: boolean;
  source: 'feature' | 'trait';
  traitIds: string[];
}

function cloneContract<T extends InteractablePropertyContract>(contract: T): T {
  return structuredClone(contract);
}

function traitProperties(
  project: AuthoringProject,
  traitIds: readonly string[],
  ownerKind: 'interactable' | 'feature' = 'interactable',
): Map<string, EffectiveInteractableProperty> {
  const result = new Map<string, EffectiveInteractableProperty>();
  for (const traitId of traitIds) {
    const trait = project.traits[traitId];
    if (!trait || !trait.ownerKinds.includes(ownerKind)) continue;
    for (const property of trait.properties) {
      const existing = result.get(property.id);
      if (!existing) {
        result.set(property.id, {
          id: property.id,
          contract: cloneContract(property),
          ...(property.defaultValue === undefined ? {} : { defaultValue: property.defaultValue }),
          source: 'trait',
          traitIds: [traitId],
        });
        continue;
      }
      if (!arePropertySchemasCompatible(existing.contract, property)) continue;
      existing.traitIds.push(traitId);
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
  return result;
}

export function effectiveInteractableDefinitionProperties(
  project: AuthoringProject,
  definitionId: string,
): EffectiveInteractableProperty[] {
  const record = project.interactables[definitionId];
  if (!record) return [];
  const effective = resolveGameplayInstanceRecord(project, 'interactable', record);
  const traitIds = effective?.traits ?? record.traits ?? [];
  const byId = traitProperties(project, traitIds);

  if (record.archetype) {
    const archetype = resolveArchetypeConfiguration(project, record.archetype.$ref.id);
    for (const property of archetype?.defaultProperties ?? []) {
      const existing = byId.get(property.id);
      if (existing && !arePropertySchemasCompatible(existing.contract, property)) continue;
      const defaultValue =
        property.defaultValue === undefined ? existing?.defaultValue : property.defaultValue;
      byId.set(property.id, {
        id: property.id,
        contract: cloneContract(property),
        ...(defaultValue === undefined ? {} : { defaultValue }),
        source: 'archetype',
        traitIds: existing?.traitIds ?? [],
      });
    }
  }

  for (const property of record.defaultProperties ?? []) {
    const existing = byId.get(property.id);
    const defaultValue =
      property.defaultValue === undefined ? existing?.defaultValue : property.defaultValue;
    byId.set(property.id, {
      id: property.id,
      contract: cloneContract(property),
      ...(defaultValue === undefined ? {} : { defaultValue }),
      source: 'definition',
      traitIds: existing?.traitIds ?? [],
    });
  }
  return [...byId.values()];
}

export function effectiveInteractableInstanceTraits(
  project: AuthoringProject,
  instance: InteractableInstanceData,
): string[] {
  const definition = project.interactables[instance.definition.$ref.id];
  const effective = definition
    ? resolveGameplayInstanceRecord(project, 'interactable', definition)
    : null;
  const ids = new Set(effective?.traits ?? definition?.traits ?? []);
  for (const id of instance.traits.remove) ids.delete(id);
  for (const id of instance.traits.add) ids.add(id);
  return [...ids];
}

export function effectiveInteractableInstanceProperties(
  project: AuthoringProject,
  instance: InteractableInstanceData,
): EffectiveInteractableInstanceProperty[] {
  const definitionProperties = effectiveInteractableDefinitionProperties(
    project,
    instance.definition.$ref.id,
  );
  const effectiveTraits = effectiveInteractableInstanceTraits(project, instance);
  const traitOnly = traitProperties(project, effectiveTraits);
  const byId = new Map<string, EffectiveInteractableProperty>();
  for (const property of traitOnly.values()) byId.set(property.id, property);
  for (const property of definitionProperties) {
    // Trait-only definition rows must follow the exact Instance's effective Trait set. Definition
    // and Archetype contracts remain independent sources when an Instance removes a Trait.
    if (property.source === 'trait') continue;
    const existing = byId.get(property.id);
    byId.set(property.id, { ...property, traitIds: existing?.traitIds ?? property.traitIds });
  }

  const inherited: EffectiveInteractableInstanceProperty[] = [...byId.values()].map((property) => {
    const local = instance.localProperties.find((item) => item.id === property.id);
    const value = local?.value ?? property.defaultValue;
    return {
      ...property,
      ...(value === undefined ? {} : { value }),
      hasValue: value !== undefined,
      localOnly: false,
      ...(local ? { localProperty: local } : {}),
    };
  });
  const inheritedIds = new Set(inherited.map((property) => property.id));
  const localOnly = instance.localProperties
    .filter((property) => !inheritedIds.has(property.id))
    .map<EffectiveInteractableInstanceProperty>((property) => ({
      id: property.id,
      contract: property,
      value: property.value,
      hasValue: true,
      localOnly: true,
      localProperty: property,
      source: 'definition',
      traitIds: [],
    }));
  return [...inherited, ...localOnly];
}

export function effectiveInteractableFeatureTraits(
  project: AuthoringProject,
  instance: InteractableInstanceData,
  featureId: string,
): string[] {
  const definition = project.interactables[instance.definition.$ref.id];
  const effective = definition
    ? resolveGameplayInstanceRecord(project, 'interactable', definition)
    : null;
  const data = effective?.data as { features?: unknown } | undefined;
  const parsed = Array.isArray(data?.features)
    ? data.features.find(
        (feature): feature is { id: string; traits: string[] } =>
          typeof feature === 'object' &&
          feature !== null &&
          'id' in feature &&
          (feature as { id?: unknown }).id === featureId &&
          'traits' in feature &&
          Array.isArray((feature as { traits?: unknown }).traits),
      )
    : undefined;
  const ids = new Set(parsed?.traits ?? []);
  const override = instance.featureOverrides.find((candidate) => candidate.featureId === featureId);
  for (const id of override?.traits.remove ?? []) ids.delete(id);
  for (const id of override?.traits.add ?? []) ids.add(id);
  return [...ids];
}

export function effectiveInteractableFeatureProperties(
  project: AuthoringProject,
  instance: InteractableInstanceData,
  featureId: string,
): EffectiveInteractableFeatureProperty[] {
  const definition = project.interactables[instance.definition.$ref.id];
  const effective = definition
    ? resolveGameplayInstanceRecord(project, 'interactable', definition)
    : null;
  const feature =
    effective && typeof effective.data === 'object' && effective.data !== null
      ? (
          (effective.data as { features?: unknown }).features as
            | Array<{
                id: string;
                defaultProperties: OwnerDefaultProperty[];
                traits: string[];
              }>
            | undefined
        )?.find((candidate) => candidate.id === featureId)
      : undefined;
  if (!feature) return [];
  const effectiveTraits = effectiveInteractableFeatureTraits(project, instance, featureId);
  const byId = new Map<string, EffectiveInteractableProperty>();
  for (const traitProperty of traitProperties(project, effectiveTraits, 'feature').values()) {
    byId.set(traitProperty.id, traitProperty);
  }
  for (const property of feature.defaultProperties) {
    const existing = byId.get(property.id);
    byId.set(property.id, {
      id: property.id,
      contract: cloneContract(property),
      ...(property.defaultValue === undefined && existing?.defaultValue === undefined
        ? {}
        : { defaultValue: property.defaultValue ?? existing?.defaultValue }),
      source: 'definition',
      traitIds: existing?.traitIds ?? [],
    });
  }
  const override = instance.featureOverrides.find((candidate) => candidate.featureId === featureId);
  const overrides = new Map(
    (override?.properties ?? []).map((property) => [property.propertyId, property.value]),
  );
  return [...byId.values()].map((property) => {
    const overridden = overrides.has(property.id);
    const value = overridden ? overrides.get(property.id) : property.defaultValue;
    return {
      id: property.id,
      contract: property.contract,
      ...(value === undefined ? {} : { value }),
      hasValue: value !== undefined,
      overridden,
      source: property.source === 'trait' ? 'trait' : 'feature',
      traitIds: property.traitIds,
    };
  });
}
