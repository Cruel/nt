import { parseAssetData, type AssetKind } from './authoring-assets';
import type { AuthoringProject } from './authoring-project';
import type { ExportProfileData, ExportShaderVariant } from './authoring-export';
import { parseDialogueData } from './authoring-dialogues';
import { parseRoomData } from './authoring-rooms';
import { parseSceneData } from './authoring-scenes';
import { getSystemLayoutSetting, parseLayoutData } from './authoring-layouts';
import { parseVariableData } from './authoring-variables';
import { buildShaderMaterialProject } from './shader-material-project';
import type { PackageExportOptions, ToolDiagnostic } from '../editor-tooling';
import { normalizeProjectDisplaySettings, projectSettingsFromProject } from './authoring-project-settings';
import { RUNTIME_PROJECT_SCHEMA, RUNTIME_PROJECT_SCHEMA_VERSION, runtimeProjectSchema } from './runtime-project';

export interface ExportFileEntry { source: string; packagePath: string; assetId?: string; kind?: AssetKind }
export type PackageFileEntry = ExportFileEntry;
export interface ExportManifestPreview {
  projectName: string; projectVersion: string; entryCount: number; assetCount: number;
  shaderVariants: string[]; requiredShaderBinaryPaths: string[];
  display?: { aspect_ratio: { width: number; height: number }; orientation: 'landscape' | 'portrait'; bar_color: string };
  platform?: PackageExportOptions['platform'];
}
export interface AuthoringRuntimeExportBuildOptions { projectRoot?: string | null; profile: ExportProfileData }
export interface AuthoringRuntimeExportBuildResult {
  ok: boolean; runtimeProject?: unknown; shaderMaterialMetadata?: unknown;
  requiredShaderBinaryPaths: string[]; fileEntries: ExportFileEntry[];
  manifestPreview: ExportManifestPreview; packageOptions: PackageExportOptions; diagnostics: ToolDiagnostic[];
}

