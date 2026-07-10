import { buildJsonPointer, hasJsonAtPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import { layoutRecordRef, systemLayoutRoleValues, type SystemLayoutRole } from '../../shared/project-schema/authoring-layouts';
import { assetRef, normalizeProjectDisplaySettings, roomEntrypointRef, type ProjectDisplaySettings } from '../../shared/project-schema/authoring-project-settings';
import { isAuthoringProject, type ReferenceTarget } from '../../shared/project-schema/authoring-project';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import { isTagColor, normalizeTagKey, normalizeTagName } from '../../shared/project-schema/authoring-tags';
import { EDITOR_PROJECT_STATE_SCHEMA, EDITOR_PROJECT_STATE_SCHEMA_VERSION } from '../../shared/project-schema/editor-project-state';
import type { JsonPatchOperation } from './json-patch';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';

export interface UpdateProjectMetadataPayload {
  name?: string;
  version?: string;
  author?: string;
  description?: string;
}

export interface SetProjectEntrypointPayload {
  target: ReferenceTarget | null;
}

export interface SetProjectStartupPayload {
  initScript: string;
}

export type SetProjectDisplayPayload = ProjectDisplaySettings;

export interface SetProjectSystemLayoutPayload {
  role: SystemLayoutRole;
  layoutId: string | null;
}

export interface SetProjectDefaultFontPayload {
  assetId: string | null;
}

export interface SetProjectTitleScreenPayload {
  titleImageId?: string | null;
  showProjectTitle?: boolean;
  showAuthor?: boolean;
  subtitle?: string;
  startLabel?: string;
}

export interface SetProjectIconPayload {
  assetId: string | null;
}

export interface SetProjectTagColorPayload {
  tag: string;
  color: string;
}

function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function ensureSettingsObject(patches: JsonPatchOperation[], documentValue: JsonValue, path: string) {
  if (!hasJsonAtPointer(documentValue, path)) patches.push({ op: 'add', path, value: {} });
}

function ensureEditorTagObjects(patches: JsonPatchOperation[], documentValue: JsonValue) {
  if (!hasJsonAtPointer(documentValue, '/editor')) {
    patches.push({
      op: 'add',
      path: '/editor',
      value: toJsonValue({ schema: EDITOR_PROJECT_STATE_SCHEMA, schemaVersion: EDITOR_PROJECT_STATE_SCHEMA_VERSION, tags: { records: {} } }),
    });
    return;
  }
  if (!hasJsonAtPointer(documentValue, '/editor/tags')) {
    patches.push({ op: 'add', path: '/editor/tags', value: toJsonValue({ records: {} }) });
    return;
  }
  if (!hasJsonAtPointer(documentValue, '/editor/tags/records')) {
    patches.push({ op: 'add', path: '/editor/tags/records', value: {} });
  }
}

function patchValue(documentValue: JsonValue, path: string, value: unknown): JsonPatchOperation {
  return { op: hasJsonAtPointer(documentValue, path) ? 'replace' : 'add', path, value: toJsonValue(value) };
}

function validateAssetKind(document: unknown, assetId: string, expectedKind: 'font' | 'image', path: string): EntityOperationDiagnostic | null {
  if (!isAuthoringProject(document)) return error('Current document is not a NovelTea authoring project.');
  const asset = document.assets[assetId];
  if (!asset) return error(`Asset '${assetId}' does not exist.`, path);
  const data = parseAssetData(asset.data);
  if (!data) return error(`Asset '${assetId}' does not contain valid asset metadata.`, path);
  if (data.kind !== expectedKind) return error(`Asset '${assetId}' is ${data.kind}, not ${expectedKind}.`, path);
  return null;
}

export function updateProjectMetadataPatches(document: unknown, payload: UpdateProjectMetadataPayload): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  const patches: JsonPatchOperation[] = [];
  const documentValue = toJsonValue(document);
  const nextVersion = payload.version ?? document.project.version;
  if (!nextVersion.trim()) return { patches: [], diagnostics: [error('Project version is required.', '/project/version')] };
  for (const key of ['name', 'version', 'author', 'description'] as const) {
    if (payload[key] !== undefined) patches.push(patchValue(documentValue, buildJsonPointer(['project', key]), payload[key]));
  }
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function setProjectEntrypointPatches(document: unknown, payload: SetProjectEntrypointPayload): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  if (payload.target && !document[payload.target.collection]?.[payload.target.id]) {
    return { patches: [], diagnostics: [error(`Entrypoint target '${payload.target.collection}:${payload.target.id}' does not exist.`, '/entrypoint')] };
  }
  return {
    patches: [{ op: 'replace', path: '/entrypoint', value: toJsonValue(payload.target) }],
    affectedPaths: ['/entrypoint'],
  };
}

export function setProjectStartupPatches(document: unknown, payload: SetProjectStartupPayload): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  const patches: JsonPatchOperation[] = [];
  const documentValue = toJsonValue(document);
  ensureSettingsObject(patches, documentValue, '/settings/startup');
  patches.push(patchValue(documentValue, '/settings/startup/initScript', payload.initScript));
  return { patches, affectedPaths: ['/settings/startup/initScript'] };
}

