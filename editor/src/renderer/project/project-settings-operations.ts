import { buildJsonPointer, hasJsonAtPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import { defaultLayoutRef } from '../../shared/project-schema/authoring-layouts';
import { assetRef, roomEntrypointRef } from '../../shared/project-schema/authoring-project-settings';
import { isAuthoringProject, type ReferenceTarget } from '../../shared/project-schema/authoring-project';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
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

export interface SetProjectDefaultLayoutPayload {
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

export interface SetProjectComfyUiPayload {
  enabled?: boolean;
  serverUrl?: string;
  defaultWorkflowId?: string;
  requestTimeoutMs?: number;
  connectionCheckIntervalMs?: number;
}

function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function ensureSettingsObject(patches: JsonPatchOperation[], documentValue: JsonValue, path: string) {
  if (!hasJsonAtPointer(documentValue, path)) patches.push({ op: 'add', path, value: {} });
}

function patchValue(documentValue: JsonValue, path: string, value: unknown): JsonPatchOperation {
  return { op: hasJsonAtPointer(documentValue, path) ? 'replace' : 'add', path, value: toJsonValue(value) };
}

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, '');
}

function validateComfyUiServerUrl(serverUrl: string): EntityOperationDiagnostic | null {
  try {
    const url = new URL(normalizeServerUrl(serverUrl));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return error('ComfyUI server URL must use http or https.', '/settings/comfyui/serverUrl');
    }
    return null;
  } catch {
    return error('ComfyUI server URL is invalid.', '/settings/comfyui/serverUrl');
  }
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

export function setProjectDefaultLayoutPatches(document: unknown, payload: SetProjectDefaultLayoutPayload): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  if (payload.layoutId !== null && !document.layouts[payload.layoutId]) {
    return { patches: [], diagnostics: [error('Default layout record does not exist.', buildJsonPointer(['layouts', payload.layoutId]))] };
  }
  const patches: JsonPatchOperation[] = [];
  const documentValue = toJsonValue(document);
  ensureSettingsObject(patches, documentValue, '/settings/ui');
  patches.push(patchValue(documentValue, '/settings/ui/defaultLayout', payload.layoutId === null ? null : defaultLayoutRef(payload.layoutId)));
  return { patches, affectedPaths: ['/settings/ui/defaultLayout'] };
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

export function setProjectComfyUiPatches(document: unknown, payload: SetProjectComfyUiPayload): EntityOperationResult {
  if (!isAuthoringProject(document)) return { patches: [], diagnostics: [error('Current document is not a NovelTea authoring project.')] };
  if (payload.serverUrl !== undefined) {
    const urlError = validateComfyUiServerUrl(payload.serverUrl);
    if (urlError) return { patches: [], diagnostics: [urlError] };
  }
  const patches: JsonPatchOperation[] = [];
  const documentValue = toJsonValue(document);
  ensureSettingsObject(patches, documentValue, '/settings/comfyui');
  const affectedPaths: string[] = [];
  const set = (key: keyof SetProjectComfyUiPayload, value: unknown) => {
    const path = buildJsonPointer(['settings', 'comfyui', key]);
    patches.push(patchValue(documentValue, path, value));
    affectedPaths.push(path);
  };
  if (payload.enabled !== undefined) set('enabled', payload.enabled);
  if (payload.serverUrl !== undefined) set('serverUrl', normalizeServerUrl(payload.serverUrl));
  if (payload.defaultWorkflowId !== undefined) set('defaultWorkflowId', payload.defaultWorkflowId.trim());
  if (payload.requestTimeoutMs !== undefined) set('requestTimeoutMs', payload.requestTimeoutMs);
  if (payload.connectionCheckIntervalMs !== undefined) set('connectionCheckIntervalMs', payload.connectionCheckIntervalMs);
  return { patches, affectedPaths };
}

export { roomEntrypointRef };
