import { z } from 'zod';
import type { PreviewDisplayPreference } from './preview-display';
import { assetKindValues, imageSamplingValues } from './project-schema/authoring-assets';
import { shaderVariantSchema, type ShaderVariant } from './shader-variants';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type Sha256 = `sha256:${string}`;

export const focusedPreviewDocumentKindValues = [
  'layout-preview',
  'shader-preview',
  'room-preview',
] as const;
export const focusedPreviewDocumentKindSchema = z.enum(focusedPreviewDocumentKindValues);
export type FocusedPreviewDocumentKind = (typeof focusedPreviewDocumentKindValues)[number];
export const previewRootKeySchema = strict({
  kind: focusedPreviewDocumentKindSchema,
  recordId: z.string().min(1),
});
export type PreviewRootKey = z.infer<typeof previewRootKeySchema>;
export interface FocusedPreviewRequest<TInputs = unknown> {
  root: PreviewRootKey;
  inputs: TInputs;
}
export const focusedPreviewRequestSchema = <TInputs extends z.ZodType>(inputSchema: TInputs) =>
  strict({ root: previewRootKeySchema, inputs: inputSchema });

export const previewDisplayPreferenceSchema: z.ZodType<PreviewDisplayPreference> =
  z.discriminatedUnion('mode', [
    strict({ mode: z.literal('project') }),
    strict({
      mode: z.literal('custom'),
      aspectRatio: strict({
        width: z.number().int().positive().safe(),
        height: z.number().int().positive().safe(),
      }),
      orientation: z.enum(['landscape', 'portrait']),
    }),
  ]);
export const roomPreviewInputsSchema = strict({
  displayPreference: previewDisplayPreferenceSchema,
});
export type RoomPreviewInputs = z.infer<typeof roomPreviewInputsSchema>;
export const layoutPreviewInputsSchema = strict({
  displayPreference: previewDisplayPreferenceSchema,
});
export type LayoutPreviewInputs = z.infer<typeof layoutPreviewInputsSchema>;
export const shaderPreviewInputsSchema = strict({});
export type ShaderPreviewInputs = Record<string, never>;

export const focusedBuiltinTemplateIdValues = [
  'layout-fragment-host-v1',
  'shader-square-v1',
] as const;
export const focusedBuiltinTemplateIdSchema = z.enum(focusedBuiltinTemplateIdValues);
export type FocusedBuiltinTemplateId = (typeof focusedBuiltinTemplateIdValues)[number];

export const FOCUSED_PREVIEW_RESOURCE_LIMITS = {
  maxResourceBytes: 128 * 1024 * 1024,
  maxTotalResourceBytes: 512 * 1024 * 1024,
} as const;

export const FOCUSED_EDITOR_DOCUMENT_LIMITS = {
  maxRequestBytes: 16 * 1024 * 1024,
  maxSourceBytes: 4 * 1024 * 1024,
  maxStringBytes: 16 * 1024,
  maxJsonDepth: 64,
  maxLayouts: 512,
  maxResources: 16_384,
  maxItemsPerArray: 8_192,
  maxAdmissionItemsPerSource: 8_192,
} as const;

const manifestBase = {
  usageRoles: z.array(z.string()),
  logicalPath: z.string().min(1),
  contentHash: sha256Schema,
  byteSize: z.number().int().nonnegative().safe(),
};
const safeProjectRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value
        .split('/')
        .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'Path must be a safe project-relative path.',
  );
const projectLogicalPathSchema = z
  .string()
  .startsWith('project:/')
  .refine((value) => {
    const path = value.slice('project:/'.length);
    return (
      path.length > 0 &&
      !path.includes('\\') &&
      path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    );
  }, 'Logical path must contain a safe project:/ path.');

const authoringManifestBase = {
  ...manifestBase,
  fetchProjectRelativePath: safeProjectRelativePathSchema.optional(),
  fetchUrl: z.string().startsWith('noveltea-asset://source/').optional(),
  logicalPath: projectLogicalPathSchema,
  resourceId: z.string().regex(/^asset:.+$/),
  sourceKind: z.literal('authoring-asset'),
  assetId: z.string().min(1),
};

const authoringManifestEntrySchema = z
  .discriminatedUnion('kind', [
    strict({
      ...authoringManifestBase,
      kind: z.literal('image'),
      sampling: z.enum(imageSamplingValues),
      retainAlphaCoverage: z.boolean().optional(),
    }),
    strict({
      ...authoringManifestBase,
      kind: z.enum(assetKindValues.filter((kind) => kind !== 'image')),
    }),
  ])
  .superRefine((entry, context) => {
    if (entry.resourceId !== `asset:${entry.assetId}`)
      context.addIssue({
        code: 'custom',
        path: ['resourceId'],
        message: 'Authoring resourceId must equal asset:<assetId>.',
      });
    if (Boolean(entry.fetchProjectRelativePath) === Boolean(entry.fetchUrl))
      context.addIssue({
        code: 'custom',
        path: ['fetchUrl'],
        message: 'Authoring resources must provide exactly one fetch authority.',
      });
  });

