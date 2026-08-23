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
import { parseItemDefinitionData, parseItemStackData } from './authoring-items';
import { validateInteractionData, validateInteractionProgram } from './authoring-interactions';
import { validateLayoutData, validateSystemLayoutSettings } from './authoring-layouts';
import { validateMaterialData } from './authoring-materials';
import { validateMapData } from './authoring-maps';
import {
  isPropertyValueCompatible,
  type PropertyAssignments,
  type PropertyOwnerKind,
} from './authoring-properties';
import { parseRoomData, validateRoomData } from './authoring-rooms';
import { validateHotspotAuthoringSemantics } from './authoring-hotspot-validation';
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
import { validateVariableRuntimeValue } from './authoring-variable-usage';
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
): ProjectValidationDiagnosticLike {
  return { severity, path, message, category, ...(code ? { code } : {}) };
}

function escapePathSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

const propertyOwnerKindByCollection: Partial<Record<AuthoringCollectionKey, PropertyOwnerKind>> = {
  rooms: 'room',
  characters: 'character',
  interactables: 'interactable',
  itemDefinitions: 'item-stack',
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
  properties: Readonly<PropertyAssignments>,
  basePath: string,
  diagnostics: ProjectValidationDiagnosticLike[],
) {
  for (const [propertyId, value] of Object.entries(properties)) {
    const path = `${basePath}/properties/${escapePathSegment(propertyId)}`;
    const definition = project.properties[propertyId];
    if (!definition)
      diagnostics.push(diagnostic('error', path, `Property '${propertyId}' is not declared.`));
    else if (!definition.ownerKinds.includes(ownerKind))
      diagnostics.push(
        diagnostic('error', path, `Property '${propertyId}' cannot be assigned to ${ownerKind}.`),
      );
    else if (!isPropertyValueCompatible(definition, value))
      diagnostics.push(
        diagnostic('error', path, `Assignment does not match property '${propertyId}'.`),
      );
  }

  const seenTraits = new Set<string>();
  const configured = new Map<string, { traitId: string; value: unknown }>();
  const attachedTraits: Array<(typeof project.traits)[string]> = [];
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
    attachedTraits.push(trait);
    for (const member of trait.properties) {
      if (member.kind !== 'configured') continue;
      const previous = configured.get(member.propertyId);
      if (previous && previous.value !== member.value)
        diagnostics.push(
          diagnostic(
            'error',
            path,
            `Trait '${traitId}' configures property '${member.propertyId}' incompatibly with Trait '${previous.traitId}'.`,
          ),
        );
      else if (!previous) configured.set(member.propertyId, { traitId, value: member.value });
    }
  }
  for (const trait of attachedTraits) {
    for (const member of trait.properties) {
      if (member.kind !== 'required') continue;
      const definition = project.properties[member.propertyId];
      const hasOwnAssignment = Object.prototype.hasOwnProperty.call(properties, member.propertyId);
      const hasConfiguredValue = configured.has(member.propertyId);
      const hasDeclarationDefault = definition?.defaultValue !== undefined;
      if (!hasOwnAssignment && !hasConfiguredValue && !hasDeclarationDefault)
        diagnostics.push(
          diagnostic(
            'error',
            `${basePath}/traits`,
            `Trait '${trait.id}' requires property '${member.propertyId}' to have an authored value.`,
          ),
        );
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
    else
      validateArchetypePropertyConfiguration(
        project,
        data.instanceKind,
        effective.traits,
        effective.properties,
        `${base}/data/effectiveConfiguration`,
        diagnostics,
      );
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
  const validateOwnerFeatures = (
    features: readonly {
      id: string;
      traits: readonly string[];
      properties: Readonly<PropertyAssignments>;
    }[],
    basePath: string,
  ) => {
    const seen = new Set<string>();
    for (const [index, feature] of features.entries()) {
      const path = `${basePath}/${index}`;
      if (seen.has(feature.id))
        diagnostics.push(
          diagnostic('error', `${path}/id`, `Feature '${feature.id}' is declared more than once.`),
        );
      seen.add(feature.id);
      validateArchetypePropertyConfiguration(
        project,
        'feature',
        feature.traits,
        feature.properties,
        path,
        diagnostics,
      );
    }
  };

  for (const [roomId, record] of Object.entries(project.rooms)) {
    const room = parseRoomData(record.data);
    if (room)
      validateOwnerFeatures(room.features, `/rooms/${escapePathSegment(roomId)}/data/features`);
  }
  for (const [interactableId, record] of Object.entries(project.interactables)) {
    const interactable = parseInteractableData(record.data);
    if (interactable)
      validateOwnerFeatures(
        interactable.features,
        `/interactables/${escapePathSegment(interactableId)}/data/features`,
      );
  }
}

function validateProperties(
  project: AuthoringProject,
  diagnostics: ProjectValidationDiagnosticLike[],
) {
  for (const [id, definition] of Object.entries(project.properties)) {
    const base = `/properties/${escapePathSegment(id)}`;
    if (definition.id !== id)
      diagnostics.push(
        diagnostic(
          'error',
          `${base}/id`,
          `Property id '${definition.id}' must match map key '${id}'.`,
        ),
      );
  }

  for (const collection of authoringCollectionKeys) {
    const ownerKind = propertyOwnerKindByCollection[collection];
    if (!ownerKind) continue;
    for (const [recordId, record] of Object.entries(recordsFor(project, collection))) {
      for (const [propertyId, value] of Object.entries(record.properties ?? {})) {
        const path = `/${collection}/${escapePathSegment(recordId)}/properties/${escapePathSegment(propertyId)}`;
        const definition = project.properties[propertyId];
        if (!definition) {
          diagnostics.push(diagnostic('error', path, `Property '${propertyId}' is not declared.`));
        } else if (!definition.ownerKinds.includes(ownerKind)) {
          diagnostics.push(
            diagnostic(
              'error',
              path,
              `Property '${propertyId}' cannot be assigned to ${ownerKind}.`,
            ),
          );
        } else if (!isPropertyValueCompatible(definition, value)) {
          diagnostics.push(
            diagnostic('error', path, `Assignment does not match property '${propertyId}'.`),
          );
        }
      }
    }
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
    for (const [index, member] of trait.properties.entries()) {
      const path = `${base}/properties/${index}`;
      const definition = project.properties[member.propertyId];
      if (!definition) {
        diagnostics.push(
          diagnostic(
            'error',
            `${path}/propertyId`,
            `Property '${member.propertyId}' is not declared.`,
          ),
        );
        continue;
      }
      const unsupportedOwners = trait.ownerKinds.filter(
        (ownerKind) => !definition.ownerKinds.includes(ownerKind),
      );
      if (unsupportedOwners.length > 0)
        diagnostics.push(
          diagnostic(
            'error',
            `${path}/propertyId`,
            `Property '${member.propertyId}' is not valid for Trait owner kind${unsupportedOwners.length === 1 ? '' : 's'} ${unsupportedOwners.join(', ')}.`,
          ),
        );
      if (member.kind === 'configured' && !isPropertyValueCompatible(definition, member.value))
        diagnostics.push(
          diagnostic(
            'error',
            `${path}/value`,
            `Configured value does not match property '${member.propertyId}'.`,
          ),
        );
    }
  }

  for (const collection of authoringCollectionKeys) {
    const ownerKind = propertyOwnerKindByCollection[collection];
    if (!ownerKind) continue;
    for (const [recordId, record] of Object.entries(recordsFor(project, collection))) {
      const attachmentIds = record.traits ?? [];
      const seenTraits = new Set<string>();
      const configured = new Map<string, { traitId: string; value: unknown }>();
      const attachedTraits: Array<(typeof project.traits)[string]> = [];
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
          if (member.kind !== 'configured') continue;
          const previous = configured.get(member.propertyId);
          if (previous && previous.value !== member.value)
            diagnostics.push(
              diagnostic(
                'error',
                path,
                `Trait '${traitId}' configures property '${member.propertyId}' incompatibly with Trait '${previous.traitId}'.`,
              ),
            );
          else if (!previous) configured.set(member.propertyId, { traitId, value: member.value });
        }
      }

      for (const trait of attachedTraits) {
        for (const member of trait.properties) {
          if (member.kind !== 'required') continue;
          const definition = project.properties[member.propertyId];
          const hasOwnAssignment = Object.prototype.hasOwnProperty.call(
            record.properties ?? {},
            member.propertyId,
          );
          const hasConfiguredValue = configured.has(member.propertyId);
          const hasDeclarationDefault = definition?.defaultValue !== undefined;
          if (!hasOwnAssignment && !hasConfiguredValue && !hasDeclarationDefault)
            diagnostics.push(
              diagnostic(
                'error',
                `/${collection}/${escapePathSegment(recordId)}/traits`,
                `Trait '${trait.id}' requires property '${member.propertyId}' to have an authored value.`,
              ),
            );
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
  validateProperties(effectiveProject, diagnostics);
  validateTraits(effectiveProject, diagnostics);
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
  for (const [id, record] of Object.entries(effectiveProject.itemDefinitions)) {
    const data = parseItemDefinitionData(record.data);
    if (!data)
      diagnostics.push(
        diagnostic(
          'error',
          `/itemDefinitions/${escapePathSegment(id)}/data`,
          'Item Definition record data is invalid.',
          'Item Definitions',
        ),
      );
  }
  for (const [id, record] of Object.entries(effectiveProject.itemStacks)) {
    const data = parseItemStackData(record.data);
    const base = `/itemStacks/${escapePathSegment(id)}/data`;
    if (!data) {
      diagnostics.push(
        diagnostic('error', base, 'Item Stack record data is invalid.', 'Item Stacks'),
      );
      continue;
    }
    const definition = effectiveProject.itemDefinitions[data.definition.$ref.id];
    const definitionData = parseItemDefinitionData(definition?.data);
    if (!definitionData)
      diagnostics.push(
        diagnostic(
          'error',
          `${base}/definition/$ref`,
          `Missing Item Definition '${data.definition.$ref.id}'.`,
          'Item Stacks',
        ),
      );
    else if (definitionData.stackLimit !== null && data.quantity > definitionData.stackLimit)
      diagnostics.push(
        diagnostic(
          'error',
          `${base}/quantity`,
          `Quantity exceeds Item Definition Stack limit ${definitionData.stackLimit}.`,
          'Item Stacks',
        ),
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
      if (data.availability.kind === 'variable-comparison') {
        const variableId = data.availability.variable.$ref.id;
        if (data.availability.value === undefined) {
          if (!project.variables[variableId])
            diagnostics.push(
              diagnostic(
                'error',
                `/verbs/${escapePathSegment(id)}/data/availability/variable/$ref`,
                `Missing variable '${variableId}'.`,
                'Verbs',
              ),
            );
        } else {
          const result = validateVariableRuntimeValue(project, variableId, data.availability.value);
          if (!result.ok)
            diagnostics.push(
              diagnostic(
                'error',
                result.kind === 'missing'
                  ? `/verbs/${escapePathSegment(id)}/data/availability/variable/$ref`
                  : `/verbs/${escapePathSegment(id)}/data/availability/value`,
                result.message,
                'Verbs',
              ),
            );
        }
      }
      diagnostics.push(
        ...validateInteractionProgram(
          project,
          data.defaultProgram,
          `/verbs/${escapePathSegment(id)}/data/defaultProgram`,
        ),
      );
    }
  }
  for (const [id, record] of Object.entries(project.interactions))
    diagnostics.push(...validateInteractionData(project, id, record));
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
