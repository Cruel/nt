import type { ToolDiagnostic, ToolSeverity } from '../editor-tooling';
import { collectAuthoringLuaSources } from '../authoring-source-analysis';
import { analyzeHookRegistry } from '../hook-registry-analysis';
import {
  authoringCollectionKeys,
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from './authoring-collections';
import { parseAssetData, isSafeProjectAssetPath, validateAssetAlias } from './authoring-assets';
import {
  gameplayInstanceKindForCollection,
  isArchetypeOverridePathAllowed,
  parseArchetypeData,
  resolveArchetypeConfiguration,
  resolveGameplayInstanceRecord,
} from './authoring-archetypes';
import { validateCharacterData } from './authoring-characters';
import { validateDialogueData } from './authoring-dialogues';
import { parseInteractableData, validateInteractableData } from './authoring-interactables';
import {
  effectiveInteractableFeatureProperties,
  effectiveInteractableFeatureTraits,
  effectiveInteractableInstanceProperties,
  effectiveInteractableInstanceTraits,
} from './authoring-interactable-properties';
import {
  validateInteractionData,
  validateInteractionProgram,
  validateInteractionResolverProject,
} from './authoring-interactions';
import { validateLayoutData, validateSystemLayoutSettings } from './authoring-layouts';
import { validateMaterialData } from './authoring-materials';
import { validateMapData } from './authoring-maps';
import {
  arePropertySchemasCompatible,
  authoredRuntimeValuesEqual,
  isPropertyValueCompatible,
  type AuthoredRuntimeValue,
  type PropertyOwnerKind,
  type TraitDefinition,
  type TraitProperty,
} from './authoring-properties';
import { parseRoomData, validateRoomData } from './authoring-rooms';
import {
  validateHotspotAuthoringSemantics,
  validateInteractableHotspotAuthoringSemantics,
} from './authoring-hotspot-validation';
import { validateAuthoringInventories } from './authoring-inventory-validation';
import { validateTypedProjectSettings } from './authoring-project-settings';
import { validateSceneData } from './authoring-scenes';
import { validateScriptModuleData } from './authoring-script-modules';
import { validateShaderData } from './authoring-shaders';
import { validateTestData } from './authoring-tests';
import { validateVariableData } from './authoring-variables';
import {
  parseVerbData,
  validateCompletedCommandTemplate,
  validateVerbNamedTemplate,
} from './authoring-verbs';
import { validateCondition } from './authoring-condition-validation';
import {
  authoringProjectSchema,
  isValidEntityId,
  type AuthoringProject,
  type AuthoringRecordBase,
} from './authoring-project';
import {
  classifyProjectValidationDiagnostics,
  collectProjectValidationDiagnostics,
  type ProjectValidationDiagnostic,
  type ProjectValidationDiagnosticLike,
} from './project-validation';

function diagnostic(
  severity: ToolSeverity,
  path: string,
  message: string,
  category = 'Project validation',
  code?: string,
  navigation?: ToolDiagnostic['navigation'],
  ownerPaths?: readonly string[],
): ProjectValidationDiagnosticLike {
  return {
    severity,
    path,
    message,
    category,
    ...(code ? { code } : {}),
    ...(navigation ? { navigation } : {}),
    ...(ownerPaths ? { ownerPaths: [...ownerPaths] } : {}),
  };
}

function escapePathSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

const propertyOwnerKindByCollection: Partial<Record<AuthoringCollectionKey, PropertyOwnerKind>> = {
  rooms: 'room',
  characters: 'character',
  interactables: 'interactable',
};

function recordsFor(
  project: AuthoringProject,
  collection: AuthoringCollectionKey,
): Record<string, AuthoringRecordBase> {
  return project[collection] as Record<string, AuthoringRecordBase>;
}

function validateArchetypePropertyConfiguration(
  project: AuthoringProject,
  ownerKind: PropertyOwnerKind,
  traits: readonly string[],
  basePath: string,
  diagnostics: ProjectValidationDiagnosticLike[],
) {
  const traitProperties = new Map<string, { traitId: string; property: TraitProperty }>();
  const traitDefaults = new Map<
    string,
    { traitId: string; value: Exclude<TraitProperty['defaultValue'], undefined> }
  >();
  const seenTraits = new Set<string>();
  for (const [index, traitId] of traits.entries()) {
    const path = `${basePath}/traits/${index}`;
    if (seenTraits.has(traitId)) {
      diagnostics.push(diagnostic('error', path, `Trait '${traitId}' is attached more than once.`));
      continue;
    }
    seenTraits.add(traitId);
    const trait = project.traits[traitId];
    if (!trait) {
      diagnostics.push(diagnostic('error', path, `Trait '${traitId}' is not declared.`));
      continue;
    }
    if (!trait.ownerKinds.includes(ownerKind)) {
      diagnostics.push(
        diagnostic('error', path, `Trait '${traitId}' cannot be attached to ${ownerKind}.`),
      );
      continue;
    }
    for (const member of trait.properties) {
      const previous = traitProperties.get(member.id);
      if (previous && !arePropertySchemasCompatible(previous.property, member))
        diagnostics.push(
          diagnostic(
            'error',
            path,
            `Trait '${traitId}' contributes property '${member.id}' with a schema incompatible with Trait '${previous.traitId}'.`,
            'Project validation',
            'authoring.trait.schema_conflict',
          ),
        );
      else if (!previous) traitProperties.set(member.id, { traitId, property: member });

      if (member.defaultValue !== undefined) {
        const previousDefault = traitDefaults.get(member.id);
        if (
          previousDefault &&
          !authoredRuntimeValuesEqual(previousDefault.value, member.defaultValue)
        )
          diagnostics.push(
            diagnostic(
              'error',
              path,
              `Trait '${traitId}' provides a conflicting Default for property '${member.id}' with Trait '${previousDefault.traitId}'.`,
              'Project validation',
              'authoring.trait.default_conflict',
            ),
          );
        else if (!previousDefault)
          traitDefaults.set(member.id, { traitId, value: member.defaultValue });
      }
    }
  }

  // Reusable configuration sources may intentionally leave Trait contracts incomplete. Concrete
  // owners are checked separately before publication.
}

function validateDefaultPropertyConfiguration(
  project: AuthoringProject,
  ownerKind: PropertyOwnerKind,
  traits: readonly string[],
  defaultProperties: readonly import('./authoring-properties').OwnerDefaultProperty[],
  basePath: string,
  diagnostics: ProjectValidationDiagnosticLike[],
) {
  const contributed = new Map<string, { traitId: string; property: TraitProperty }>();
  for (const traitId of traits) {
    const trait = project.traits[traitId];
    if (!trait || !trait.ownerKinds.includes(ownerKind)) continue;
    for (const property of trait.properties) {
      const previous = contributed.get(property.id);
      if (!previous) contributed.set(property.id, { traitId, property });
    }
  }
  for (const [index, property] of defaultProperties.entries()) {
    const source = contributed.get(property.id);
    if (source && !arePropertySchemasCompatible(property, source.property))
      diagnostics.push(
        diagnostic(
          'error',
          `${basePath}/defaultProperties/${index}`,
          `Property '${property.id}' is incompatible with Trait '${source.traitId}'.`,
        ),
      );
  }
}

function validateOwnerFeatures(
  project: AuthoringProject,
  features: readonly import('./authoring-features').FeatureData[],
  basePath: string,
  mode: 'value' | 'default',
  diagnostics: ProjectValidationDiagnosticLike[],
  requireConcreteValues = mode === 'value',
) {
  const seen = new Set<string>();
  for (const [index, feature] of features.entries()) {
    const path = `${basePath}/${index}`;
    if (seen.has(feature.id))
      diagnostics.push(
        diagnostic('error', `${path}/id`, `Feature '${feature.id}' is declared more than once.`),
      );
    seen.add(feature.id);
    validateArchetypePropertyConfiguration(project, 'feature', feature.traits, path, diagnostics);
    if (mode === 'default') {
      if (feature.localProperties.length > 0)
        diagnostics.push(
          diagnostic(
            'error',
            `${path}/localProperties`,
            'Interactable-definition Features use Property Defaults, not concrete local Values.',
          ),
        );
      validateDefaultPropertyConfiguration(
        project,
        'feature',
        feature.traits,
        feature.defaultProperties,
        path,
        diagnostics,
      );
      continue;
    }
    if (feature.defaultProperties.length > 0)
      diagnostics.push(
        diagnostic(
          'error',
          `${path}/defaultProperties`,
          'Room Features are concrete and use Property Values, not definition Defaults.',
        ),
      );
    const local = new Map(feature.localProperties.map((property) => [property.id, property]));
    const traitDefaults = new Set<string>();
    for (const traitId of feature.traits) {
      const trait = project.traits[traitId];
      if (!trait || !trait.ownerKinds.includes('feature')) continue;
      for (const member of trait.properties)
        if (member.defaultValue !== undefined) traitDefaults.add(member.id);
    }
    for (const traitId of feature.traits) {
      const trait = project.traits[traitId];
      if (!trait || !trait.ownerKinds.includes('feature')) continue;
      for (const member of trait.properties) {
        const localProperty = local.get(member.id);
        if (localProperty && !arePropertySchemasCompatible(localProperty, member))
          diagnostics.push(
            diagnostic(
              'error',
              `${path}/localProperties`,
              `Local Property '${member.id}' is incompatible with Trait '${traitId}'.`,
            ),
          );
        const hasValue = localProperty !== undefined || traitDefaults.has(member.id);
        if (requireConcreteValues && !hasValue)
          diagnostics.push(
            diagnostic(
              'error',
              `${path}/traits`,
              `Trait '${traitId}' requires property '${member.id}' to have an authored value.`,
            ),
          );
      }
    }
  }
}

function validateArchetypes(
  project: AuthoringProject,
  diagnostics: ProjectValidationDiagnosticLike[],
) {
  for (const [archetypeId, record] of Object.entries(project.archetypes)) {
    const base = `/archetypes/${escapePathSegment(archetypeId)}`;
    const data = parseArchetypeData(record.data);
    if (!data) continue;
    for (const pointer of Object.keys(data.overrides)) {
      if (!isArchetypeOverridePathAllowed(data.instanceKind, pointer))
        diagnostics.push(
          diagnostic(
            'error',
            `${base}/data/overrides/${escapePathSegment(pointer)}`,
            `Override path '${pointer}' cannot be inherited by a ${data.instanceKind} Archetype.`,
          ),
        );
    }
    if (data.base) {
      const parent = project.archetypes[data.base.$ref.id];
      const parentData = parseArchetypeData(parent?.data);
      if (!parent)
        diagnostics.push(
          diagnostic(
            'error',
            `${base}/data/base`,
            `Archetype '${data.base.$ref.id}' is not declared.`,
          ),
        );
      else if (!parentData || parentData.instanceKind !== data.instanceKind)
        diagnostics.push(
          diagnostic(
            'error',
            `${base}/data/base`,
            'Archetype bases must have the same gameplay-instance kind.',
          ),
        );
    }
    const effective = resolveArchetypeConfiguration(project, archetypeId);
    if (!effective)
      diagnostics.push(
        diagnostic(
          'error',
          `${base}/data`,
          'Archetype chain is cyclic or does not resolve to a valid same-kind configuration.',
        ),
      );
    else {
      validateArchetypePropertyConfiguration(
        project,
        data.instanceKind,
        effective.traits,
        `${base}/data/effectiveConfiguration`,
        diagnostics,
      );
      validateDefaultPropertyConfiguration(
        project,
        data.instanceKind,
        effective.traits,
        effective.defaultProperties,
        `${base}/data/effectiveConfiguration`,
        diagnostics,
      );
      if (data.instanceKind === 'interactable' && typeof effective.data === 'object') {
        const parsed = parseInteractableData(effective.data);
        if (parsed) {
          diagnostics.push(
            ...validateInteractableHotspotAuthoringSemantics(
              project,
              parsed,
              `${base}/data/effectiveConfiguration/data/presentation`,
              `Interactable Archetype '${archetypeId}'`,
            ),
          );
          validateOwnerFeatures(
            project,
            parsed.features,
            `${base}/data/effectiveConfiguration/data/features`,
            'default',
            diagnostics,
          );
        }
      } else if (data.instanceKind === 'room') {
        const parsed = parseRoomData(effective.data);
        if (parsed)
          validateOwnerFeatures(
            project,
            parsed.features,
            `${base}/data/effectiveConfiguration/data/features`,
            'value',
            diagnostics,
            false,
          );
      }
    }
  }

  for (const collection of ['rooms', 'characters', 'interactables'] as const) {
    const expectedKind = gameplayInstanceKindForCollection(collection)!;
    for (const [recordId, record] of Object.entries(project[collection])) {
      const archetypeId = record.archetype?.$ref.id;
      if (!archetypeId) continue;
      const base = `/${collection}/${escapePathSegment(recordId)}/archetype`;
      for (const pointer of Object.keys(record.archetypeOverrides ?? {})) {
        if (!isArchetypeOverridePathAllowed(expectedKind, pointer))
          diagnostics.push(
            diagnostic(
              'error',
              `/${collection}/${escapePathSegment(recordId)}/archetypeOverrides/${escapePathSegment(pointer)}`,
              `Override path '${pointer}' cannot target instance-local ${expectedKind} state.`,
            ),
          );
      }
      const archetype = project.archetypes[archetypeId];
      const data = parseArchetypeData(archetype?.data);
      if (!archetype)
        diagnostics.push(diagnostic('error', base, `Archetype '${archetypeId}' is not declared.`));
      else if (!data || data.instanceKind !== expectedKind)
        diagnostics.push(
          diagnostic(
            'error',
            base,
            `Archetype '${archetypeId}' is not a ${expectedKind} Archetype.`,
          ),
        );
      else if (!resolveGameplayInstanceRecord(project, expectedKind, record))
        diagnostics.push(
          diagnostic(
            'error',
            base,
            'Gameplay Instance Archetype configuration cannot be resolved.',
          ),
        );
    }
  }
}

function effectiveGameplayProject(project: AuthoringProject): AuthoringProject {
  return {
    ...project,
    rooms: Object.fromEntries(
      Object.entries(project.rooms).map(([id, record]) => [
        id,
        resolveGameplayInstanceRecord(project, 'room', record) ?? record,
      ]),
    ),
    characters: Object.fromEntries(
      Object.entries(project.characters).map(([id, record]) => [
        id,
        resolveGameplayInstanceRecord(project, 'character', record) ?? record,
      ]),
    ),
    interactables: Object.fromEntries(
      Object.entries(project.interactables).map(([id, record]) => [
        id,
        resolveGameplayInstanceRecord(project, 'interactable', record) ?? record,
      ]),
    ),
  } as AuthoringProject;
}

function validateFeatures(
  project: AuthoringProject,
  diagnostics: ProjectValidationDiagnosticLike[],
) {
  for (const [roomId, record] of Object.entries(project.rooms)) {
    const effective = resolveGameplayInstanceRecord(project, 'room', record);
    const room = parseRoomData(effective?.data ?? record.data);
    if (room)
      validateOwnerFeatures(
        project,
        room.features,
        `/rooms/${escapePathSegment(roomId)}/data/features`,
        'value',
        diagnostics,
      );
  }
  for (const [interactableId, record] of Object.entries(project.interactables)) {
    const effective = resolveGameplayInstanceRecord(project, 'interactable', record);
    const interactable = parseInteractableData(effective?.data ?? record.data);
    if (interactable)
      validateOwnerFeatures(
        project,
        interactable.features,
        `/interactables/${escapePathSegment(interactableId)}/data/features`,
        'default',
        diagnostics,
      );
  }
}

function validateTraits(project: AuthoringProject, diagnostics: ProjectValidationDiagnosticLike[]) {
  for (const [traitId, trait] of Object.entries(project.traits)) {
    const base = `/traits/${escapePathSegment(traitId)}`;
    if (trait.id !== traitId)
      diagnostics.push(
        diagnostic(
          'error',
          `${base}/id`,
          `Trait id '${trait.id}' must match map key '${traitId}'.`,
        ),
      );
  }

  // #137 migrates the concrete Room and Character owners established by #136. Reusable and
  // remaining Property-bearing owners are intentionally handled by #138/#139.
  for (const collection of ['rooms', 'characters'] as const) {
    const ownerKind = propertyOwnerKindByCollection[collection];
    if (!ownerKind) continue;
    for (const [recordId, record] of Object.entries(recordsFor(project, collection))) {
      const resolvedRecord = resolveGameplayInstanceRecord(
        project,
        collection === 'rooms' ? 'room' : 'character',
        record,
      );
      const attachmentIds = resolvedRecord?.traits ?? record.traits ?? [];
      const archetypeDefaults = record.archetype
        ? (resolveArchetypeConfiguration(project, record.archetype.$ref.id)?.defaultProperties ??
          [])
        : [];
      const archetypeDefaultById = new Map(
        archetypeDefaults.map((property) => [property.id, property]),
      );
      const seenTraits = new Set<string>();
      const contributed = new Map<string, { traitId: string; property: TraitProperty }>();
      const defaults = new Map<
        string,
        { traitId: string; value: Exclude<TraitProperty['defaultValue'], undefined> }
      >();
      const attachedTraits: TraitDefinition[] = [];
      for (const [index, traitId] of attachmentIds.entries()) {
        const path = `/${collection}/${escapePathSegment(recordId)}/traits/${index}`;
        if (seenTraits.has(traitId)) {
          diagnostics.push(
            diagnostic('error', path, `Trait '${traitId}' is attached more than once.`),
          );
          continue;
        }
        seenTraits.add(traitId);
        const trait = project.traits[traitId];
        if (!trait) {
          diagnostics.push(diagnostic('error', path, `Trait '${traitId}' is not declared.`));
          continue;
        }
        if (!trait.ownerKinds.includes(ownerKind)) {
          diagnostics.push(
            diagnostic('error', path, `Trait '${traitId}' cannot be attached to ${ownerKind}.`),
          );
          continue;
        }
        attachedTraits.push(trait);
        for (const member of trait.properties) {
          const previous = contributed.get(member.id);
          if (previous && !arePropertySchemasCompatible(previous.property, member))
            diagnostics.push(
              diagnostic(
                'error',
                path,
                `Trait '${traitId}' contributes property '${member.id}' with a schema incompatible with Trait '${previous.traitId}'.`,
                'Project validation',
                'authoring.trait.schema_conflict',
              ),
            );
          else if (!previous) contributed.set(member.id, { traitId, property: member });

          if (member.defaultValue !== undefined) {
            const previousDefault = defaults.get(member.id);
            if (
              previousDefault &&
              !authoredRuntimeValuesEqual(previousDefault.value, member.defaultValue)
            )
              diagnostics.push(
                diagnostic(
                  'error',
                  path,
                  `Trait '${traitId}' provides a conflicting Default for property '${member.id}' with Trait '${previousDefault.traitId}'.`,
                  'Project validation',
                  'authoring.trait.default_conflict',
                ),
              );
            else if (!previousDefault)
              defaults.set(member.id, { traitId, value: member.defaultValue });
          }
        }
      }

      const localProperties = new Map(
        (record.localProperties ?? []).map((item) => [item.id, item]),
      );
      for (const [propertyId, source] of contributed) {
        const local = localProperties.get(propertyId);
        if (local && !arePropertySchemasCompatible(local, source.property))
          diagnostics.push(
            diagnostic(
              'error',
              `/${collection}/${escapePathSegment(recordId)}/localProperties`,
              `Local Property '${propertyId}' is incompatible with Trait '${source.traitId}'.`,
            ),
          );
        const archetypeDefault = archetypeDefaultById.get(propertyId);
        if (archetypeDefault && !arePropertySchemasCompatible(archetypeDefault, source.property))
          diagnostics.push(
            diagnostic(
              'error',
              `/${collection}/${escapePathSegment(recordId)}/archetype`,
              `Archetype Property '${propertyId}' is incompatible with Trait '${source.traitId}'.`,
            ),
          );
      }

      for (const trait of attachedTraits) {
        for (const member of trait.properties) {
          if (
            defaults.has(member.id) ||
            archetypeDefaultById.get(member.id)?.defaultValue !== undefined
          )
            continue;
          if (!localProperties.has(member.id))
            diagnostics.push(
              diagnostic(
                'error',
                `/${collection}/${escapePathSegment(recordId)}/traits`,
                `Trait '${trait.id}' requires property '${member.id}' to have an authored value.`,
              ),
            );
        }
      }
    }
  }
}

function validateInteractableProperties(
  project: AuthoringProject,
  diagnostics: ProjectValidationDiagnosticLike[],
) {
  for (const [definitionId, record] of Object.entries(project.interactables)) {
    const base = `/interactables/${escapePathSegment(definitionId)}`;
    const effectiveRecord = resolveGameplayInstanceRecord(project, 'interactable', record);
    const interactableData = parseInteractableData(effectiveRecord?.data ?? record.data);
    if (interactableData) {
      if (!interactableData.stackable && interactableData.stackLimit !== null)
        diagnostics.push(
          diagnostic(
            'error',
            `${base}/data/stackLimit`,
            'Non-stackable Interactables cannot declare a Stack limit.',
            'Project validation',
            'authoring.interactable.invalid_stack_limit',
          ),
        );
      if (
        interactableData.stackable &&
        (interactableData.features.length > 0 || interactableData.inventories.length > 0)
      )
        diagnostics.push(
          diagnostic(
            'error',
            `${base}/data`,
            'Stackable Interactables cannot own identity-bearing Features or Inventories.',
            'Project validation',
            'authoring.interactable.stackable_identity_children',
          ),
        );
    }
    const effectiveTraits = effectiveRecord?.traits ?? record.traits ?? [];
    const local = new Map(
      (record.defaultProperties ?? []).map((property) => [property.id, property]),
    );
    const traitDefaults = new Map<string, { traitId: string; value: AuthoredRuntimeValue }>();
    for (const traitId of effectiveTraits) {
      const trait = project.traits[traitId];
      if (!trait || !trait.ownerKinds.includes('interactable')) continue;
      for (const property of trait.properties) {
        const own = local.get(property.id);
        if (own && !arePropertySchemasCompatible(own, property))
          diagnostics.push(
            diagnostic(
              'error',
              `${base}/defaultProperties`,
              `Definition Property '${property.id}' is incompatible with Trait '${traitId}'.`,
            ),
          );
        if (property.defaultValue !== undefined) {
          const previousDefault = traitDefaults.get(property.id);
          if (
            previousDefault &&
            !authoredRuntimeValuesEqual(previousDefault.value, property.defaultValue)
          )
            diagnostics.push(
              diagnostic(
                'error',
                `${base}/traits`,
                `Trait '${traitId}' provides a conflicting Default for Property '${property.id}' with Trait '${previousDefault.traitId}'.`,
                'Project validation',
                'authoring.trait.default_conflict',
              ),
            );
          else if (!previousDefault)
            traitDefaults.set(property.id, { traitId, value: property.defaultValue });
        }
      }
    }
  }

  for (const [instanceId, instance] of Object.entries(project.interactableInstances)) {
    const base = `/interactableInstances/${escapePathSegment(instanceId)}`;
    const definition = project.interactables[instance.definition.$ref.id];
    if (!definition) continue;
    const ownerPaths =
      instance.location.kind === 'room' && project.rooms[instance.location.room.$ref.id]
        ? [`/rooms/${escapePathSegment(instance.location.room.$ref.id)}`]
        : [`/interactables/${escapePathSegment(instance.definition.$ref.id)}`];
    const instanceDiagnostic = (
      severity: ToolSeverity,
      path: string,
      message: string,
      category = 'Project validation',
      code?: string,
      navigation?: ToolDiagnostic['navigation'],
    ) => diagnostic(severity, path, message, category, code, navigation, ownerPaths);
    const definitionTraits = new Set(
      resolveGameplayInstanceRecord(project, 'interactable', definition)?.traits ??
        definition.traits ??
        [],
    );
    const add = new Set<string>();
    for (const [index, traitId] of instance.traits.add.entries()) {
      const path = `${base}/traits/add/${index}`;
      if (add.has(traitId))
        diagnostics.push(
          instanceDiagnostic('error', path, `Trait '${traitId}' is added more than once.`),
        );
      add.add(traitId);
      const trait = project.traits[traitId];
      if (!trait)
        diagnostics.push(instanceDiagnostic('error', path, `Trait '${traitId}' is not declared.`));
      else if (!trait.ownerKinds.includes('interactable'))
        diagnostics.push(
          instanceDiagnostic(
            'error',
            path,
            `Trait '${traitId}' cannot be attached to interactable.`,
          ),
        );
      if (definitionTraits.has(traitId))
        diagnostics.push(
          instanceDiagnostic(
            'error',
            path,
            `Trait '${traitId}' is already inherited from the definition.`,
          ),
        );
    }
    const remove = new Set<string>();
    for (const [index, traitId] of instance.traits.remove.entries()) {
      const path = `${base}/traits/remove/${index}`;
      if (remove.has(traitId))
        diagnostics.push(
          instanceDiagnostic('error', path, `Trait '${traitId}' is removed more than once.`),
        );
      remove.add(traitId);
      if (!definitionTraits.has(traitId))
        diagnostics.push(
          instanceDiagnostic(
            'error',
            path,
            `Trait '${traitId}' is not inherited from the definition.`,
          ),
        );
      if (add.has(traitId))
        diagnostics.push(
          instanceDiagnostic('error', path, `Trait '${traitId}' cannot be both added and removed.`),
        );
    }

    const effective = effectiveInteractableInstanceProperties(project, instance);
    const inherited = new Map(
      effective
        .filter((property) => !property.localOnly)
        .map((property) => [property.id, property]),
    );
    for (const [index, property] of instance.localProperties.entries()) {
      const inheritedProperty = inherited.get(property.id);
      if (inheritedProperty && !arePropertySchemasCompatible(property, inheritedProperty.contract))
        diagnostics.push(
          instanceDiagnostic(
            'error',
            `${base}/localProperties/${index}`,
            `Instance-local Property '${property.id}' is incompatible with its inherited Property schema.`,
          ),
        );
    }
    for (const property of effective) {
      if (!property.hasValue)
        diagnostics.push(
          instanceDiagnostic(
            'error',
            `${base}/localProperties`,
            `Interactable Instance '${instanceId}' requires Property '${property.id}' to have a Value.`,
            'Project validation',
            'authoring.interactable.missing_property_value',
            {
              kind: 'interactable-instance-property',
              instanceId,
              propertyId: property.id,
            },
          ),
        );
    }

    const effectiveDefinition = resolveGameplayInstanceRecord(project, 'interactable', definition);
    const definitionData = parseInteractableData(effectiveDefinition?.data ?? definition.data);
    if (definitionData) {
      if (!definitionData.stackable && instance.quantity !== 1)
        diagnostics.push(
          instanceDiagnostic(
            'error',
            `${base}/quantity`,
            'Non-stackable Interactable Instances must have quantity 1.',
            'Project validation',
            'authoring.interactable.invalid_quantity',
          ),
        );
      if (
        definitionData.stackable &&
        definitionData.stackLimit !== null &&
        instance.quantity > definitionData.stackLimit
      )
        diagnostics.push(
          instanceDiagnostic(
            'error',
            `${base}/quantity`,
            `Quantity ${instance.quantity} exceeds Stack limit ${definitionData.stackLimit}.`,
            'Project validation',
            'authoring.interactable.stack_limit_exceeded',
          ),
        );
    }
    const seenFeatureOverrides = new Set<string>();
    for (const [overrideIndex, override] of instance.featureOverrides.entries()) {
      const overridePath = `${base}/featureOverrides/${overrideIndex}`;
      if (seenFeatureOverrides.has(override.featureId))
        diagnostics.push(
          instanceDiagnostic(
            'error',
            `${overridePath}/featureId`,
            `Feature '${override.featureId}' is overridden more than once.`,
            'Project validation',
            'authoring.interactable.feature.duplicate_override',
          ),
        );
      seenFeatureOverrides.add(override.featureId);
      if (definitionData?.stackable)
        diagnostics.push(
          instanceDiagnostic(
            'error',
            overridePath,
            'Stackable Interactable Instances cannot carry Feature overrides.',
            'Project validation',
            'authoring.interactable.feature.stackable_override',
          ),
        );
      const feature = definitionData?.features.find(
        (candidate) => candidate.id === override.featureId,
      );
      if (!feature) {
        diagnostics.push(
          instanceDiagnostic(
            'error',
            `${overridePath}/featureId`,
            `Feature '${override.featureId}' is not declared by this Interactable definition.`,
            'Project validation',
            'authoring.interactable.feature.missing',
          ),
        );
        continue;
      }
      const inheritedTraits = new Set(feature.traits);
      const adds = new Set<string>();
      for (const [traitIndex, traitId] of override.traits.add.entries()) {
        const traitPath = `${overridePath}/traits/add/${traitIndex}`;
        if (adds.has(traitId))
          diagnostics.push(
            instanceDiagnostic('error', traitPath, `Trait '${traitId}' is added more than once.`),
          );
        adds.add(traitId);
        const trait = project.traits[traitId];
        if (!trait)
          diagnostics.push(
            instanceDiagnostic('error', traitPath, `Trait '${traitId}' is not declared.`),
          );
        else if (!trait.ownerKinds.includes('feature'))
          diagnostics.push(
            instanceDiagnostic(
              'error',
              traitPath,
              `Trait '${traitId}' cannot be attached to Feature.`,
            ),
          );
        if (inheritedTraits.has(traitId))
          diagnostics.push(
            instanceDiagnostic(
              'error',
              traitPath,
              `Trait '${traitId}' is already inherited by the Feature.`,
            ),
          );
      }
      const removes = new Set<string>();
      for (const [traitIndex, traitId] of override.traits.remove.entries()) {
        const traitPath = `${overridePath}/traits/remove/${traitIndex}`;
        if (removes.has(traitId))
          diagnostics.push(
            instanceDiagnostic('error', traitPath, `Trait '${traitId}' is removed more than once.`),
          );
        removes.add(traitId);
        if (!inheritedTraits.has(traitId))
          diagnostics.push(
            instanceDiagnostic(
              'error',
              traitPath,
              `Trait '${traitId}' is not inherited by the Feature.`,
            ),
          );
        if (adds.has(traitId))
          diagnostics.push(
            instanceDiagnostic(
              'error',
              traitPath,
              `Trait '${traitId}' cannot be both added and removed.`,
            ),
          );
      }
      const effectiveProperties = new Map(
        effectiveInteractableFeatureProperties(project, instance, override.featureId).map(
          (property) => [property.id, property],
        ),
      );
      const propertyIds = new Set<string>();
      for (const [propertyIndex, property] of override.properties.entries()) {
        const propertyPath = `${overridePath}/properties/${propertyIndex}`;
        if (propertyIds.has(property.propertyId))
          diagnostics.push(
            instanceDiagnostic(
              'error',
              `${propertyPath}/propertyId`,
              `Feature Property '${property.propertyId}' is overridden more than once.`,
            ),
          );
        propertyIds.add(property.propertyId);
        const effective = effectiveProperties.get(property.propertyId);
        if (!effective)
          diagnostics.push(
            instanceDiagnostic(
              'error',
              `${propertyPath}/propertyId`,
              `Feature Property '${property.propertyId}' is not in the effective Feature contract.`,
            ),
          );
        else if (!isPropertyValueCompatible(effective.contract, property.value))
          diagnostics.push(
            instanceDiagnostic(
              'error',
              `${propertyPath}/value`,
              `Feature Property '${property.propertyId}' Value does not match its contract.`,
            ),
          );
      }
    }

    for (const [featureIndex, feature] of (definitionData?.features ?? []).entries()) {
      const featurePath = `${base}/definitionFeatures/${featureIndex}`;
      for (const property of effectiveInteractableFeatureProperties(
        project,
        instance,
        feature.id,
      )) {
        if (!property.hasValue)
          diagnostics.push(
            instanceDiagnostic(
              'error',
              featurePath,
              `Interactable Instance '${instanceId}' requires Feature '${feature.id}' Property '${property.id}' to have a Value.`,
              'Project validation',
              'authoring.interactable.feature.missing_property_value',
            ),
          );
      }
      const effectiveFeatureTraits = effectiveInteractableFeatureTraits(
        project,
        instance,
        feature.id,
      );
      const seenFeatureProperties = new Map<string, TraitProperty>();
      for (const traitId of effectiveFeatureTraits) {
        const trait = project.traits[traitId];
        if (!trait || !trait.ownerKinds.includes('feature')) continue;
        for (const property of trait.properties) {
          const previous = seenFeatureProperties.get(property.id);
          if (previous && !arePropertySchemasCompatible(previous, property))
            diagnostics.push(
              instanceDiagnostic(
                'error',
                `${base}/featureOverrides`,
                `Effective Feature Traits contribute incompatible schemas for Property '${property.id}'.`,
              ),
            );
          else if (!previous) seenFeatureProperties.set(property.id, property);
        }
      }
    }

    const effectiveTraitIds = effectiveInteractableInstanceTraits(project, instance);
    const seen = new Map<string, TraitProperty>();
    const defaults = new Map<string, { traitId: string; value: AuthoredRuntimeValue }>();
    for (const traitId of effectiveTraitIds) {
      const trait = project.traits[traitId];
      if (!trait) continue;
      for (const property of trait.properties) {
        const previous = seen.get(property.id);
        if (previous && !arePropertySchemasCompatible(previous, property))
          diagnostics.push(
            instanceDiagnostic(
              'error',
              `${base}/traits`,
              `Effective Traits contribute incompatible schemas for Property '${property.id}'.`,
            ),
          );
        else if (!previous) seen.set(property.id, property);
        if (property.defaultValue !== undefined) {
          const previousDefault = defaults.get(property.id);
          if (
            previousDefault &&
            !authoredRuntimeValuesEqual(previousDefault.value, property.defaultValue)
          )
            diagnostics.push(
              instanceDiagnostic(
                'error',
                `${base}/traits`,
                `Effective Traits provide conflicting Defaults for Property '${property.id}'.`,
                'Project validation',
                'authoring.trait.default_conflict',
              ),
            );
          else if (!previousDefault)
            defaults.set(property.id, { traitId, value: property.defaultValue });
        }
      }
    }
  }
}

function validateAssets(project: AuthoringProject, diagnostics: ProjectValidationDiagnosticLike[]) {
  const aliases = new Map<string, string>();
  for (const [id, record] of Object.entries(project.assets)) {
    const basePath = `/assets/${escapePathSegment(id)}/data`;
    const data = parseAssetData(record.data);
    if (!data) {
      diagnostics.push(
        diagnostic(
          'error',
          basePath,
          'Asset record data must contain valid asset metadata.',
          'Assets',
        ),
      );
      continue;
    }
    if (!isSafeProjectAssetPath(data.source.path))
      diagnostics.push(
        diagnostic(
          'error',
          `${basePath}/source/path`,
          'Asset source path must be a safe project-relative path.',
          'Assets',
        ),
      );
    const seen = new Set<string>();
    for (const [index, alias] of data.aliases.entries()) {
      const aliasPath = `${basePath}/aliases/${index}`;
      const aliasError = validateAssetAlias(alias);
      if (aliasError) diagnostics.push(diagnostic('error', aliasPath, aliasError, 'Assets'));
      if (seen.has(alias))
        diagnostics.push(
          diagnostic('error', aliasPath, `Duplicate alias '${alias}' in asset.`, 'Assets'),
        );
      seen.add(alias);
      const owner = aliases.get(alias);
      if (owner && owner !== id)
        diagnostics.push(
          diagnostic(
            'error',
            aliasPath,
            `Alias '${alias}' is already assigned to asset '${owner}'.`,
            'Assets',
          ),
        );
      else aliases.set(alias, id);
    }
  }
}

export function validateAuthoringProject(value: unknown): ProjectValidationDiagnostic[] {
  const diagnostics: ProjectValidationDiagnosticLike[] = [];
  const parsed = authoringProjectSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      diagnostics.push(
        diagnostic(
          'error',
          `/${issue.path.map(String).map(escapePathSegment).join('/')}`,
          issue.message,
          'Project validation',
          `authoring.schema.${issue.code}`,
        ),
      );
    return collectProjectValidationDiagnostics(
      classifyProjectValidationDiagnostics(diagnostics, { producer: 'authoring' }),
    );
  }

  const project = parsed.data;
  for (const source of collectAuthoringLuaSources(project)) {
    if ((source.explicitDependencies?.length ?? 0) === 0 || source.supportsExplicitFallback)
      continue;
    diagnostics.push(
      diagnostic(
        'warning',
        source.explicitDependenciesPath ?? source.sourcePath,
        'Additional Lua dependencies are not supported for this authoring location.',
        'Lua analysis',
        'authoring.lua.unsupported_explicit_fallback_owner',
      ),
    );
  }
  if (!project.entrypoint) {
    diagnostics.push(
      diagnostic(
        'warning',
        '/entrypoint',
        'No project entrypoint is configured yet.',
        'Project validation',
        'authoring.entrypoint.missing',
      ),
    );
  } else {
    const collection = `${project.entrypoint.kind}s` as 'rooms' | 'scenes' | 'dialogues';
    if (!project[collection][project.entrypoint.id])
      diagnostics.push(
        diagnostic(
          'error',
          '/entrypoint',
          `Missing ${project.entrypoint.kind} '${project.entrypoint.id}'.`,
          'Project validation',
          'authoring.entrypoint.target-missing',
        ),
      );
  }

  for (const collection of authoringCollectionKeys) {
    const records = recordsFor(project, collection);
    for (const [id, record] of Object.entries(records)) {
      const basePath = `/${collection}/${escapePathSegment(id)}`;
      if (!isValidEntityId(id))
        diagnostics.push(
          diagnostic(
            'error',
            basePath,
            `Invalid record id '${id}'.`,
            'Project validation',
            'authoring.record.id.invalid',
          ),
        );
      if (record.id !== id)
        diagnostics.push(
          diagnostic(
            'error',
            `${basePath}/id`,
            `Record id '${record.id}' must match map key '${id}'.`,
            'Project validation',
            'authoring.record.id.key-mismatch',
          ),
        );
      if (!record.label.trim())
        diagnostics.push(
          diagnostic(
            'error',
            `${basePath}/label`,
            'Record label is required.',
            'Project validation',
            'authoring.record.label.required',
          ),
        );
    }
  }

  for (const [collection, records] of Object.entries(project.editor.recordMetadata ?? {})) {
    if (collection === 'traits') {
      for (const id of Object.keys(records)) {
        if (!project.traits[id])
          diagnostics.push(
            diagnostic(
              'error',
              `/editor/recordMetadata/traits/${escapePathSegment(id)}`,
              'Trait editor metadata target does not exist.',
            ),
          );
      }
      continue;
    }
    if (!isAuthoringCollectionKey(collection)) {
      diagnostics.push(
        diagnostic(
          'error',
          `/editor/recordMetadata/${escapePathSegment(collection)}`,
          `Unknown metadata collection '${collection}'.`,
        ),
      );
      continue;
    }
    for (const id of Object.keys(records)) {
      if (!project[collection][id])
        diagnostics.push(
          diagnostic(
            'error',
            `/editor/recordMetadata/${collection}/${escapePathSegment(id)}`,
            'Editor metadata target does not exist.',
          ),
        );
    }
  }

  validateArchetypes(project, diagnostics);
  const effectiveProject = effectiveGameplayProject(project);
  validateTraits(effectiveProject, diagnostics);
  validateInteractableProperties(effectiveProject, diagnostics);
  validateFeatures(effectiveProject, diagnostics);
  diagnostics.push(...validateAuthoringInventories(project));
  validateAssets(effectiveProject, diagnostics);
  diagnostics.push(...validateTypedProjectSettings(effectiveProject));
  diagnostics.push(...validateSystemLayoutSettings(effectiveProject));
  for (const [id, record] of Object.entries(effectiveProject.layouts))
    diagnostics.push(...validateLayoutData(effectiveProject, id, record));
  for (const [id, record] of Object.entries(effectiveProject.variables))
    diagnostics.push(...validateVariableData(effectiveProject, id, record));
  for (const [id, record] of Object.entries(effectiveProject.shaders))
    diagnostics.push(...validateShaderData(effectiveProject, id, record));
  for (const [id, record] of Object.entries(effectiveProject.materials))
    diagnostics.push(...validateMaterialData(effectiveProject, id, record));
  for (const [id, record] of Object.entries(effectiveProject.characters))
    diagnostics.push(...validateCharacterData(effectiveProject, id, record));
  for (const [id, record] of Object.entries(effectiveProject.rooms))
    diagnostics.push(...validateRoomData(effectiveProject, id, record));
  for (const [id, record] of Object.entries(effectiveProject.interactables))
    diagnostics.push(...validateInteractableData(effectiveProject, id, record));
  for (const [id, instance] of Object.entries(effectiveProject.interactableInstances)) {
    const base = `/interactableInstances/${escapePathSegment(id)}`;
    if (instance.id !== id)
      diagnostics.push(
        diagnostic(
          'error',
          `${base}/id`,
          `Interactable Instance ID must match registry key '${id}'.`,
        ),
      );
    if (!effectiveProject.interactables[instance.definition.$ref.id])
      diagnostics.push(
        diagnostic(
          'error',
          `${base}/definition/$ref`,
          `Missing Interactable definition '${instance.definition.$ref.id}'.`,
        ),
      );
    if (
      instance.location.kind === 'room' &&
      !effectiveProject.rooms[instance.location.room.$ref.id]
    )
      diagnostics.push(
        diagnostic(
          'error',
          `${base}/location/room/$ref`,
          `Missing Room '${instance.location.room.$ref.id}'.`,
        ),
      );
    const added = new Set(instance.traits.add);
    for (const traitId of instance.traits.remove) {
      if (added.has(traitId))
        diagnostics.push(
          diagnostic(
            'error',
            `${base}/traits`,
            `Trait '${traitId}' cannot be both added and removed on the same Interactable Instance.`,
          ),
        );
    }
    validateArchetypePropertyConfiguration(
      effectiveProject,
      'interactable',
      instance.traits.add,
      base,
      diagnostics,
    );
  }
  diagnostics.push(...validateHotspotAuthoringSemantics(effectiveProject));
  for (const [id, record] of Object.entries(project.verbs)) {
    const data = parseVerbData(record.data);
    if (!data)
      diagnostics.push(
        diagnostic(
          'error',
          `/verbs/${escapePathSegment(id)}/data`,
          'Verb record data must contain a valid Verb definition.',
          'Verbs',
        ),
      );
    else {
      const slotIds = new Set(data.slots.map((slot) => slot.id));
      const localizedTemplates = [
        data.completedCommandText.source.kind === 'localized'
          ? {
              key: data.completedCommandText.source.key,
              validate: validateCompletedCommandTemplate,
            }
          : null,
        ...data.slots.flatMap((slot) => [
          slot.label.source.kind === 'localized'
            ? {
                key: slot.label.source.key,
                validate: (text: string, ids: ReadonlySet<string>) =>
                  validateVerbNamedTemplate(text, ids, 'Slot label'),
              }
            : null,
          slot.prompt.source.kind === 'localized'
            ? {
                key: slot.prompt.source.key,
                validate: (text: string, ids: ReadonlySet<string>) =>
                  validateVerbNamedTemplate(text, ids, 'Slot prompt'),
              }
            : null,
        ]),
      ].filter((template): template is NonNullable<typeof template> => template !== null);
      for (const template of localizedTemplates) {
        for (const [locale, catalog] of Object.entries(project.localization.catalogs)) {
          const text = catalog[template.key];
          if (text === undefined) continue;
          const message = template.validate(text, slotIds);
          if (message)
            diagnostics.push(
              diagnostic(
                'error',
                `/localization/catalogs/${escapePathSegment(locale)}/${escapePathSegment(template.key)}`,
                message,
                'Verbs',
              ),
            );
        }
      }
      diagnostics.push(
        ...validateCondition(
          project,
          data.availability,
          `/verbs/${escapePathSegment(id)}/data/availability`,
        ),
      );
      diagnostics.push(
        ...validateInteractionProgram(
          project,
          data.defaultProgram,
          `/verbs/${escapePathSegment(id)}/data/defaultProgram`,
        ),
      );
    }
  }
  if (project.undefinedInteractionProgram)
    diagnostics.push(
      ...validateInteractionProgram(
        project,
        project.undefinedInteractionProgram,
        '/undefinedInteractionProgram',
      ),
    );
  for (const [id, record] of Object.entries(project.interactions))
    diagnostics.push(...validateInteractionData(project, id, record));
  diagnostics.push(...validateInteractionResolverProject(project));
  for (const [id, record] of Object.entries(project.dialogues))
    diagnostics.push(...validateDialogueData(project, id, record));
  for (const [id, record] of Object.entries(project.scenes))
    diagnostics.push(...validateSceneData(project, id, record));
  for (const [id, record] of Object.entries(project.maps))
    diagnostics.push(...validateMapData(project, id, record));
  for (const [id, record] of Object.entries(project.scripts))
    diagnostics.push(...validateScriptModuleData(project, id, record));
  diagnostics.push(...analyzeHookRegistry(effectiveProject).diagnostics);
  for (const [id, record] of Object.entries(project.tests))
    diagnostics.push(...validateTestData(project, id, record));
  return collectProjectValidationDiagnostics(
    classifyProjectValidationDiagnostics(diagnostics, { producer: 'authoring' }),
  );
}

export function authoringValidationSucceeded(diagnostics: ToolDiagnostic[]): boolean {
  return !diagnostics.some((item) => item.severity === 'error');
}
