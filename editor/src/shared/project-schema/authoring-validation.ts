import type { ToolDiagnostic, ToolSeverity } from '../editor-tooling';
import { collectAuthoringLuaSources } from '../authoring-source-analysis';
import {
  authoringCollectionKeys,
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from './authoring-collections';
import { parseAssetData, isSafeProjectAssetPath, validateAssetAlias } from './authoring-assets';
import { validateCharacterData } from './authoring-characters';
import { validateDialogueData } from './authoring-dialogues';
import { validateInteractableData } from './authoring-interactables';
import { validateInteractionData, validateInteractionProgram } from './authoring-interactions';
import { validateLayoutData } from './authoring-layouts';
import { validateMaterialData } from './authoring-materials';
import { validateMapData } from './authoring-maps';
import { isPropertyValueCompatible, type PropertyOwnerKind } from './authoring-properties';
import { validateRoomData } from './authoring-rooms';
import { validateHotspotAuthoringSemantics } from './authoring-hotspot-validation';
import { validateTypedProjectSettings } from './authoring-project-settings';
import { validateSceneData } from './authoring-scenes';
import { validateScriptModuleData } from './authoring-script-modules';
import { validateShaderData } from './authoring-shaders';
import { validateTestData } from './authoring-tests';
import { validateVariableData } from './authoring-variables';
import { parseVerbData } from './authoring-verbs';
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
  scenes: 'scene',
  dialogues: 'dialogue',
  characters: 'character',
  interactables: 'interactable',
  verbs: 'verb',
  interactions: 'interaction',
  maps: 'map',
};

function recordsFor(
  project: AuthoringProject,
  collection: AuthoringCollectionKey,
): Record<string, AuthoringRecordBase> {
  return project[collection] as Record<string, AuthoringRecordBase>;
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

  validateProperties(project, diagnostics);
  validateTraits(project, diagnostics);
  validateAssets(project, diagnostics);
  diagnostics.push(...validateTypedProjectSettings(project));
  for (const [id, record] of Object.entries(project.layouts))
    diagnostics.push(...validateLayoutData(project, id, record));
  for (const [id, record] of Object.entries(project.variables))
    diagnostics.push(...validateVariableData(project, id, record));
  for (const [id, record] of Object.entries(project.shaders))
    diagnostics.push(...validateShaderData(project, id, record));
  for (const [id, record] of Object.entries(project.materials))
    diagnostics.push(...validateMaterialData(project, id, record));
  for (const [id, record] of Object.entries(project.characters))
    diagnostics.push(...validateCharacterData(project, id, record));
  for (const [id, record] of Object.entries(project.rooms))
    diagnostics.push(...validateRoomData(project, id, record));
  for (const [id, record] of Object.entries(project.interactables))
    diagnostics.push(...validateInteractableData(project, id, record));
  diagnostics.push(...validateHotspotAuthoringSemantics(project));
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
  for (const [id, record] of Object.entries(project.tests))
    diagnostics.push(...validateTestData(project, id, record));
  return collectProjectValidationDiagnostics(
    classifyProjectValidationDiagnostics(diagnostics, { producer: 'authoring' }),
  );
}

export function authoringValidationSucceeded(diagnostics: ToolDiagnostic[]): boolean {
  return !diagnostics.some((item) => item.severity === 'error');
}
