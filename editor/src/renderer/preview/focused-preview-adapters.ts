import { z } from 'zod';
import type { AuthoringDependencyGraphSnapshot } from '../../shared/authoring-dependency-contracts';
import {
  focusedRecordPreviewDocumentSchema,
  layoutPreviewInputsSchema,
  shaderPreviewInputsSchema,
  type FocusedPreviewDocumentKind,
  type FocusedPreviewHostCapabilities,
  type FocusedRecordPreviewDocument,
  type PreviewResourceManifestEntry,
  type PreviewRootKey,
} from '../../shared/focused-preview-contracts';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import {
  buildLayoutPreviewDocumentData,
  layoutPreviewRevision,
} from '../../shared/project-schema/layout-project';
import {
  buildShaderPreviewDocumentData,
  shaderPreviewRevision,
} from '../../shared/project-schema/shader-material-project';
import { sha256PrefixedUtf8 } from '../../shared/sha256';

export interface FocusedPreviewBuildContext<TInputs> {
  project: AuthoringProject;
  projectInstanceId: string;
  projectRevision: number;
  root: PreviewRootKey;
  inputs: TInputs;
  inputRevision: `sha256:${string}`;
  graph: AuthoringDependencyGraphSnapshot | null;
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

function referencedAssetIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) referencedAssetIds(child, ids);
    return ids;
  }
  if (!value || typeof value !== 'object') return ids;
  const record = value as Record<string, unknown>;
  if (typeof record.id === 'string' && typeof record.path === 'string') ids.add(record.id);
  for (const child of Object.values(record)) referencedAssetIds(child, ids);
  return ids;
}

function assetManifest(
  project: AuthoringProject,
  data: Record<string, unknown>,
): PreviewResourceManifestEntry[] {
  const entries: PreviewResourceManifestEntry[] = [];
  for (const assetId of [...referencedAssetIds(data)].sort()) {
    const parsed = parseAssetData(project.assets[assetId]?.data);
    if (
      !parsed ||
      !parsed.contentHash?.match(/^sha256:[0-9a-f]{64}$/) ||
      parsed.byteSize === undefined
    )
      continue;
    entries.push({
      resourceId: `asset:${assetId}`,
      sourceKind: 'authoring-asset',
      assetId,
      usageRoles: ['focused-preview'],
      fetchProjectRelativePath: parsed.source.path,
      logicalPath: parsed.source.path,
      contentHash: parsed.contentHash as `sha256:${string}`,
      byteSize: parsed.byteSize,
      kind: parsed.kind,
      ...(parsed.sampling ? { sampling: parsed.sampling } : {}),
    });
  }
  return entries;
}

function finishDocument(
  input: Omit<FocusedRecordPreviewDocument, 'revision' | 'resourceRevision'>,
) {
  const resourceRevision = sha256PrefixedUtf8(JSON.stringify(canonicalize(input.resources)));
  const revision = sha256PrefixedUtf8(
    JSON.stringify(canonicalize({ ...input, resourceRevision, resources: undefined })),
  );
  return focusedRecordPreviewDocumentSchema.parse({ ...input, resourceRevision, revision });
}

const layoutAdapter: FocusedPreviewAdapter<z.infer<typeof layoutPreviewInputsSchema>> = {
  kind: 'layout-preview',
  inputSchema: layoutPreviewInputsSchema,
  topologyDependent: false,
  owningPath: (root) => `/layouts/${root.recordId}`,
  build: (context) => {
    const data = buildLayoutPreviewDocumentData(context.project, context.root.recordId);
    const resources = assetManifest(context.project, data);
    return finishDocument({
      kind: 'layout-preview',
      recordId: context.root.recordId,
      projectInstanceId: context.projectInstanceId,
      projectRevision: context.projectRevision,
      inputRevision: context.inputRevision,
      resources,
      data: {
        ...data,
        contentMode: 'layout',
        authoredRevision: layoutPreviewRevision(context.project, context.root.recordId),
        displayPreference: context.inputs.displayPreference,
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
    const data = buildShaderPreviewDocumentData(context.project, context.root.recordId);
    const resources = assetManifest(context.project, data);
    return finishDocument({
      kind: 'shader-preview',
      recordId: context.root.recordId,
      projectInstanceId: context.projectInstanceId,
      projectRevision: context.projectRevision,
      inputRevision: context.inputRevision,
      resources,
      data: {
        ...data,
        contentMode: 'shader',
        authoredRevision: shaderPreviewRevision(context.project, context.root.recordId),
        activeShaderVariant: context.hostCapabilities.activeShaderVariant,
      },
    });
  },
};

const adapters = new Map<FocusedPreviewDocumentKind, FocusedPreviewAdapter>([
  [layoutAdapter.kind, layoutAdapter],
  [shaderAdapter.kind, shaderAdapter],
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
