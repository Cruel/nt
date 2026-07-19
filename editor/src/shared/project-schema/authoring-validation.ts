import type { ToolDiagnostic, ToolSeverity } from '../editor-tooling';
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

function diagnostic(
  severity: ToolSeverity,
  path: string,
  message: string,
  category = 'Project validation',
): ToolDiagnostic {
  return { severity, path, message, category };
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

function detectExtendsCycles(
  project: AuthoringProject,
  collection: AuthoringCollectionKey,
  diagnostics: ToolDiagnostic[],
) {
  if (!propertyOwnerKindByCollection[collection]) return;
  const records = recordsFor(project, collection);
  for (const id of Object.keys(records)) {
    const seen = new Set<string>();
    let current: string | null = id;
    while (current) {
      if (seen.has(current)) {
        diagnostics.push(
          diagnostic(
            'error',
            `/${collection}/${escapePathSegment(id)}/extends`,
            'extends chain contains a cycle.',
          ),
        );
        break;
      }
      seen.add(current);
      current = records[current]?.extends ?? null;
    }
  }
}

function validateProperties(project: AuthoringProject, diagnostics: ToolDiagnostic[]) {
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

function validateAssets(project: AuthoringProject, diagnostics: ToolDiagnostic[]) {
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

export function validateAuthoringProject(value: unknown): ToolDiagnostic[] {
  const diagnostics: ToolDiagnostic[] = [];
  const parsed = authoringProjectSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      diagnostics.push(
        diagnostic(
          'error',
          `/${issue.path.map(String).map(escapePathSegment).join('/')}`,
          issue.message,
        ),
      );
    return diagnostics;
  }

  const project = parsed.data;
  if (!project.entrypoint) {
    diagnostics.push(
      diagnostic('warning', '/entrypoint', 'No project entrypoint is configured yet.'),
    );
  } else {
    const collection = `${project.entrypoint.kind}s` as 'rooms' | 'scenes' | 'dialogues';
    if (!project[collection][project.entrypoint.id])
      diagnostics.push(
        diagnostic(
          'error',
          '/entrypoint',
          `Missing ${project.entrypoint.kind} '${project.entrypoint.id}'.`,
        ),
      );
  }

  for (const collection of authoringCollectionKeys) {
    const records = recordsFor(project, collection);
    for (const [id, record] of Object.entries(records)) {
      const basePath = `/${collection}/${escapePathSegment(id)}`;
      if (!isValidEntityId(id))
        diagnostics.push(diagnostic('error', basePath, `Invalid record id '${id}'.`));
      if (record.id !== id)
        diagnostics.push(
          diagnostic(
            'error',
            `${basePath}/id`,
            `Record id '${record.id}' must match map key '${id}'.`,
          ),
        );
      if (!record.label.trim())
        diagnostics.push(diagnostic('error', `${basePath}/label`, 'Record label is required.'));
      if (record.extends) {
        if (record.extends === id)
          diagnostics.push(
            diagnostic('error', `${basePath}/extends`, 'Record cannot extend itself.'),
          );
        else if (!records[record.extends])
          diagnostics.push(
            diagnostic(
              'error',
              `${basePath}/extends`,
              `Missing extended ${collection} record '${record.extends}'.`,
            ),
          );
      }
    }
    detectExtendsCycles(project, collection, diagnostics);
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
  return diagnostics;
}

export function authoringValidationSucceeded(diagnostics: ToolDiagnostic[]): boolean {
  return !diagnostics.some((item) => item.severity === 'error');
}