const shaderResourceIdPattern = /^shader:.+:(vertex|fragment):(glsl-120|essl-100|essl-300|metal)$/;

const shaderManifestEntrySchema = strict({
  ...manifestBase,
  fetchProjectRelativePath: safeProjectRelativePathSchema,
  logicalPath: projectLogicalPathSchema,
  resourceId: z.string().regex(shaderResourceIdPattern),
  sourceKind: z.literal('shader-compiled-output'),
  shaderId: z.string().min(1),
  shaderStage: z.enum(['vertex', 'fragment']),
  shaderVariant: shaderVariantSchema,
  kind: z.literal('shader-binary'),
}).superRefine((entry, context) => {
  if (entry.resourceId !== `shader:${entry.shaderId}:${entry.shaderStage}:${entry.shaderVariant}`)
    context.addIssue({
      code: 'custom',
      path: ['resourceId'],
      message: 'Shader resourceId must equal shader:<id>:<stage>:<variant>.',
    });
});

export const previewResourceManifestEntrySchema = z.union([
  authoringManifestEntrySchema,
  shaderManifestEntrySchema,
]);
export type PreviewResourceManifestEntry = z.infer<typeof previewResourceManifestEntrySchema>;

const nativeBase = {
  logicalPath: projectLogicalPathSchema,
  contentHash: sha256Schema,
  byteSize: z.number().int().nonnegative().safe(),
};
export const nativePreviewResourceManifestEntrySchema = z.union([
  z
    .discriminatedUnion('kind', [
      strict({
        ...nativeBase,
        resourceId: z.string().regex(/^asset:.+$/),
        sourceKind: z.literal('authoring-asset'),
        assetId: z.string().min(1),
        kind: z.literal('image'),
        sampling: z.enum(imageSamplingValues),
        retainAlphaCoverage: z.boolean().optional(),
      }),
      strict({
        ...nativeBase,
        resourceId: z.string().regex(/^asset:.+$/),
        sourceKind: z.literal('authoring-asset'),
        assetId: z.string().min(1),
        kind: z.enum(assetKindValues.filter((kind) => kind !== 'image')),
      }),
    ])
    .superRefine((entry, context) => {
      if (entry.resourceId !== `asset:${entry.assetId}`)
        context.addIssue({
          code: 'custom',
          path: ['resourceId'],
          message: 'Authoring resourceId must equal asset:<assetId>.',
        });
    }),
  strict({
    ...nativeBase,
    resourceId: z.string().regex(shaderResourceIdPattern),
    sourceKind: z.literal('shader-compiled-output'),
    shaderId: z.string().min(1),
    shaderStage: z.enum(['vertex', 'fragment']),
    shaderVariant: shaderVariantSchema,
    kind: z.literal('shader-binary'),
  }).superRefine((entry, context) => {
    if (entry.resourceId !== `shader:${entry.shaderId}:${entry.shaderStage}:${entry.shaderVariant}`)
      context.addIssue({
        code: 'custom',
        path: ['resourceId'],
        message: 'Shader resourceId must equal shader:<id>:<stage>:<variant>.',
      });
  }),
]);
export type NativePreviewResourceManifestEntry = z.infer<
  typeof nativePreviewResourceManifestEntrySchema
>;
export const projectNativeManifest = (
  entries: readonly PreviewResourceManifestEntry[],
): NativePreviewResourceManifestEntry[] =>
  entries.map((entry) =>
    entry.sourceKind === 'authoring-asset'
      ? entry.kind === 'image'
        ? {
            resourceId: entry.resourceId,
            sourceKind: entry.sourceKind,
            assetId: entry.assetId,
            logicalPath: entry.logicalPath,
            contentHash: entry.contentHash,
            byteSize: entry.byteSize,
            kind: entry.kind,
            sampling: entry.sampling,
          }
        : {
            resourceId: entry.resourceId,
            sourceKind: entry.sourceKind,
            assetId: entry.assetId,
            logicalPath: entry.logicalPath,
            contentHash: entry.contentHash,
            byteSize: entry.byteSize,
            kind: entry.kind,
          }
      : {
          resourceId: entry.resourceId,
          sourceKind: entry.sourceKind,
          shaderId: entry.shaderId,
          shaderStage: entry.shaderStage,
          shaderVariant: entry.shaderVariant,
          logicalPath: entry.logicalPath,
          contentHash: entry.contentHash,
          byteSize: entry.byteSize,
          kind: entry.kind,
        },
  );

