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
  fetchProjectRelativePath: z.string().min(1),
  logicalPath: z.string().min(1),
  contentHash: sha256Schema,
  byteSize: z.number().int().nonnegative().safe(),
};
export const previewResourceManifestEntrySchema = z.discriminatedUnion('sourceKind', [
  strict({
    ...manifestBase,
    resourceId: z.string().regex(/^asset:.+$/),
    sourceKind: z.literal('authoring-asset'),
    assetId: z.string().min(1),
    kind: z.enum(assetKindValues),
    sampling: z.enum(imageSamplingValues).optional(),
  }),
  strict({
    ...manifestBase,
    resourceId: z.string().regex(/^shader:.+:(vertex|fragment):(glsl-120|essl-100|essl-300)$/),
    sourceKind: z.literal('shader-compiled-output'),
    shaderId: z.string().min(1),
    shaderStage: z.enum(['vertex', 'fragment']),
    shaderVariant: shaderVariantSchema,
    kind: z.literal('shader-binary'),
  }),
]);
export type PreviewResourceManifestEntry = z.infer<typeof previewResourceManifestEntrySchema>;

export const nativePreviewResourceManifestEntrySchema = strict({
  resourceId: z.string().min(1),
  sourceKind: z.enum(['authoring-asset', 'shader-compiled-output']),
  logicalPath: z.string().min(1),
  contentHash: sha256Schema,
  byteSize: z.number().int().nonnegative().safe(),
  kind: z.enum([...assetKindValues, 'shader-binary']),
  sampling: z.enum(imageSamplingValues).optional(),
  assetId: z.string().min(1).optional(),
  shaderId: z.string().min(1).optional(),
  shaderStage: z.enum(['vertex', 'fragment']).optional(),
  shaderVariant: shaderVariantSchema.optional(),
});
export type NativePreviewResourceManifestEntry = z.infer<
  typeof nativePreviewResourceManifestEntrySchema
>;
export const projectNativeManifest = (
  entries: readonly PreviewResourceManifestEntry[],
): NativePreviewResourceManifestEntry[] =>
  entries.map((entry) => ({
    resourceId: entry.resourceId,
    sourceKind: entry.sourceKind,
    logicalPath: entry.logicalPath,
    contentHash: entry.contentHash,
    byteSize: entry.byteSize,
    kind: entry.kind,
    ...('sampling' in entry && entry.sampling ? { sampling: entry.sampling } : {}),
    ...(entry.sourceKind === 'authoring-asset' ? { assetId: entry.assetId } : {}),
    ...(entry.sourceKind === 'shader-compiled-output'
      ? {
          shaderId: entry.shaderId,
          shaderStage: entry.shaderStage,
          shaderVariant: entry.shaderVariant,
        }
      : {}),
  }));

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