export function setProjectDisplayPatches(document: unknown, payload: SetProjectDisplayPayload): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  try {
    const value = normalizeProjectDisplaySettings(payload);
    const documentValue = toJsonValue(document);
    return {
      patches: [patchValue(documentValue, '/settings/display', value)],
      affectedPaths: ['/settings/display'],
    };
  } catch {
    return { patches: [], diagnostics: [error('Display settings are invalid.', '/settings/display')] };
  }
}

export function setProjectSystemLayoutPatches(document: unknown, payload: SetProjectSystemLayoutPayload): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  if (!systemLayoutRoleValues.includes(payload.role)) {
    return { patches: [], diagnostics: [error('Unknown system layout role.', '/settings/ui/systemLayouts')] };
  }
  if (payload.layoutId !== null && !document.layouts[payload.layoutId]) {
    return { patches: [], diagnostics: [error('System layout record does not exist.', buildJsonPointer(['layouts', payload.layoutId]))] };
  }
  const patches: JsonPatchOperation[] = [];
  const documentValue = toJsonValue(document);
  ensureSettingsObject(patches, documentValue, '/settings/ui');
  ensureSettingsObject(patches, documentValue, '/settings/ui/systemLayouts');
  const path = buildJsonPointer(['settings', 'ui', 'systemLayouts', payload.role]);
  patches.push(patchValue(documentValue, path, payload.layoutId === null ? null : layoutRecordRef(payload.layoutId)));
  return { patches, affectedPaths: [path] };
}

export function setProjectDefaultFontPatches(document: unknown, payload: SetProjectDefaultFontPayload): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  if (payload.assetId !== null) {
    const assetError = validateAssetKind(document, payload.assetId, 'font', buildJsonPointer(['assets', payload.assetId]));
    if (assetError) return { patches: [], diagnostics: [assetError] };
  }
  const patches: JsonPatchOperation[] = [];
  const documentValue = toJsonValue(document);
  ensureSettingsObject(patches, documentValue, '/settings/text');
  patches.push(patchValue(documentValue, '/settings/text/defaultFont', payload.assetId === null ? null : assetRef(payload.assetId)));
  return { patches, affectedPaths: ['/settings/text/defaultFont'] };
}

export function setProjectTitleScreenPatches(document: unknown, payload: SetProjectTitleScreenPayload): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  if (payload.titleImageId) {
    const assetError = validateAssetKind(document, payload.titleImageId, 'image', buildJsonPointer(['assets', payload.titleImageId]));
    if (assetError) return { patches: [], diagnostics: [assetError] };
  }
  if (payload.startLabel !== undefined && !payload.startLabel.trim()) {
    return { patches: [], diagnostics: [error('Start label is required.', '/settings/titleScreen/startLabel')] };
  }
  const patches: JsonPatchOperation[] = [];
  const documentValue = toJsonValue(document);
  ensureSettingsObject(patches, documentValue, '/settings/titleScreen');
  const set = (key: string, value: unknown) => patches.push(patchValue(documentValue, buildJsonPointer(['settings', 'titleScreen', key]), value));
  if (payload.titleImageId !== undefined) set('titleImage', payload.titleImageId === null ? null : assetRef(payload.titleImageId));
  if (payload.showProjectTitle !== undefined) set('showProjectTitle', payload.showProjectTitle);
  if (payload.showAuthor !== undefined) set('showAuthor', payload.showAuthor);
  if (payload.subtitle !== undefined) set('subtitle', payload.subtitle);
  if (payload.startLabel !== undefined) set('startLabel', payload.startLabel);
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export function setProjectIconPatches(document: unknown, payload: SetProjectIconPayload): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  if (payload.assetId !== null) {
    const assetError = validateAssetKind(document, payload.assetId, 'image', buildJsonPointer(['assets', payload.assetId]));
    if (assetError) return { patches: [], diagnostics: [assetError] };
  }
  const patches: JsonPatchOperation[] = [];
  const documentValue = toJsonValue(document);
  ensureSettingsObject(patches, documentValue, '/settings/app');
  patches.push(patchValue(documentValue, '/settings/app/icon', payload.assetId === null ? null : assetRef(payload.assetId)));
  return { patches, affectedPaths: ['/settings/app/icon'] };
}

export function setProjectTagColorPatches(document: unknown, payload: SetProjectTagColorPayload): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  const name = normalizeTagName(payload.tag);
  if (!name) return { patches: [], diagnostics: [error('Tag name is required.', '/editor/tags')] };
  if (!isTagColor(payload.color)) return { patches: [], diagnostics: [error('Tag color must be one of the built-in tag colors.', '/editor/tags')] };
  const key = normalizeTagKey(name);
  const documentValue = toJsonValue(document);
  const patches: JsonPatchOperation[] = [];
  ensureEditorTagObjects(patches, documentValue);
  const path = buildJsonPointer(['editor', 'tags', 'records', key]);
  patches.push(patchValue(documentValue, path, { name, color: payload.color }));
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

export { roomEntrypointRef };
