import { parseAssetData } from './authoring-assets';
import type { AuthoringProject } from './authoring-project';
import {
  parseLayoutData,
  validateLayoutData,
  type LayoutAssetRef,
  type LayoutMaterialRef,
  type LayoutSourceData,
} from './authoring-layouts';
import { parseMaterialData } from './authoring-materials';

export const LAYOUT_PREVIEW_SCHEMA = 'noveltea.layout-preview.v1' as const;

export interface LayoutProjectDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(
  path: string,
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error',
): LayoutProjectDiagnostic {
  return { severity, path, message, category: 'layout-project' };
}

function assetMetadata(project: AuthoringProject, ref: LayoutAssetRef): Record<string, unknown> {
  const id = ref.$ref.id;
  const record = project.assets[id];
  const data = parseAssetData(record?.data);
  return {
    id,
    label: record?.label ?? id,
    kind: data?.kind ?? 'missing',
    path: data?.source.path ?? null,
    extension: data?.extension ?? null,
    contentHash: data?.contentHash ?? null,
  };
}

function materialMetadata(
  project: AuthoringProject,
  ref: LayoutMaterialRef,
): Record<string, unknown> {
  const id = ref.$ref.id;
  const record = project.materials[id];
  const data = parseMaterialData(record?.data);
  return {
    id,
    label: record?.label ?? id,
    role: data?.role ?? null,
    shader: data?.shader?.$ref.id ?? null,
  };
}

function sourcePayload(
  project: AuthoringProject,
  source: LayoutSourceData,
): Record<string, unknown> {
  if (source.sourceMode === 'asset' && source.sourceAsset) {
    return {
      sourceMode: 'asset',
      sourceAsset: assetMetadata(project, source.sourceAsset),
      sourceText: '',
    };
  }
  return {
    sourceMode: 'inline',
    sourceAsset: null,
    sourceText: source.sourceText,
  };
}

export function layoutPreviewRevision(project: AuthoringProject, layoutId: string): string {
  const record = project.layouts[layoutId];
  const data = parseLayoutData(record?.data);
  if (!record || !data) return `${layoutId}:missing-or-invalid`;
  const assetDeps = [
    data.rml.sourceAsset,
    data.rcss.sourceAsset,
    data.lua.sourceAsset,
    ...data.dependencies.images,
    ...data.dependencies.fonts,
    ...data.dependencies.stylesheets,
    ...data.dependencies.scripts,
  ]
    .filter(Boolean)
    .map((ref) => {
      const assetId = ref!.$ref.id;
      const asset = project.assets[assetId];
      const assetData = parseAssetData(asset?.data);
      return `${assetId}:${assetData?.contentHash ?? assetData?.source.path ?? 'missing'}`;
    });
  const materialDeps = data.dependencies.materials.map((ref) => {
    const materialId = ref.$ref.id;
    return `${materialId}:${JSON.stringify(project.materials[materialId]?.data ?? null)}`;
  });
  return JSON.stringify({ layoutId, label: record.label, data, assetDeps, materialDeps });
}

export function buildLayoutPreviewDocumentData(
  project: AuthoringProject,
  layoutId: string,
): Record<string, unknown> {
  const record = project.layouts[layoutId];
  const data = parseLayoutData(record?.data);
  if (!record || !data) {
    return {
      schema: LAYOUT_PREVIEW_SCHEMA,
      layoutId,
      label: layoutId,
      diagnostics: [diagnostic(`/layouts/${layoutId}/data`, 'Invalid layout data.')],
    };
  }

  return {
    schema: LAYOUT_PREVIEW_SCHEMA,
    layoutId,
    label: record.label,
    layoutKind: data.layoutKind,
    target: data.target,
    rml: sourcePayload(project, data.rml),
    rcss: sourcePayload(project, data.rcss),
    lua: sourcePayload(project, data.lua),
    script: data.script,
    mount: data.mount,
    dependencies: {
      images: data.dependencies.images.map((ref) => assetMetadata(project, ref)),
      fonts: data.dependencies.fonts.map((ref) => assetMetadata(project, ref)),
      stylesheets: data.dependencies.stylesheets.map((ref) => assetMetadata(project, ref)),
      scripts: data.dependencies.scripts.map((ref) => assetMetadata(project, ref)),
      materials: data.dependencies.materials.map((ref) => materialMetadata(project, ref)),
    },
    sampleState: data.sampleState,
    preview: data.preview,
    internalTemplates:
      data.layoutKind === 'fragment'
        ? {
            hostRml: '/editor-assets/internal-preview/layout-fragment-host.rml',
            hostRcss: '/editor-assets/internal-preview/layout-fragment-host.rcss',
          }
        : {},
    diagnostics: validateLayoutData(project, layoutId, record),
  };
}