export const focusedRecordPreviewDocumentSchema = strict({
  kind: focusedPreviewDocumentKindSchema,
  recordId: z.string().min(1),
  revision: sha256Schema,
  projectInstanceId: z.string().min(1),
  projectRevision: z.number().int().positive(),
  inputRevision: sha256Schema,
  resourceRevision: sha256Schema,
  resources: z.array(previewResourceManifestEntrySchema),
  data: z.record(z.string(), z.unknown()),
}).superRefine((document, context) => {
  const resourceIds = new Set<string>();
  const fetchPaths = new Map<string, string>();
  const logicalPaths = new Map<string, string>();
  let totalBytes = 0;
  document.resources.forEach((entry, index) => {
    if (entry.byteSize > FOCUSED_PREVIEW_RESOURCE_LIMITS.maxResourceBytes)
      context.addIssue({
        code: 'custom',
        path: ['resources', index, 'byteSize'],
        message: 'Resource exceeds the focused per-resource byte limit.',
      });
    totalBytes += entry.byteSize;
    if (resourceIds.has(entry.resourceId))
      context.addIssue({
        code: 'custom',
        path: ['resources', index, 'resourceId'],
        message: 'Duplicate focused resourceId.',
      });
    resourceIds.add(entry.resourceId);
    const fetchAuthority =
      entry.sourceKind === 'authoring-asset'
        ? (entry.fetchUrl ?? entry.fetchProjectRelativePath)
        : entry.fetchProjectRelativePath;
    for (const [map, path, label] of [
      [fetchPaths, fetchAuthority, 'fetch authority'],
      [logicalPaths, entry.logicalPath, 'logical path'],
    ] as const) {
      if (!path) continue;
      const prior = map.get(path);
      if (prior && prior !== entry.resourceId)
        context.addIssue({
          code: 'custom',
          path: ['resources', index],
          message: `Conflicting focused ${label}.`,
        });
      map.set(path, entry.resourceId);
    }
  });
  if (totalBytes > FOCUSED_PREVIEW_RESOURCE_LIMITS.maxTotalResourceBytes)
    context.addIssue({
      code: 'custom',
      path: ['resources'],
      message: 'Focused resource manifest exceeds the aggregate byte limit.',
    });
});
export type FocusedRecordPreviewDocument = z.infer<typeof focusedRecordPreviewDocumentSchema>;

export const focusedEditorDocumentRequestEnvelopeSchema = strict({
  protocol: z.literal('noveltea.focused-editor-document'),
  protocolVersion: z.literal(1),
  requestId: z.string().min(1),
  applySequence: z.number().int().nonnegative().safe(),
  projectInstanceId: z.string().min(1),
  resourceStageGeneration: z.number().int().nonnegative().safe(),
  kind: focusedPreviewDocumentKindSchema,
  recordId: z.string().min(1),
  revision: sha256Schema,
  resourceRevision: sha256Schema,
  resources: z
    .array(nativePreviewResourceManifestEntrySchema)
    .max(FOCUSED_EDITOR_DOCUMENT_LIMITS.maxResources),
  data: z.record(z.string(), z.unknown()),
});
export type FocusedEditorDocumentRequestEnvelope = z.infer<
  typeof focusedEditorDocumentRequestEnvelopeSchema
>;

export function encodeFocusedEditorDocumentRequest(
  request: FocusedEditorDocumentRequestEnvelope,
): string {
  const parsed = focusedEditorDocumentRequestEnvelopeSchema.parse(request);
  const encoded = JSON.stringify(parsed);
  if (new TextEncoder().encode(encoded).byteLength > FOCUSED_EDITOR_DOCUMENT_LIMITS.maxRequestBytes)
    throw new Error('Focused editor document request exceeds the native request-size limit.');
  return encoded;
}

export const appliedPreviewDocumentResultSchema = strict({
  disposition: z.enum(['applied', 'unchanged', 'superseded']),
  projectInstanceId: z.string().min(1),
  kind: focusedPreviewDocumentKindSchema,
  recordId: z.string().min(1),
  revision: sha256Schema,
  resourceStageGeneration: z.number().int().nonnegative().safe(),
});
export type AppliedPreviewDocumentResult = z.infer<typeof appliedPreviewDocumentResultSchema>;
export interface PreviewDiagnosticScope {
  hostId: string;
  leaseId: string;
  projectInstanceId: string;
  kind: FocusedPreviewDocumentKind;
  recordId: string;
  projectRevision: number;
  inputRevision: string;
  documentRevision?: string;
}
export interface PreviewPreDocumentDiagnosticScope extends Omit<
  PreviewDiagnosticScope,
  'documentRevision'
> {
  documentRevision?: never;
}
export interface PreviewDocumentDiagnosticScope extends PreviewDiagnosticScope {
  documentRevision: string;
}
export interface FocusedPreviewHostCapabilities {
  activeShaderVariant: ShaderVariant;
}
