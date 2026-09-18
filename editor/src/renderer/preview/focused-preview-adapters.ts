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
  type FocusedPreviewDocumentKind,
  type FocusedPreviewHostCapabilities,
  type FocusedRecordPreviewDocument,
  type PreviewResourceManifestEntry,
  type PreviewRootKey,
} from '../../shared/focused-preview-contracts';
import { lowerLayoutContractForWire } from '../../shared/layout-contract-lowering';
import { effectivePreviewDisplay } from '../../shared/preview-display';
import { effectivePreviewLocale } from '../../shared/preview-locale';
import { PSEUDO_PREVIEW_LOCALE, pseudoLocalizeRmlMessages } from '../../shared/pseudo-localization';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import type { ShaderCompileOutput } from '../../shared/editor-tooling';
import { projectOriginalAssetUrl } from '../../shared/project-original-asset';
import type { AuthoringSourceAnalysisArtifact } from '../../shared/project-schema/authoring-lua-analysis';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import {
  parseLayoutData,
  resolveLayoutScalePolicy,
} from '../../shared/project-schema/authoring-layouts';
import { authoredLayoutSourceUrl } from '../../shared/project-schema/layout-source-url';
import { resolveMaterialData } from '../../shared/project-schema/authoring-materials';
import { projectSettingsFromProject } from '../../shared/project-schema/authoring-project-settings';
import {
  buildShaderMaterialProject,
  SHADER_MATERIAL_SCHEMA,
} from '../../shared/project-schema/shader-material-project';
import type { ShaderVariant } from '../../shared/shader-variants';
import { parseShaderCompileResponse } from '../../shared/shader-compile-contract';
import { sha256PrefixedUtf8 } from '../../shared/web-crypto';
import { buildFocusedRoomPreview } from './room-focused-preview-builder';

export interface FocusedPreviewBuildContext<TInputs> {
  project: AuthoringProject;
  projectSessionId: string | null;
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
  build(context: FocusedPreviewBuildContext<TInputs>): Promise<FocusedRecordPreviewDocument>;
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

export async function canonicalFocusedPreviewInputRevision(
  value: unknown,
): Promise<`sha256:${string}`> {
  return sha256PrefixedUtf8(JSON.stringify(canonicalize(value)));
}

function assetManifestEntry(
  project: AuthoringProject,
  projectSessionId: string,
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
    fetchUrl: projectOriginalAssetUrl(projectSessionId, assetId),
    logicalPath: `project:/${parsed.source.path}`,
    contentHash: parsed.contentHash as `sha256:${string}`,
    byteSize: parsed.byteSize,
  };
  return parsed.kind === 'image'
    ? { ...base, kind: 'image', sampling: parsed.sampling ?? 'linear' }
    : { ...base, kind: parsed.kind };
}