type RuntimeEntrypointKind = 'room' | 'dialogue' | 'scene' | 'script';
const entrypointKinds: Partial<Record<string, RuntimeEntrypointKind>> = {
  rooms: 'room', dialogues: 'dialogue', scenes: 'scene', scripts: 'script',
};
function diagnostic(path: string, message: string, severity: ToolDiagnostic['severity'] = 'error', category = 'authoring-export'): ToolDiagnostic {
  return { severity, path, message, category };
}
function packagePrefixForAsset(kind: AssetKind) {
  if (kind === 'image') return 'textures';
  if (kind === 'font') return 'fonts';
  if (kind === 'audio') return 'audio';
  if (kind === 'script') return 'scripts';
  if (kind === 'text') return 'text';
  if (kind === 'data') return 'data';
  if (kind === 'shader-source') return 'resources/shaders';
  return 'resources';
}
function safeBasename(path: string, fallback: string) {
  return (path.split(/[\\/]/).pop() || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}
function assetPackagePath(id: string, kind: AssetKind, source: string) { return `${packagePrefixForAsset(kind)}/${safeBasename(source, id)}`; }
function absoluteSourcePath(root: string | null | undefined, source: string) {
  if (/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(source)) return source;
  const clean = source.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  return root ? `${root.replace(/[\\/]+$/, '')}/${clean}` : clean;
}
function collectAssetIds(project: AuthoringProject, profile: ExportProfileData, diagnostics: ToolDiagnostic[]) {
  const ids = new Set<string>();
  if (profile.includeAllProjectAssets) Object.keys(project.assets).forEach((id) => ids.add(id));
  for (const [roomId, record] of Object.entries(project.rooms)) {
    const id = parseRoomData(record.data)?.background.asset?.$ref.id;
    if (!id) continue;
    if (!project.assets[id]) diagnostics.push(diagnostic(`/rooms/${roomId}/data/background/asset/$ref`, `Missing referenced asset '${id}'.`, 'error', 'asset'));
    else ids.add(id);
  }
  return ids;
}
function buildFileEntries(project: AuthoringProject, options: AuthoringRuntimeExportBuildOptions, diagnostics: ToolDiagnostic[]) {
  return [...collectAssetIds(project, options.profile, diagnostics)].sort().flatMap((id): ExportFileEntry[] => {
    const data = parseAssetData(project.assets[id]?.data);
    if (!data || (options.profile.kind === 'runtime' && data.kind === 'shader-source')) return [];
    return [{ source: absoluteSourcePath(options.projectRoot, data.source.path), packagePath: assetPackagePath(id, data.kind, data.source.path), assetId: id, kind: data.kind }];
  });
}
function buildVariables(project: AuthoringProject, diagnostics: ToolDiagnostic[]) {
  const result: Record<string, unknown> = {};
  for (const [id, record] of Object.entries(project.variables)) {
    const data = parseVariableData(record.data);
    if (!data) diagnostics.push(diagnostic(`/variables/${id}/data`, `Variable '${id}' has invalid variable data.`, 'warning'));
    else result[data.runtimeName?.trim() || id] = data.defaultValue;
  }
  return result;
}
function buildRooms(project: AuthoringProject, diagnostics: ToolDiagnostic[]) {
  return Object.entries(project.rooms).flatMap(([id, record]) => {
    const data = parseRoomData(record.data);
    if (!data) { diagnostics.push(diagnostic(`/rooms/${id}/data`, `Room '${id}' has invalid room data.`)); return []; }
    return [{ id, name: data.displayName || record.label, description: data.description.source,
      objectIds: data.hotspots.filter((item) => item.placeInRoom).flatMap((item) => item.object?.$ref.id ? [item.object.$ref.id] : []),
      verbIds: [] }];
  });
}
function simpleRecords(collection: AuthoringProject['objects']) {
  return Object.entries(collection).map(([id, record]) => ({ id, name: record.label, description: record.description ?? '', verbIds: [] }));
}
function buildDialogues(project: AuthoringProject, diagnostics: ToolDiagnostic[]) {
  return Object.entries(project.dialogues).flatMap(([id, record]) => {
    const data = parseDialogueData(record.data);
    if (!data) { diagnostics.push(diagnostic(`/dialogues/${id}/data`, `Dialogue '${id}' has invalid dialogue data.`)); return []; }
    data.blocks.forEach((block, blockIndex) => block.segments.forEach((segment, segmentIndex) => {
      const path = `/dialogues/${id}/data/blocks/${blockIndex}/segments/${segmentIndex}`;
      if (segment.condition.enabled) diagnostics.push(diagnostic(`${path}/condition`, `Dialogue condition '${segment.id}' remains a deferred runtime feature.`, 'warning'));
      if (segment.text.mode === 'lua') diagnostics.push(diagnostic(`${path}/text/mode`, `Lua dialogue text '${segment.id}' is exported as source text.`, 'warning'));
    }));
    const nodes = data.blocks.filter((block) => block.type !== 'comment').map((block) => ({
      id: block.id, text: block.segments.filter((segment) => segment.type !== 'comment' && segment.type !== 'script').map((segment) => segment.text.source).join('\n'),
      choices: data.edges.filter((edge) => edge.fromBlockId === block.id).map((edge) => ({ label: edge.label || edge.toBlockId, nextNodeId: edge.toBlockId })),
    }));
    return [{ id, nodes }];
  });
}
function buildScenes(project: AuthoringProject, diagnostics: ToolDiagnostic[]) {
  return Object.entries(project.scenes).flatMap(([id, record]) => {
    const data = parseSceneData(record.data);
    if (!data) { diagnostics.push(diagnostic(`/scenes/${id}/data`, `Scene '${id}' has invalid scene data.`)); return []; }
    data.steps.forEach((step, index) => {
      if (!['comment', 'wait', 'script', 'dialogue', 'layout'].includes(step.type)) diagnostics.push(diagnostic(`/scenes/${id}/data/steps/${index}`, `Scene step '${step.type}' requires a future typed action payload.`, 'warning'));
    });
    return [{ id, steps: data.steps.filter((step) => step.enabled).map((step) => step.id) }];
  });
}
function buildScripts(project: AuthoringProject) {
  return Object.entries(project.scripts).map(([id, record]) => ({ id, source: typeof record.data.source === 'string' ? record.data.source : '' }));
}
function buildLayouts(project: AuthoringProject, assets: { id: string }[]) {
  const assetIds = new Set(assets.map((asset) => asset.id));
  return Object.entries(project.layouts).flatMap(([id, record]) => {
    const data = parseLayoutData(record.data); const assetId = data?.rml.sourceAsset?.$ref.id;
    return assetId && assetIds.has(assetId) ? [{ id, documentAssetId: assetId }] : [];
  });
}
function requiredShaderBinaryPaths(metadata: unknown, variants: readonly ExportShaderVariant[]) {
  const required = new Set<string>();
  const shaders = metadata && typeof metadata === 'object' ? (metadata as { shaders?: Record<string, { stages?: Record<string, { compiled?: Record<string, unknown> }> }> }).shaders : undefined;
  for (const shader of Object.values(shaders ?? {})) for (const stage of Object.values(shader.stages ?? {})) for (const variant of variants) {
    const path = stage.compiled?.[variant]; if (typeof path === 'string' && path.startsWith('project:/')) required.add(path.slice(9));
  }
  return [...required].sort();
}
export function hasAuthoringShadersOrMaterials(project: AuthoringProject) { return Object.keys(project.shaders).length > 0 || Object.keys(project.materials).length > 0; }

export function buildAuthoringRuntimeExport(project: AuthoringProject, options: AuthoringRuntimeExportBuildOptions): AuthoringRuntimeExportBuildResult {
  const diagnostics: ToolDiagnostic[] = [];
  const display = normalizeProjectDisplaySettings(projectSettingsFromProject(project).display);
  const runtimeDisplay = { aspect_ratio: display.aspectRatio, orientation: display.orientation, bar_color: display.barColor };
  const portrait = display.orientation === 'portrait';
  const platform: NonNullable<PackageExportOptions['platform']> = {
    orientation: display.orientation,
    desktop: { initialWidth: portrait ? 720 : 1280, initialHeight: portrait ? 1280 : 720, arguments: ['--display-orientation', display.orientation] },
    web: { orientation: display.orientation, query: `orientation=${display.orientation}` },
    android: { orientation: display.orientation, gradleProperty: `novelteaOrientation=${display.orientation}`, screenOrientation: portrait ? 'sensorPortrait' : 'sensorLandscape' },
  };
  const fileEntries = buildFileEntries(project, options, diagnostics);
  const assets = fileEntries.map((entry) => ({ id: entry.assetId!, path: `project:/${entry.packagePath}`, mediaType: entry.kind ?? 'binary' }));
  const kind = project.entrypoint ? entrypointKinds[project.entrypoint.collection] : undefined;
  if (!project.entrypoint) diagnostics.push(diagnostic('/entrypoint', 'Project entrypoint is required for runtime export.'));
  else if (!kind) diagnostics.push(diagnostic('/entrypoint', `Entrypoint collection '${project.entrypoint.collection}' is not runtime-exportable yet.`));
  else if (!project[project.entrypoint.collection][project.entrypoint.id]) diagnostics.push(diagnostic('/entrypoint', `Entrypoint ${kind} '${project.entrypoint.id}' does not exist.`));
  const layouts = buildLayouts(project, assets);
  const defaultLayout = getSystemLayoutSetting(project, 'game-hud')?.$ref.id;
  const runtimeProject = {
    schema: RUNTIME_PROJECT_SCHEMA, schemaVersion: RUNTIME_PROJECT_SCHEMA_VERSION,
    identity: { id: project.project.id, name: project.project.name, version: project.project.version, author: project.project.author, website: '' },
    settings: { locale: 'en', defaultFont: '', allowSaves: true },
    entrypoint: { kind: kind ?? 'room', id: project.entrypoint?.id ?? '' }, variables: buildVariables(project, diagnostics), assets, assetAliases: [],
    rooms: buildRooms(project, diagnostics), objects: simpleRecords(project.objects),
    verbs: Object.entries(project.verbs).map(([id, record]) => ({ id, label: record.label })), actions: [],
    dialogues: buildDialogues(project, diagnostics), scenes: buildScenes(project, diagnostics), maps: [], scripts: buildScripts(project), layouts,
    runtimeUi: { defaultLayoutId: defaultLayout && layouts.some((layout) => layout.id === defaultLayout) ? defaultLayout : null, themeAssetId: null },
    display: runtimeDisplay, platform,
  };
  const checkedRuntimeProject = runtimeProjectSchema.safeParse(runtimeProject);
  if (!checkedRuntimeProject.success) diagnostics.push(...checkedRuntimeProject.error.issues.map((issue) => diagnostic(`/${issue.path.join('/')}`, issue.message)));
  const shaderBuild = buildShaderMaterialProject(project);
  diagnostics.push(...shaderBuild.diagnostics.map((item) => ({ ...item, category: item.category ?? 'shader' })));
  const hasMetadata = Object.keys(shaderBuild.project.shaders).length > 0 || Object.keys(shaderBuild.project.materials).length > 0;
  const shaderMaterialMetadata = hasMetadata ? shaderBuild.project : undefined;
  const shaderVariants = shaderMaterialMetadata ? options.profile.shaderVariants : [];
  const required = shaderMaterialMetadata ? requiredShaderBinaryPaths(shaderMaterialMetadata, shaderVariants) : [];
  const manifestPreview = { projectName: project.project.name, projectVersion: project.project.version, entryCount: 1 + fileEntries.length + required.length + (shaderMaterialMetadata ? 1 : 0), assetCount: fileEntries.length, shaderVariants, requiredShaderBinaryPaths: required, display: runtimeDisplay, platform };
  const packageOptions: PackageExportOptions = { kind: options.profile.kind, projectName: project.project.name, projectVersion: project.project.version, createdBy: 'noveltea-editor', includeChecksums: options.profile.includeChecksums, stripShaderSources: options.profile.stripShaderSources, shaderVariants, shaderMaterialMetadata, requiredShaderBinaryPaths: required, fileEntries: fileEntries.map(({ source, packagePath }) => ({ source, packagePath })), display: runtimeDisplay, platform };
  return { ok: !diagnostics.some((item) => item.severity === 'error'), runtimeProject: checkedRuntimeProject.success ? checkedRuntimeProject.data : runtimeProject, shaderMaterialMetadata, requiredShaderBinaryPaths: required, fileEntries, manifestPreview, packageOptions, diagnostics };
}
