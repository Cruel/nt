import type { ToolDiagnostic, ToolSeverity } from '../editor-tooling';
import { authoringCollectionKeys, isAuthoringCollectionKey, type AuthoringCollectionKey } from './authoring-collections';
import { parseAssetData, isSafeProjectAssetPath, validateAssetAlias } from './authoring-assets';
import { validateCharacterData } from './authoring-characters';
import { validateDialogueData } from './authoring-dialogues';
import { validateDefaultLayoutSetting, validateLayoutData } from './authoring-layouts';
import { validateMaterialData } from './authoring-materials';
import { validateRoomData } from './authoring-rooms';
import { validateSceneData } from './authoring-scenes';
import { validateShaderData } from './authoring-shaders';
import { validateTestData } from './authoring-tests';
import { validateVariableData } from './authoring-variables';
import {
  authoringProjectSchema,
  isValidEntityId,
  type AuthoringProject,
  type ReferenceTarget,
} from './authoring-project';

function diagnostic(severity: ToolSeverity, path: string, message: string, category = 'authoring-schema'): ToolDiagnostic {
  return { severity, path, message, category };
}

function escapePathSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function targetExists(project: AuthoringProject, target: ReferenceTarget): boolean {
  return isAuthoringCollectionKey(target.collection) && !!project[target.collection][target.id];
}

function validateTarget(
  project: AuthoringProject,
  target: ReferenceTarget | null | undefined,
  path: string,
  diagnostics: ToolDiagnostic[],
) {
  if (!target) return;
  if (!isAuthoringCollectionKey(target.collection)) {
    diagnostics.push(diagnostic('error', `${path}/collection`, `Unknown collection '${String(target.collection)}'.`));
    return;
  }
  if (!targetExists(project, target)) {
    diagnostics.push(diagnostic('error', path, `Missing target '${target.collection}:${target.id}'.`));
  }
}

function validateAssets(project: AuthoringProject, diagnostics: ToolDiagnostic[]) {
  const aliases = new Map<string, string>();
  for (const [id, record] of Object.entries(project.assets)) {
    const basePath = `/assets/${escapePathSegment(id)}/data`;
    const data = parseAssetData(record.data);
    if (!data) {
      diagnostics.push(diagnostic('error', basePath, 'Asset record data must contain valid asset metadata.', 'authoring-assets'));
      continue;
    }
    if (!isSafeProjectAssetPath(data.source.path)) {
      diagnostics.push(diagnostic('error', `${basePath}/source/path`, 'Asset source path must be a safe project-relative path.', 'authoring-assets'));
    }
    const seen = new Set<string>();
    for (const [index, alias] of data.aliases.entries()) {
      const aliasPath = `${basePath}/aliases/${index}`;
      const aliasError = validateAssetAlias(alias);
      if (aliasError) diagnostics.push(diagnostic('error', aliasPath, aliasError, 'authoring-assets'));
      if (seen.has(alias)) diagnostics.push(diagnostic('error', aliasPath, `Duplicate alias '${alias}' in asset.`, 'authoring-assets'));
      seen.add(alias);
      const owner = aliases.get(alias);
      if (owner && owner !== id) {
        diagnostics.push(diagnostic('error', aliasPath, `Alias '${alias}' is already assigned to asset '${owner}'.`, 'authoring-assets'));
      } else {
        aliases.set(alias, id);
      }
    }
  }
}

function detectCycles(
  project: AuthoringProject,
  collection: AuthoringCollectionKey,
  field: 'parent' | 'inherits',
  diagnostics: ToolDiagnostic[],
) {
  const records = project[collection];
  for (const id of Object.keys(records)) {
    const seen = new Set<string>();
    let current: string | null = id;
    while (current) {
      if (seen.has(current)) {
        diagnostics.push(diagnostic('error', `/${collection}/${escapePathSegment(id)}/${field}`, `${field} chain contains a cycle.`));
        break;
      }
      seen.add(current);
      const nextTarget: ReferenceTarget | null | undefined = records[current]?.[field];
      current = nextTarget?.collection === collection ? nextTarget.id : null;
    }
  }
}

export function validateAuthoringProject(value: unknown): ToolDiagnostic[] {
  const diagnostics: ToolDiagnostic[] = [];
  const parsed = authoringProjectSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(diagnostic('error', `/${issue.path.map(String).map(escapePathSegment).join('/')}`, issue.message));
    }
    return diagnostics;
  }

  const project = parsed.data;

  if (!project.entrypoint) {
    diagnostics.push(diagnostic('warning', '/entrypoint', 'No project entrypoint is configured yet.'));
  } else {
    validateTarget(project, project.entrypoint, '/entrypoint', diagnostics);
  }

  for (const collection of authoringCollectionKeys) {
    const records = project[collection];
    for (const [id, record] of Object.entries(records)) {
      const basePath = `/${collection}/${escapePathSegment(id)}`;
      if (!isValidEntityId(id)) {
        diagnostics.push(diagnostic('error', `/${collection}/${escapePathSegment(id)}`, `Invalid record id '${id}'.`));
      }
      if (record.id !== id) {
        diagnostics.push(diagnostic('error', `${basePath}/id`, `Record id '${record.id}' must match map key '${id}'.`));
      }
      if (!record.label.trim()) {
        diagnostics.push(diagnostic('error', `${basePath}/label`, 'Record label is required.'));
      }
      if (record.parent) {
        if (record.parent.id === id && record.parent.collection === collection) {
          diagnostics.push(diagnostic('error', `${basePath}/parent`, 'Record cannot parent itself.'));
        }
        validateTarget(project, record.parent, `${basePath}/parent`, diagnostics);
      }
      if (record.inherits) {
        if (record.inherits.id === id && record.inherits.collection === collection) {
          diagnostics.push(diagnostic('error', `${basePath}/inherits`, 'Record cannot inherit from itself.'));
        }
        validateTarget(project, record.inherits, `${basePath}/inherits`, diagnostics);
      }
    }
    detectCycles(project, collection, 'parent', diagnostics);
    detectCycles(project, collection, 'inherits', diagnostics);
  }

  validateAssets(project, diagnostics);
  diagnostics.push(...validateDefaultLayoutSetting(project));

  for (const [id, record] of Object.entries(project.layouts)) {
    diagnostics.push(...validateLayoutData(project, id, record));
  }

  for (const [id, record] of Object.entries(project.variables)) {
    diagnostics.push(...validateVariableData(project, id, record));
  }

  for (const [id, record] of Object.entries(project.shaders)) {
    diagnostics.push(...validateShaderData(project, id, record));
  }
  for (const [id, record] of Object.entries(project.materials)) {
    diagnostics.push(...validateMaterialData(project, id, record));
  }
  for (const [id, record] of Object.entries(project.characters)) {
    diagnostics.push(...validateCharacterData(project, id, record));
  }
  for (const [id, record] of Object.entries(project.rooms)) {
    diagnostics.push(...validateRoomData(project, id, record));
  }
  for (const [id, record] of Object.entries(project.dialogues)) {
    diagnostics.push(...validateDialogueData(project, id, record));
  }
  for (const [id, record] of Object.entries(project.scenes)) {
    diagnostics.push(...validateSceneData(project, id, record));
  }
  for (const [id, record] of Object.entries(project.tests)) {
    diagnostics.push(...validateTestData(project, id, record));
  }

  return diagnostics;
}

export function authoringValidationSucceeded(diagnostics: ToolDiagnostic[]): boolean {
  return !diagnostics.some((item) => item.severity === 'error');
}