async function projectSourceManifestEntries(
  projectSessionId: string,
  projectRelativePaths: readonly string[],
  usageRole: string,
): Promise<PreviewResourceManifestEntry[]> {
  const paths = [...new Set(projectRelativePaths)].sort();
  if (paths.length === 0) return [];
  const response = await window.noveltea.readProjectTextSources({
    projectSessionId,
    entries: paths.map((projectRelativePath, index) => ({
      readKey: `preview-source:${index}`,
      projectRelativePath,
      expectedContentHash: null,
    })),
  });
  const byKey = new Map(response.entries.map((entry) => [entry.readKey, entry]));
  const encoder = new TextEncoder();
  return paths.map((projectRelativePath, index) => {
    const entry = byKey.get(`preview-source:${index}`);
    if (!entry || entry.status !== 'ready')
      throw new Error(`Focused preview source '${projectRelativePath}' is unavailable.`);
    return {
      resourceId: `source:${projectRelativePath}`,
      sourceKind: 'project-source' as const,
      usageRoles: [usageRole],
      fetchProjectRelativePath: projectRelativePath,
      logicalPath: `project:/${projectRelativePath}`,
      contentHash: entry.contentHash,
      byteSize: encoder.encode(entry.text).byteLength + (entry.hadUtf8Bom ? 3 : 0),
      kind: 'lua' as const,
    };
  });
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

async function materialProjection(
  project: AuthoringProject,
  projectSessionId: string,
  initialMaterialIds: readonly string[],
  variant: ShaderVariant,
): Promise<{
  shaderMaterials: {
    schema: typeof SHADER_MATERIAL_SCHEMA;
    shaders: Record<string, unknown>;
    materials: Record<string, unknown>;
  };
  resources: PreviewResourceManifestEntry[];
}> {
  const sourceProject = await buildShaderMaterialProject(project);
  let compileOutputs: ShaderCompileOutput[] = [];
  if (Object.keys(sourceProject.compilation.programs).length > 0) {
    const response = parseShaderCompileResponse(
      await window.noveltea.compileShaders(projectSessionId, sourceProject.compilation, {
        shaderVariants: [variant],
      }),
    );
    if (!response.success)
      throw new Error(response.error ?? 'Focused Material shader compilation failed.');
    compileOutputs = response.outputs;
  }
  const built = await buildShaderMaterialProject(project, compileOutputs);
  if (built.diagnostics.some((item) => item.severity === 'error'))
    throw new Error('Focused preview Material metadata could not be built.');
  const resources: PreviewResourceManifestEntry[] = compileOutputs
    .filter((output) => output.variant === variant)
    .map((output) => ({
      usageRoles: ['material-shader'],
      fetchProjectRelativePath: `.noveltea/build/${output.runtimePath.replace(/^project:\//, '')}`,
      logicalPath: output.runtimePath,
      contentHash: output.byteHash,
      byteSize: output.byteSize,
      resourceId: `shader:${output.program}:${output.stage}:${output.variant}`,
      sourceKind: 'shader-compiled-output' as const,
      shaderId: output.program,
      shaderStage: output.stage,
      shaderVariant: output.variant as ShaderVariant,
      kind: 'shader-binary' as const,
    }));
  for (const materialId of initialMaterialIds) {
    const resolved = resolveMaterialData(project, materialId);
    if (!resolved.data || resolved.diagnostics.some((item) => item.severity === 'error'))
      throw new Error(`Focused preview Material '${materialId}' could not be resolved.`);
    for (const texture of Object.values(resolved.data.textures))
      if (texture.source && '$ref' in texture.source)
        resources.push(
          assetManifestEntry(project, projectSessionId, texture.source.$ref.id, 'material-texture'),
        );
  }
  return { shaderMaterials: built.project, resources };
}

function layoutSourceComponent(
  project: AuthoringProject,
  source:
    | NonNullable<ReturnType<typeof parseLayoutData>>['rml']
    | NonNullable<ReturnType<typeof parseLayoutData>>['lua'],
  options: Readonly<{ pseudoLocalizeMessages?: boolean }> = {},
) {
  if (source.sourceMode === 'inline')
    return {
      kind: 'inline' as const,
      text: options.pseudoLocalizeMessages
        ? pseudoLocalizeRmlMessages(project, source.sourceText)
        : source.sourceText,
    };
  const assetId = source.sourceAsset?.$ref.id;
  const asset = assetId ? parseAssetData(project.assets[assetId]?.data) : null;
  if (!asset) throw new Error(`Layout source Asset '${assetId ?? ''}' is missing or invalid.`);
  return { kind: 'asset' as const, logicalPath: `project:/${asset.source.path}` };
}

async function finishDocument(
  input: Omit<FocusedRecordPreviewDocument, 'revision' | 'resourceRevision'>,
): Promise<FocusedRecordPreviewDocument> {
  const resources = canonicalManifest(input.resources);
  const resourceRevision = await sha256PrefixedUtf8(
    JSON.stringify(canonicalize(projectNativeManifest(resources))),
  );
  const revision = await sha256PrefixedUtf8(
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
  build: async (context) => {
    if (!context.projectSessionId)
      throw new Error('Layout preview requires an active Project session.');
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
        resources.push(
          assetManifestEntry(
            context.project,
            context.projectSessionId,
            source.sourceAsset.$ref.id,
            name,
          ),
        );
    for (const [name, refs] of [
      ['layout-data', layout.dependencies.data],
      ['layout-template', layout.dependencies.templates],
      ['layout-stylesheet', layout.dependencies.stylesheets],
      ['layout-image', layout.dependencies.images],
      ['layout-font', layout.dependencies.fonts],
    ] as const)
      for (const ref of refs ?? [])
        resources.push(
          assetManifestEntry(context.project, context.projectSessionId, ref.$ref.id, name),
        );
    resources.push(
      ...(await projectSourceManifestEntries(
        context.projectSessionId,
        layout.dependencies.scripts,
        'layout-script',
      )),
    );
    for (const cursor of settings.cursors.named)
      resources.push(
        assetManifestEntry(
          context.project,
          context.projectSessionId,
          cursor.image.$ref.id,
          'project-cursor',
        ),
      );
    const material = await materialProjection(
      context.project,
      context.projectSessionId,
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
        rml: layoutSourceComponent(context.project, layout.rml, {
          pseudoLocalizeMessages: effectivePreviewLocale(context.project) === PSEUDO_PREVIEW_LOCALE,
        }),
        rcss: layoutSourceComponent(context.project, layout.rcss),
        lua: layoutSourceComponent(context.project, layout.lua),
        scalePolicy,
        contract: lowerLayoutContractForWire(layout.contract),
        sampleState: layout.sampleState,
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
        cursors: {
          defaultCursor:
            settings.cursors.defaults.default.kind === 'system'
              ? settings.cursors.defaults.default.cursor
              : settings.cursors.defaults.default.kind === 'named'
                ? settings.cursors.defaults.default.id
                : 'none',
          pointerCursor:
            settings.cursors.defaults.pointer.kind === 'system'
              ? settings.cursors.defaults.pointer.cursor
              : settings.cursors.defaults.pointer.kind === 'named'
                ? settings.cursors.defaults.pointer.id
                : 'none',
          hotspotCursor:
            settings.cursors.defaults.hotspot.kind === 'inherit'
              ? settings.cursors.defaults.pointer.kind === 'system'
                ? settings.cursors.defaults.pointer.cursor
                : settings.cursors.defaults.pointer.kind === 'named'
                  ? settings.cursors.defaults.pointer.id
                  : 'none'
              : settings.cursors.defaults.hotspot.kind === 'system'
                ? settings.cursors.defaults.hotspot.cursor
                : settings.cursors.defaults.hotspot.kind === 'named'
                  ? settings.cursors.defaults.hotspot.id
                  : 'none',
          named: settings.cursors.named.map((cursor) => {
            const asset = parseAssetData(context.project.assets[cursor.image.$ref.id]?.data);
            if (asset?.kind !== 'image' || !asset.imageMetadata)
              throw new Error(
                `Cursor Image Asset '${cursor.image.$ref.id}' is missing or invalid.`,
              );
            return {
              id: cursor.id,
              logicalPath: `project:/${asset.source.path}`,
              width: asset.imageMetadata.width,
              height: asset.imageMetadata.height,
              hotspotX: cursor.hotspotX,
              hotspotY: cursor.hotspotY,
            };
          }),
        },
        shaderMaterials: material.shaderMaterials,
      },
    });
  },
};

const roomAdapter: FocusedPreviewAdapter<z.infer<typeof roomPreviewInputsSchema>> = {
  kind: 'room-preview',
  inputSchema: roomPreviewInputsSchema,
  topologyDependent: true,
  owningPath: (root) => `/rooms/${root.recordId}`,
  build: async (context) => {
    if (!context.graph) throw new Error('Room preview requires a current dependency graph.');
    if (!context.projectSessionId)
      throw new Error('Room preview requires an active Project session.');
    const built = await buildFocusedRoomPreview({
      project: context.project,
      projectSessionId: context.projectSessionId,
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
