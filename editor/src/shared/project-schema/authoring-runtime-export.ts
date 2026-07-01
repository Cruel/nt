import { parseAssetData, type AssetKind } from './authoring-assets';
import type { AuthoringProject, ReferenceTarget } from './authoring-project';
import type { ExportProfileData, ExportShaderVariant } from './authoring-export';
import { parseRoomData } from './authoring-rooms';
import { buildShaderMaterialProject } from './shader-material-project';
import type { PackageExportOptions, ToolDiagnostic } from '../editor-tooling';

export interface ExportFileEntry {
  source: string;
  packagePath: string;
  assetId?: string;
  kind?: AssetKind;
}

export type PackageFileEntry = ExportFileEntry;

export interface ExportManifestPreview {
  projectName: string;
  projectVersion: string;
  entryCount: number;
  assetCount: number;
  shaderVariants: string[];
  requiredShaderBinaryPaths: string[];
}

export interface AuthoringRuntimeExportBuildOptions {
  projectRoot?: string | null;
  profile: ExportProfileData;
}

export interface AuthoringRuntimeExportBuildResult {
  ok: boolean;
  runtimeProject?: unknown;
  shaderMaterialMetadata?: unknown;
  requiredShaderBinaryPaths: string[];
  fileEntries: ExportFileEntry[];
  manifestPreview: ExportManifestPreview;
  packageOptions: PackageExportOptions;
  diagnostics: ToolDiagnostic[];
}

const ENTITY_TYPE = {
  action: 2,
  room: 3,
  object: 4,
  dialogue: 5,
  script: 6,
  verb: 7,
  map: 8,
} as const;

function diagnostic(pathValue: string, message: string, severity: ToolDiagnostic['severity'] = 'error', category = 'authoring-export'): ToolDiagnostic {
  return { severity, path: pathValue, message, category };
}

function runtimeRef(type: number, id: string): [number, string] {
  return [type, id];
}

function mapReferenceToRuntime(ref: ReferenceTarget | null | undefined): [number, string] | null {
  if (!ref) return null;
  switch (ref.collection) {
    case 'rooms': return runtimeRef(ENTITY_TYPE.room, ref.id);
    case 'objects': return runtimeRef(ENTITY_TYPE.object, ref.id);
    case 'verbs': return runtimeRef(ENTITY_TYPE.verb, ref.id);
    case 'actions': return runtimeRef(ENTITY_TYPE.action, ref.id);
    case 'dialogues': return runtimeRef(ENTITY_TYPE.dialogue, ref.id);
    case 'scripts': return runtimeRef(ENTITY_TYPE.script, ref.id);
    case 'maps': return runtimeRef(ENTITY_TYPE.map, ref.id);
    default: return null;
  }
}

function packagePrefixForAsset(kind: AssetKind) {
  switch (kind) {
    case 'image': return 'textures';
    case 'font': return 'fonts';
    case 'audio': return 'audio';
    case 'script': return 'scripts';
    case 'text': return 'text';
    case 'data': return 'data';
    case 'shader-source': return 'resources/shaders';
    case 'binary': return 'resources';
  }
}

