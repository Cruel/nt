import { z } from 'zod';
import type {
  AuthoringDependencyGraphDiagnostic,
  AuthoringDependencyGraphSnapshot,
} from '../../shared/authoring-dependency-contracts';
import {
  focusedRecordPreviewDocumentSchema,
  layoutPreviewInputsSchema,
  projectNativeManifest,
  roomPreviewInputsSchema,
  shaderPreviewInputsSchema,
  type FocusedPreviewDocumentKind,
  type FocusedPreviewHostCapabilities,
  type FocusedRecordPreviewDocument,
  type PreviewResourceManifestEntry,
  type PreviewRootKey,
} from '../../shared/focused-preview-contracts';
import { effectivePreviewDisplay } from '../../shared/preview-display';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import type { AuthoringSourceAnalysisArtifact } from '../../shared/project-schema/authoring-lua-analysis';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import {
  parseLayoutData,
  resolveLayoutScalePolicy,
} from '../../shared/project-schema/authoring-layouts';
import { authoredLayoutSourceUrl } from '../../shared/project-schema/layout-source-url';
import {
  parseMaterialData,
  resolveMaterialData,
} from '../../shared/project-schema/authoring-materials';
import { projectSettingsFromProject } from '../../shared/project-schema/authoring-project-settings';
import {
  canonicalRuntimeShaderOutputPath,
  compiledShaderFetchProjectRelativePath,
  hasCompleteShaderCompiledOutputMetadata,
  parseShaderData,
  shaderCompiledOutputIsFresh,
  type ShaderStage,
} from '../../shared/project-schema/authoring-shaders';
import {
  buildMaterialDefinition,
  buildShaderDefinition,
  SHADER_MATERIAL_SCHEMA,
} from '../../shared/project-schema/shader-material-project';
import type { ShaderVariant } from '../../shared/shader-variants';
import { sha256PrefixedUtf8 } from '../../shared/sha256';
import { buildFocusedRoomPreview } from './room-focused-preview-builder';

export interface FocusedPreviewBuildContext<TInputs> {
  project: AuthoringProject;
  projectInstanceId: string;
  projectRevision: number;
  root: PreviewRootKey;
  inputs: TInputs;
  inputRevision: `sha256:${string}`;
  graph: AuthoringDependencyGraphSnapshot | null;
  sourceAnalysis: readonly AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[];
  hostCapabilities: FocusedPreviewHostCapabilities;
}