function safeBasename(sourcePath: string, fallback: string) {
  const name = sourcePath.split(/[\\/]/).pop() || fallback;
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function assetPackagePath(assetId: string, kind: AssetKind, sourcePath: string) {
  return `${packagePrefixForAsset(kind)}/${safeBasename(sourcePath, assetId)}`;
}

function absoluteSourcePath(projectRoot: string | null | undefined, sourcePath: string) {
  if (/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(sourcePath)) return sourcePath;
  const cleanSource = sourcePath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  if (!projectRoot) return cleanSource;
  return `${projectRoot.replace(/[\\/]+$/, '')}/${cleanSource}`;
}

function addAsset(project: AuthoringProject, assetIds: Set<string>, assetId: string | null | undefined, diagnostics: ToolDiagnostic[], sourcePath: string) {
  if (!assetId) return;
  const record = project.assets[assetId];
  if (!record) {
    diagnostics.push(diagnostic(sourcePath, `Missing referenced asset '${assetId}'.`, 'error', 'asset'));
    return;
  }
  if (!parseAssetData(record.data)) {
    diagnostics.push(diagnostic(`/assets/${assetId}/data`, `Asset '${assetId}' has invalid asset data.`, 'error', 'asset'));
    return;
  }
  assetIds.add(assetId);
}

function collectReferencedAssetIds(project: AuthoringProject, profile: ExportProfileData, diagnostics: ToolDiagnostic[]) {
  const assetIds = new Set<string>();
  if (profile.includeAllProjectAssets) {
    for (const assetId of Object.keys(project.assets)) assetIds.add(assetId);
    return assetIds;
  }

  for (const [roomId, record] of Object.entries(project.rooms)) {
    const data = parseRoomData(record.data);
    if (!data) continue;
    addAsset(project, assetIds, data.background.asset?.$ref.id, diagnostics, `/rooms/${roomId}/data/background/asset/$ref`);
  }

  for (const [materialId, record] of Object.entries(project.materials)) {
    const data = record.data && typeof record.data === 'object' ? record.data as { textures?: unknown } : null;
    const textures = Array.isArray(data?.textures) ? data.textures : [];
    textures.forEach((texture, index) => {
      const source = texture && typeof texture === 'object' ? (texture as { source?: unknown }).source : null;
      if (source && typeof source === 'object' && '$ref' in source) {
        const ref = (source as { $ref?: { collection?: string; id?: string } }).$ref;
        if (ref?.collection === 'assets') addAsset(project, assetIds, ref.id, diagnostics, `/materials/${materialId}/data/textures/${index}/source/$ref`);
      }
    });
  }

  return assetIds;
}

function buildFileEntries(project: AuthoringProject, options: AuthoringRuntimeExportBuildOptions, diagnostics: ToolDiagnostic[]) {
  const assetIds = collectReferencedAssetIds(project, options.profile, diagnostics);
  const entries: ExportFileEntry[] = [];
  for (const assetId of [...assetIds].sort()) {
    const data = parseAssetData(project.assets[assetId]?.data);
    if (!data) continue;
    if (options.profile.kind === 'runtime' && data.kind === 'shader-source') continue;
    entries.push({
      source: absoluteSourcePath(options.projectRoot, data.source.path),
      packagePath: assetPackagePath(assetId, data.kind, data.source.path),
      assetId,
      kind: data.kind,
    });
  }
  return entries;
}

function buildRooms(project: AuthoringProject, diagnostics: ToolDiagnostic[]) {
  const rooms: Record<string, unknown> = {};
  for (const [roomId, record] of Object.entries(project.rooms)) {
    const data = parseRoomData(record.data);
    if (!data) {
      diagnostics.push(diagnostic(`/rooms/${roomId}/data`, `Room '${roomId}' has invalid room data.`));
      continue;
    }
    const objects = data.hotspots
      .filter((hotspot) => hotspot.placeInRoom && hotspot.object?.$ref.id)
      .map((hotspot) => [hotspot.object!.$ref.id, true]);
    const paths = data.paths
      .filter((roomPath) => roomPath.target?.$ref.id)
      .sort((left, right) => left.order - right.order)
      .map((roomPath) => [roomPath.enabled, runtimeRef(ENTITY_TYPE.room, roomPath.target!.$ref.id)]);
    rooms[roomId] = [
      roomId,
      '',
      {},
      data.description.source,
      data.scripts.beforeEnter,
      data.scripts.afterEnter,
      data.scripts.beforeLeave,
      data.scripts.afterLeave,
      objects,
      paths,
      data.displayName || record.label,
    ];
  }
  return rooms;
}

function requiredShaderBinaryPaths(shaderMaterialMetadata: unknown, variants: readonly ExportShaderVariant[]) {
  const required = new Set<string>();
  const root = shaderMaterialMetadata && typeof shaderMaterialMetadata === 'object'
    ? shaderMaterialMetadata as { shaders?: Record<string, unknown> }
    : {};
  for (const shader of Object.values(root.shaders ?? {})) {
    const stages = shader && typeof shader === 'object' ? (shader as { stages?: Record<string, unknown> }).stages : null;
    for (const stage of Object.values(stages ?? {})) {
      const compiled = stage && typeof stage === 'object' ? (stage as { compiled?: Record<string, unknown> }).compiled : null;
      for (const variant of variants) {
        const runtimePath = compiled?.[variant];
        if (typeof runtimePath === 'string' && runtimePath.startsWith('project:/')) required.add(runtimePath.slice('project:/'.length));
      }
    }
  }
  return [...required].sort();
}

export function hasAuthoringShadersOrMaterials(project: AuthoringProject) {
  return Object.keys(project.shaders).length > 0 || Object.keys(project.materials).length > 0;
}

export function buildAuthoringRuntimeExport(
  project: AuthoringProject,
  options: AuthoringRuntimeExportBuildOptions,
): AuthoringRuntimeExportBuildResult {
  const diagnostics: ToolDiagnostic[] = [];
  const runtimeProject: Record<string, unknown> = {
    engine: 1,
    name: project.project.name,
    version: project.project.version,
    author: project.project.author,
    object: {},
    verb: {},
    action: {},
    room: buildRooms(project, diagnostics),
    map: {},
    dialogue: {},
    cutscene: {},
    script: {},
    startInv: [],
  };

  const runtimeEntrypoint = mapReferenceToRuntime(project.entrypoint);
  if (!project.entrypoint) {
    diagnostics.push(diagnostic('/entrypoint', 'Project entrypoint is required for runtime export.'));
  } else if (project.entrypoint.collection !== 'rooms' || !runtimeEntrypoint) {
    diagnostics.push(diagnostic('/entrypoint', `Entrypoint collection '${project.entrypoint.collection}' is not runtime-exportable yet.`));
  } else if (!project.rooms[project.entrypoint.id]) {
    diagnostics.push(diagnostic('/entrypoint', `Entrypoint room '${project.entrypoint.id}' does not exist.`));
  } else {
    runtimeProject.entrypoint = runtimeEntrypoint;
  }

  for (const [sceneId] of Object.entries(project.scenes)) diagnostics.push(diagnostic(`/scenes/${sceneId}`, 'Scene export is not runtime-compatible yet.', 'warning'));
  for (const [dialogueId] of Object.entries(project.dialogues)) diagnostics.push(diagnostic(`/dialogues/${dialogueId}`, 'Dialogue export is not runtime-compatible yet.', 'warning'));

  const shaderBuild = buildShaderMaterialProject(project);
  diagnostics.push(...shaderBuild.diagnostics.map((item) => ({ ...item, category: item.category ?? 'shader' })));
  const hasShaderMetadata = Object.keys(shaderBuild.project.shaders).length > 0 || Object.keys(shaderBuild.project.materials).length > 0;
  const shaderMaterialMetadata = hasShaderMetadata ? shaderBuild.project : undefined;
  const requiredShaderBinaryPaths = shaderMaterialMetadata ? requiredShaderBinaryPathsFromMetadata(shaderMaterialMetadata, options.profile.shaderVariants as ExportShaderVariant[]) : [];
  const fileEntries = buildFileEntries(project, options, diagnostics);
  const manifestPreview: ExportManifestPreview = {
    projectName: project.project.name,
    projectVersion: project.project.version,
    entryCount: 1 + fileEntries.length + requiredShaderBinaryPaths.length + (shaderMaterialMetadata ? 1 : 0),
    assetCount: fileEntries.length,
    shaderVariants: options.profile.shaderVariants,
    requiredShaderBinaryPaths,
  };
  const packageOptions: PackageExportOptions = {
    kind: options.profile.kind,
    projectName: project.project.name,
    projectVersion: project.project.version,
    createdBy: 'noveltea-editor',
    includeChecksums: options.profile.includeChecksums,
    stripShaderSources: options.profile.stripShaderSources,
    shaderVariants: options.profile.shaderVariants,
    shaderMaterialMetadata,
    requiredShaderBinaryPaths,
    fileEntries: fileEntries.map((entry) => ({ source: entry.source, packagePath: entry.packagePath })),
  };

  return {
    ok: !diagnostics.some((item) => item.severity === 'error'),
    runtimeProject,
    shaderMaterialMetadata,
    requiredShaderBinaryPaths,
    fileEntries,
    manifestPreview,
    packageOptions,
    diagnostics,
  };
}

function requiredShaderBinaryPathsFromMetadata(shaderMaterialMetadata: unknown, variants: readonly ExportShaderVariant[]) {
  return requiredShaderBinaryPaths(shaderMaterialMetadata, variants);
}