export interface FocusedPreviewAdapter<TInputs = unknown> {
  kind: FocusedPreviewDocumentKind;
  inputSchema: z.ZodType<TInputs>;
  topologyDependent: boolean;
  owningPath(root: PreviewRootKey): string;
  build(context: FocusedPreviewBuildContext<TInputs>): FocusedRecordPreviewDocument;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function canonicalFocusedPreviewInputRevision(value: unknown): `sha256:${string}` {
  return sha256PrefixedUtf8(JSON.stringify(canonicalize(value)));
}

function assetManifestEntry(
  project: AuthoringProject,
  assetId: string,
  usageRole: string,
): PreviewResourceManifestEntry {
  const parsed = parseAssetData(project.assets[assetId]?.data);
  if (!parsed)
    throw new Error(`Focused preview Asset '${assetId}' is missing or structurally invalid.`);
  if (!parsed.contentHash?.match(/^sha256:[0-9a-f]{64}$/) || parsed.byteSize === undefined)
    throw new Error(`Focused preview Asset '${assetId}' must be reimported before preview.`);
  const base = {
    resourceId: `asset:${assetId}`,
    sourceKind: 'authoring-asset' as const,
    assetId,
    usageRoles: [usageRole],
    fetchProjectRelativePath: parsed.source.path,
    logicalPath: `project:/${parsed.source.path}`,
    contentHash: parsed.contentHash as `sha256:${string}`,
    byteSize: parsed.byteSize,
  };
  return parsed.kind === 'image'
    ? { ...base, kind: 'image', sampling: parsed.sampling ?? 'linear' }
    : { ...base, kind: parsed.kind };
}

function runtimeShaderPath(path: string): string {
  const normalized = canonicalRuntimeShaderOutputPath(path);
  if (!normalized)
    throw new Error(
      `Compiled Shader output path '${path}' is not a canonical runtime Shader path.`,
    );
  return normalized;
}

function shaderManifestEntries(
  project: AuthoringProject,
  shaderId: string,
  variant: ShaderVariant,
  usageRole: string,
): PreviewResourceManifestEntry[] {
  const shader = parseShaderData(project.shaders[shaderId]?.data);
  if (!shader) throw new Error(`Focused preview Shader '${shaderId}' is missing or invalid.`);
  return shader.stages
    .map((stage, stageIndex): PreviewResourceManifestEntry => {
      const output = stage.compiled[variant];
      if (!output || !hasCompleteShaderCompiledOutputMetadata(output))
        throw new Error(
          `Shader '${shaderId}' ${stage.stage} output for '${variant}' is missing complete compile metadata. Recompile the Shader.`,
        );
      if (!shaderCompiledOutputIsFresh(project, shaderId, stageIndex, variant, output))
        throw new Error(
          `Shader '${shaderId}' ${stage.stage} output for '${variant}' is stale. Recompile the Shader.`,
        );
      const logicalPath = runtimeShaderPath(output.path);
      const fetchProjectRelativePath = compiledShaderFetchProjectRelativePath(logicalPath);
      if (!fetchProjectRelativePath)
        throw new Error(`Compiled Shader output path '${output.path}' cannot be staged.`);
      return {
        resourceId: `shader:${shaderId}:${stage.stage}:${variant}`,
        sourceKind: 'shader-compiled-output',
        shaderId,
        shaderStage: stage.stage as ShaderStage,
        shaderVariant: variant,
        usageRoles: [usageRole],
        fetchProjectRelativePath,
        logicalPath,
        contentHash: output.byteHash as `sha256:${string}`,
        byteSize: output.byteSize,
        kind: 'shader-binary',
      };
    })
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

function canonicalManifest(
  entries: readonly PreviewResourceManifestEntry[],
): PreviewResourceManifestEntry[] {
  const byId = new Map<string, PreviewResourceManifestEntry>();
  for (const entry of entries) {
    const current = byId.get(entry.resourceId);
    if (!current) {
      byId.set(entry.resourceId, entry);
      continue;
    }
    const currentIdentity = JSON.stringify(canonicalize({ ...current, usageRoles: undefined }));
    const nextIdentity = JSON.stringify(canonicalize({ ...entry, usageRoles: undefined }));
    if (currentIdentity !== nextIdentity)
      throw new Error(`Focused preview resource '${entry.resourceId}' has conflicting identities.`);
    byId.set(entry.resourceId, {
      ...current,
      usageRoles: [...new Set([...current.usageRoles, ...entry.usageRoles])].sort(),
    });
  }
  return [...byId.values()].sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

function materialProjection(
  project: AuthoringProject,
  initialMaterialIds: readonly string[],
  variant: ShaderVariant,
): {
  shaderMaterials: {
    schema: typeof SHADER_MATERIAL_SCHEMA;
    shaders: Record<string, unknown>;
    materials: Record<string, unknown>;
  };
  resources: PreviewResourceManifestEntry[];
} {
  const materialIds = new Set<string>();
  const pending = [...initialMaterialIds];
  while (pending.length > 0) {
    const materialId = pending.pop()!;
    if (materialIds.has(materialId)) continue;
    const material = parseMaterialData(project.materials[materialId]?.data);
    if (!material)
      throw new Error(`Focused preview Material '${materialId}' is missing or invalid.`);
    materialIds.add(materialId);
    if (material.baseMaterialId) pending.push(material.baseMaterialId);
  }

  const shaderIds = new Set<string>();
  const resources: PreviewResourceManifestEntry[] = [];
  const materials: Record<string, unknown> = {};
  for (const materialId of [...materialIds].sort()) {
    const definition = buildMaterialDefinition(project, materialId);
    if (!definition.value || definition.diagnostics.some((item) => item.severity === 'error'))
      throw new Error(`Focused preview Material '${materialId}' could not be built.`);
    materials[materialId] = definition.value;
    const resolved = resolveMaterialData(project, materialId);
    if (!resolved.data || resolved.diagnostics.some((item) => item.severity === 'error'))
      throw new Error(`Focused preview Material '${materialId}' could not be resolved.`);
    if (resolved.data.shader) shaderIds.add(resolved.data.shader.$ref.id);
    for (const texture of resolved.data.textures)
      if ('$ref' in texture.source)
        resources.push(assetManifestEntry(project, texture.source.$ref.id, 'material-texture'));
  }

  const shaders: Record<string, unknown> = {};
  for (const shaderId of [...shaderIds].sort()) {
    const definition = buildShaderDefinition(project, shaderId);
    if (!definition.value || definition.diagnostics.some((item) => item.severity === 'error'))
      throw new Error(`Focused preview Shader '${shaderId}' could not be built.`);
    shaders[shaderId] = definition.value;
    resources.push(...shaderManifestEntries(project, shaderId, variant, 'material-shader'));
  }
  return {
    shaderMaterials: { schema: SHADER_MATERIAL_SCHEMA, shaders, materials },
    resources,
  };
}

function layoutSourceComponent(
  project: AuthoringProject,
  source: NonNullable<ReturnType<typeof parseLayoutData>>['rml'],
) {
  if (source.sourceMode === 'inline') return { kind: 'inline' as const, text: source.sourceText };
  const assetId = source.sourceAsset?.$ref.id;
  const asset = assetId ? parseAssetData(project.assets[assetId]?.data) : null;
  if (!asset) throw new Error(`Layout source Asset '${assetId ?? ''}' is missing or invalid.`);
  return { kind: 'asset' as const, logicalPath: `project:/${asset.source.path}` };
}

function finishDocument(
  input: Omit<FocusedRecordPreviewDocument, 'revision' | 'resourceRevision'>,
) {
  const resources = canonicalManifest(input.resources);
  const resourceRevision = sha256PrefixedUtf8(
    JSON.stringify(canonicalize(projectNativeManifest(resources))),
  );
  const revision = sha256PrefixedUtf8(
    JSON.stringify(
      canonicalize({
        kind: input.kind,
        recordId: input.recordId,
        inputRevision: input.inputRevision,
        resourceRevision,
        data: input.data,
      }),
    ),
  );
  return focusedRecordPreviewDocumentSchema.parse({
    ...input,
    resources,
    resourceRevision,
    revision,
  });
}

const layoutAdapter: FocusedPreviewAdapter<z.infer<typeof layoutPreviewInputsSchema>> = {
  kind: 'layout-preview',
  inputSchema: layoutPreviewInputsSchema,
  topologyDependent: false,
  owningPath: (root) => `/layouts/${root.recordId}`,
  build: (context) => {
    const layout = parseLayoutData(context.project.layouts[context.root.recordId]?.data);
    if (!layout) throw new Error(`Layout '${context.root.recordId}' is missing or invalid.`);
    const settings = projectSettingsFromProject(context.project);
    const profile = effectivePreviewDisplay(context.inputs.displayPreference, settings.display);
    const scalePolicy = resolveLayoutScalePolicy(layout.target, layout.scalePolicy);
    const resources: PreviewResourceManifestEntry[] = [];
    for (const [name, source] of [
      ['rml-source', layout.rml],
      ['rcss-source', layout.rcss],
      ['lua-source', layout.lua],
    ] as const)
      if (source.sourceMode === 'asset' && source.sourceAsset)
        resources.push(assetManifestEntry(context.project, source.sourceAsset.$ref.id, name));
    for (const [name, refs] of [
      ['layout-script', layout.dependencies.scripts],
      ['layout-template', layout.dependencies.templates],
      ['layout-stylesheet', layout.dependencies.stylesheets],
      ['layout-image', layout.dependencies.images],
      ['layout-font', layout.dependencies.fonts],
    ] as const)
      for (const ref of refs ?? [])
        resources.push(assetManifestEntry(context.project, ref.$ref.id, name));
    const material = materialProjection(
      context.project,
      layout.dependencies.materials.map((ref) => ref.$ref.id),
      context.hostCapabilities.activeShaderVariant,
    );
    resources.push(...material.resources);
    return finishDocument({
      kind: 'layout-preview',
      recordId: context.root.recordId,
      projectInstanceId: context.projectInstanceId,
      projectRevision: context.projectRevision,
      inputRevision: context.inputRevision,
      resources,
      data: {
        schema: 'noveltea.layout-preview',
        schemaVersion: 1,
        contentMode: 'layout',
        layoutId: context.root.recordId,
        layoutKind: layout.layoutKind,
        templateId: layout.layoutKind === 'fragment' ? 'layout-fragment-host-v1' : null,
        sourceUrl: authoredLayoutSourceUrl(context.project, context.root.recordId, layout.rml),
        defaultParent: layout.mount.defaultParent ?? null,
        scopedStyles: layout.mount.scopedStyles,
        script: {
          enabled: layout.script.enabled,
          namespace: layout.script.namespace ?? null,
        },
        rml: layoutSourceComponent(context.project, layout.rml),
        rcss: layoutSourceComponent(context.project, layout.rcss),
        lua: layoutSourceComponent(context.project, layout.lua),
        scalePolicy,
        environment: {
          profile: {
            name: profile.name,
            nativeResolution: profile.nativeResolution,
            scalePolicy,
          },
          project: {
            referenceResolution: settings.display.referenceResolution,
            worldRasterPolicy: settings.display.worldRasterPolicy,
            barColor: settings.display.barColor,
            accessibility: settings.accessibility,
          },
        },
        shaderMaterials: material.shaderMaterials,
      },
    });
  },
};

const shaderAdapter: FocusedPreviewAdapter<z.infer<typeof shaderPreviewInputsSchema>> = {
  kind: 'shader-preview',
  inputSchema: shaderPreviewInputsSchema,
  topologyDependent: false,
  owningPath: (root) => `/shaders/${root.recordId}`,
  build: (context) => {
    const definition = buildShaderDefinition(context.project, context.root.recordId);
    if (!definition.value || definition.diagnostics.some((item) => item.severity === 'error'))
      throw new Error(`Focused preview Shader '${context.root.recordId}' could not be built.`);
    const resources = shaderManifestEntries(
      context.project,
      context.root.recordId,
      context.hostCapabilities.activeShaderVariant,
      'shader-preview',
    );
    return finishDocument({
      kind: 'shader-preview',
      recordId: context.root.recordId,
      projectInstanceId: context.projectInstanceId,
      projectRevision: context.projectRevision,
      inputRevision: context.inputRevision,
      resources,
      data: {
        schema: 'noveltea.shader-preview',
        schemaVersion: 1,
        contentMode: 'shader',
        shaderId: context.root.recordId,
        previewMaterialId: `editor/preview/shader/${context.root.recordId}`,
        templateId: 'shader-square-v1',
        activeShaderVariant: context.hostCapabilities.activeShaderVariant,
        shaderMaterials: {
          schema: SHADER_MATERIAL_SCHEMA,
          shaders: { [context.root.recordId]: definition.value },
          materials: {},
        },
      },
    });
  },
};

const roomAdapter: FocusedPreviewAdapter<z.infer<typeof roomPreviewInputsSchema>> = {
  kind: 'room-preview',
  inputSchema: roomPreviewInputsSchema,
  topologyDependent: true,
  owningPath: (root) => `/rooms/${root.recordId}`,
  build: (context) => {
    if (!context.graph) throw new Error('Room preview requires a current dependency graph.');
    const built = buildFocusedRoomPreview({
      project: context.project,
      roomId: context.root.recordId,
      inputs: context.inputs,
      graph: context.graph,
      sourceAnalysis: context.sourceAnalysis,
      activeShaderVariant: context.hostCapabilities.activeShaderVariant,
    });
    const blocking = built.diagnostics.filter((item) => item.severity === 'error');
    if (blocking.length > 0)
      throw new Error(blocking.map((item) => `${item.path}: ${item.message}`).join('\n'));
    return finishDocument({
      kind: 'room-preview',
      recordId: context.root.recordId,
      projectInstanceId: context.projectInstanceId,
      projectRevision: context.projectRevision,
      inputRevision: context.inputRevision,
      resources: built.resources,
      data: built.data,
    });
  },
};

const adapters = new Map<FocusedPreviewDocumentKind, FocusedPreviewAdapter>([
  [layoutAdapter.kind, layoutAdapter],
  [shaderAdapter.kind, shaderAdapter],
  [roomAdapter.kind, roomAdapter],
]);

export function focusedPreviewAdapterFor(kind: FocusedPreviewDocumentKind): FocusedPreviewAdapter {
  const adapter = adapters.get(kind);
  if (!adapter)
    throw new Error(`No production focused preview adapter is registered for '${kind}'.`);
  return adapter;
}

export function validateFocusedPreviewInputs(kind: FocusedPreviewDocumentKind, inputs: unknown) {
  return focusedPreviewAdapterFor(kind).inputSchema.parse(inputs);
}
