import type { ComfyUiConfig } from './comfyui';
import type { ComfyUiAnalyzedWorkflow } from './comfyui-workflow-graph';
import type { ComfyUiRoleCandidateMap } from './comfyui-workflow-inference';

export type ComfyUiWorkflowId = string;
export type ComfyUiWorkflowClassification = string;
export type ComfyUiKnownWorkflowClassification = 'image.generate' | 'image.edit';
export type ComfyUiWorkflowProvider = 'comfyui';
export type ComfyUiWorkflowInputType = 'string' | 'integer' | 'number' | 'boolean' | 'image';
export type ComfyUiWorkflowOutputCardinality = 'one' | 'many';
export type ComfyUiWorkflowOutputMediaType = string;

// These semantic names are image-authoring inference hints only. Generic workflow parsing and
// execution use the public IDs declared by each manifest instead of this catalog.
export type ComfyUiSemanticInput =
  | 'prompt'
  | 'negativePrompt'
  | 'sourceImage'
  | 'maskImage'
  | 'width'
  | 'height'
  | 'seed'
  | 'steps'
  | 'cfg'
  | 'filenamePrefix';
export type ComfyUiSemanticOutput = 'images';
export const COMFYUI_WORKFLOW_SCHEMA_VERSION = 2 as const;
export type ComfyUiWorkflowSchemaVersion = typeof COMFYUI_WORKFLOW_SCHEMA_VERSION;
export const COMFYUI_WORKFLOW_VERIFICATION_CACHE_SCHEMA =
  'noveltea.comfyui-workflow-verification-cache' as const;
export const COMFYUI_WORKFLOW_VERIFICATION_CACHE_SCHEMA_VERSION = 1 as const;
export type ComfyUiWorkflowEditorField =
  | 'textarea'
  | 'text'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'imageAsset';

export interface ComfyUiWorkflowBindingSelector {
  title?: string;
  classType?: string;
  inputName?: string;
  upstreamClassType?: string;
  downstreamClassType?: string;
}

export interface ComfyUiWorkflowBinding {
  nodeId?: string;
  nodeTitle?: string;
  classType?: string;
  inputName: string;
  selector?: ComfyUiWorkflowBindingSelector;
  resolvedNodeId?: string;
}

export interface ComfyUiWorkflowOutputBinding {
  nodeId?: string;
  nodeTitle?: string;
  classType?: string;
}

export interface ComfyUiWorkflowNodeLike {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: {
    title?: unknown;
  };
}

export type ComfyUiWorkflowGraphLike = Record<string, ComfyUiWorkflowNodeLike>;

export interface ComfyUiWorkflowAuthoringMetadata {
  label?: string;
  description?: string;
  editorField?: ComfyUiWorkflowEditorField;
}

export type ComfyUiWorkflowDefaultValue = string | number | boolean;

export interface ComfyUiWorkflowContractInput {
  type: ComfyUiWorkflowInputType;
  required: boolean;
  defaultValue?: ComfyUiWorkflowDefaultValue;
  authoring?: ComfyUiWorkflowAuthoringMetadata;
}

export interface ComfyUiWorkflowContractOutput {
  mediaType: ComfyUiWorkflowOutputMediaType;
  required: boolean;
  cardinality: ComfyUiWorkflowOutputCardinality;
}

export interface ComfyUiWorkflowContract {
  inputs: Record<string, ComfyUiWorkflowContractInput>;
  outputs: Record<string, ComfyUiWorkflowContractOutput>;
}

export interface ComfyUiWorkflowDefinition {
  schemaVersion: ComfyUiWorkflowSchemaVersion;
  id: ComfyUiWorkflowId;
  label: string;
  provider: ComfyUiWorkflowProvider;
  classification?: ComfyUiWorkflowClassification;
  description?: string;
  workflowFile: string;
  contract: ComfyUiWorkflowContract;
  requiredNodeClasses: string[];
  bindings: Record<string, ComfyUiWorkflowBinding[]>;
  outputBindings: Record<string, ComfyUiWorkflowOutputBinding[]>;
  manifestFile?: string;
}

export interface ComfyUiWorkflowClassificationInputDefinition {
  type: ComfyUiWorkflowInputType;
  required: boolean;
  editorField?: ComfyUiWorkflowEditorField;
  defaultValue?: ComfyUiWorkflowDefaultValue;
  minBindings: number;
  maxBindings: number;
}

export interface ComfyUiWorkflowClassificationOutputDefinition {
  mediaType: 'image';
  required: boolean;
  cardinality: ComfyUiWorkflowOutputCardinality;
  minBindings: number;
  maxBindings: number;
}

export interface ComfyUiWorkflowClassificationDefinition {
  classification: ComfyUiKnownWorkflowClassification;
  label: string;
  description: string;
  provider: ComfyUiWorkflowProvider;
  contract: {
    inputs: Partial<Record<ComfyUiSemanticInput, ComfyUiWorkflowClassificationInputDefinition>>;
    outputs: Record<ComfyUiSemanticOutput, ComfyUiWorkflowClassificationOutputDefinition>;
  };
  inference: {
    titleMarkers: Partial<Record<ComfyUiSemanticInput | ComfyUiSemanticOutput, string>>;
  };
}

export interface ComfyUiWorkflowDiagnostic {
  severity: 'error' | 'warning' | 'info';
  category: 'comfyui-workflows';
  path: string;
  message: string;
}

export type ComfyUiWorkflowSource = 'built-in' | 'editor' | 'project';
export type ComfyUiMutableWorkflowSource = Exclude<ComfyUiWorkflowSource, 'built-in'>;
export type ComfyUiWorkflowKey = `${ComfyUiWorkflowSource}:${string}`;
export type ComfyUiPackageHash = `sha256:${string}`;
export type ComfyUiWorkflowValidationStatus = 'valid' | 'warning' | 'invalid';
export type ComfyUiWorkflowVerificationStatus =
  | 'unverified'
  | 'previously-verified'
  | 'verified'
  | 'failed'
  | 'skipped';

export interface ComfyUiWorkflowRootSummary {
  source: ComfyUiWorkflowSource;
  root: string;
  writable: boolean;
  available: boolean;
  workflowCount: number;
  activeCount: number;
  overriddenCount: number;
  diagnostics: ComfyUiWorkflowDiagnostic[];
}

export interface ComfyUiWorkflowLibrarySummary {
  sources: ComfyUiWorkflowRootSummary[];
  totalCount: number;
  activeCount: number;
  overriddenCount: number;
  invalidCount: number;
  verifiedCount: number;
  failedVerificationCount: number;
}

export interface ComfyUiWorkflowVerificationRecord {
  workflowKey: ComfyUiWorkflowKey;
  id: ComfyUiWorkflowId;
  packageHash: ComfyUiPackageHash;
  comfyUiVersion: string;
  status: Extract<ComfyUiWorkflowVerificationStatus, 'verified' | 'failed'>;
  checkedAt: string;
  diagnostics: ComfyUiWorkflowDiagnostic[];
}

export interface ComfyUiWorkflowVerificationCacheDocument {
  schema: typeof COMFYUI_WORKFLOW_VERIFICATION_CACHE_SCHEMA;
  schemaVersion: typeof COMFYUI_WORKFLOW_VERIFICATION_CACHE_SCHEMA_VERSION;
  records: ComfyUiWorkflowVerificationRecord[];
}

export interface ComfyUiWorkflowPackageFiles {
  manifestFile: string;
  workflowFile?: string;
  manifestPath: string;
  workflowPath?: string;
  manifestJsonText?: string;
  workflowJsonText?: string;
}

export interface ComfyUiWorkflowCapabilities {
  canCopyToEditor: boolean;
  canCopyToProject: boolean;
  canDelete: boolean;
  canRepair: boolean;
  canReveal: boolean;
  canRename?: boolean;
}

export interface ComfyUiWorkflowLibraryEntry {
  source: ComfyUiWorkflowSource;
  workflowKey: ComfyUiWorkflowKey;
  id?: ComfyUiWorkflowId;
  label?: string;
  classification?: ComfyUiWorkflowClassification;
  definition?: ComfyUiWorkflowDefinition;
  manifestFile: string;
  workflowFile?: string;
  manifestPath: string;
  workflowPath?: string;
  packageHash?: ComfyUiPackageHash;
  active: boolean;
  overridden: boolean;
  overriddenBy?: ComfyUiWorkflowKey;
  offlineStatus: ComfyUiWorkflowValidationStatus;
  onlineStatus: ComfyUiWorkflowVerificationStatus;
  runnable?: boolean;
  repairable: boolean;
  diagnostics: ComfyUiWorkflowDiagnostic[];
  verificationDiagnostics: ComfyUiWorkflowDiagnostic[];
  manifestJsonText?: string;
  workflowJsonText?: string;
  capabilities: ComfyUiWorkflowCapabilities;
}

export interface ComfyUiWorkflowActiveEntry {
  workflowKey: ComfyUiWorkflowKey;
  source: ComfyUiWorkflowSource;
  id: ComfyUiWorkflowId;
  label: string;
  classification?: ComfyUiWorkflowClassification;
  definition: ComfyUiWorkflowDefinition;
  packageHash?: ComfyUiPackageHash;
  offlineStatus: Exclude<ComfyUiWorkflowValidationStatus, 'invalid'>;
  onlineStatus: ComfyUiWorkflowVerificationStatus;
  runnable: boolean;
  diagnostics: ComfyUiWorkflowDiagnostic[];
  verificationDiagnostics: ComfyUiWorkflowDiagnostic[];
}

export interface ComfyUiWorkflowLibraryListRequest {
  projectFilePath?: string | null;
  includeOverridden?: boolean;
  comfyUiVersion?: string;
}

export interface ComfyUiWorkflowLibraryListResponse {
  ok: boolean;
  success: boolean;
  entries: ComfyUiWorkflowLibraryEntry[];
  activeWorkflows: ComfyUiWorkflowActiveEntry[];
  overriddenEntries: ComfyUiWorkflowLibraryEntry[];
  summary: ComfyUiWorkflowLibrarySummary;
  diagnostics: ComfyUiWorkflowDiagnostic[];
  error?: string;
}

export interface ComfyUiWorkflowCopyRequest {
  workflowKey: ComfyUiWorkflowKey;
  targetSource: ComfyUiMutableWorkflowSource;
  projectFilePath?: string | null;
  replace?: boolean;
}

export interface ComfyUiWorkflowCopyResponse {
  ok: boolean;
  success: boolean;
  action: 'copied' | 'already-copied' | 'replace-required' | 'replaced' | 'rejected';
  sourceWorkflowKey?: ComfyUiWorkflowKey;
  targetWorkflowKey?: ComfyUiWorkflowKey;
  entry?: ComfyUiWorkflowLibraryEntry;
  diagnostics: ComfyUiWorkflowDiagnostic[];
  error?: string;
}

export interface ComfyUiWorkflowDeleteRequest {
  workflowKey: ComfyUiWorkflowKey;
  projectFilePath?: string | null;
}

export interface ComfyUiWorkflowDeleteResponse {
  ok: boolean;
  success: boolean;
  deleted: string[];
  workflowKey?: ComfyUiWorkflowKey;
  refreshed?: ComfyUiWorkflowLibraryListResponse;
  diagnostics: ComfyUiWorkflowDiagnostic[];
  error?: string;
}

export interface ComfyUiWorkflowRenameRequest {
  workflowKey: ComfyUiWorkflowKey;
  label: string;
  projectFilePath?: string | null;
}

export interface ComfyUiWorkflowRenameResponse {
  ok: boolean;
  success: boolean;
  workflowKey?: ComfyUiWorkflowKey;
  entry?: ComfyUiWorkflowLibraryEntry;
  diagnostics: ComfyUiWorkflowDiagnostic[];
  error?: string;
}

export interface ComfyUiImportWorkflowToLibraryRequest {
  workflowFileName: string;
  manifestFileName: string;
  workflowJsonText: string;
  manifest: unknown;
  overwrite: boolean;
  config?: ComfyUiConfig;
}

export interface ComfyUiImportWorkflowToLibraryResponse {
  ok: boolean;
  success: boolean;
  workflowKey?: ComfyUiWorkflowKey;
  workflowFile?: string;
  manifestFile?: string;
  definition?: ComfyUiWorkflowDefinition;
  entry?: ComfyUiWorkflowLibraryEntry;
  diagnostics: ComfyUiWorkflowDiagnostic[];
  error?: string;
}

export interface ComfyUiRepairWorkflowInLibraryRequest {
  workflowKey: ComfyUiWorkflowKey;
  manifest: unknown;
  overwrite: true;
  projectFilePath?: string | null;
}

export interface ComfyUiRepairWorkflowInLibraryResponse {
  ok: boolean;
  success: boolean;
  workflowKey?: ComfyUiWorkflowKey;
  workflowFile?: string;
  manifestFile?: string;
  definition?: ComfyUiWorkflowDefinition;
  entry?: ComfyUiWorkflowLibraryEntry;
  diagnostics: ComfyUiWorkflowDiagnostic[];
  error?: string;
}

export interface ComfyUiVerifyWorkflowLibraryRequest {
  projectFilePath?: string | null;
  config: ComfyUiConfig;
  force?: boolean;
}

export interface ComfyUiVerifyWorkflowLibraryResponse {
  ok: boolean;
  success: boolean;
  checkedAt: string;
  verified: ComfyUiWorkflowVerificationRecord[];
  failed: ComfyUiWorkflowVerificationRecord[];
  skipped: ComfyUiWorkflowKey[];
  entries: ComfyUiWorkflowLibraryEntry[];
  diagnostics: ComfyUiWorkflowDiagnostic[];
  error?: string;
}

export interface ComfyUiBindingResolution {
  ok: boolean;
  nodeId?: string;
  rebased?: boolean;
  ambiguous?: boolean;
  message?: string;
}

export interface ComfyUiWorkflowListEntry {
  manifestFile: string;
  workflowFile?: string;
  definition?: ComfyUiWorkflowDefinition;
  id?: string;
  label?: string;
  classification?: ComfyUiWorkflowClassification;
  status: 'valid' | 'warning' | 'invalid';
  repairable: boolean;
  diagnostics: ComfyUiWorkflowDiagnostic[];
  manifestJsonText?: string;
  workflowJsonText?: string;
}

export interface ComfyUiWorkflowListResponse {
  ok: boolean;
  success: boolean;
  workflows: ComfyUiWorkflowDefinition[];
  entries: ComfyUiWorkflowListEntry[];
  diagnostics: ComfyUiWorkflowDiagnostic[];
  error?: string;
}

export interface ComfyUiInstallStarterWorkflowsResponse {
  ok: boolean;
  success: boolean;
  copied: string[];
  skipped: string[];
  diagnostics: ComfyUiWorkflowDiagnostic[];
  error?: string;
}

export interface ComfyUiAnalyzeWorkflowImportRequest {
  projectFilePath?: string | null;
  workflowJsonText: string;
  config?: ComfyUiConfig;
}

export interface ComfyUiWorkflowClassificationImportAnalysis {
  candidates: ComfyUiRoleCandidateMap;
}

export interface ComfyUiAnalyzeWorkflowImportResponse {
  ok: boolean;
  analysis?: ComfyUiAnalyzedWorkflow;
  classificationCandidates: Partial<
    Record<ComfyUiKnownWorkflowClassification, ComfyUiWorkflowClassificationImportAnalysis>
  >;
  diagnostics: ComfyUiWorkflowDiagnostic[];
  error?: string;
}

export interface ComfyUiSaveImportedWorkflowRequest {
  projectFilePath: string;
  workflowFileName: string;
  manifestFileName: string;
  workflowJsonText: string;
  manifest: unknown;
  overwrite: boolean;
}

export interface ComfyUiSaveImportedWorkflowResponse {
  ok: boolean;
  success: boolean;
  workflowFile?: string;
  manifestFile?: string;
  definition?: ComfyUiWorkflowDefinition;
  diagnostics: ComfyUiWorkflowDiagnostic[];
  error?: string;
}

export interface ComfyUiRepairWorkflowManifestRequest {
  projectFilePath: string;
  manifestFileName: string;
  manifest: unknown;
  overwrite: true;
}

export const COMFYUI_WORKFLOW_CLASSIFICATION_CATALOG: Record<
  ComfyUiKnownWorkflowClassification,
  ComfyUiWorkflowClassificationDefinition
> = {
  'image.generate': {
    classification: 'image.generate',
    label: 'Text to Image',
    description: 'Generate images from a text prompt.',
    provider: 'comfyui',
    contract: {
      inputs: {
        prompt: {
          type: 'string',
          required: true,
          editorField: 'textarea',
          minBindings: 1,
          maxBindings: 1,
        },
        negativePrompt: {
          type: 'string',
          required: false,
          editorField: 'textarea',
          minBindings: 0,
          maxBindings: 1,
        },
        width: {
          type: 'integer',
          required: false,
          editorField: 'integer',
          defaultValue: 1024,
          minBindings: 0,
          maxBindings: 1,
        },
        height: {
          type: 'integer',
          required: false,
          editorField: 'integer',
          defaultValue: 1024,
          minBindings: 0,
          maxBindings: 1,
        },
        seed: {
          type: 'integer',
          required: false,
          editorField: 'integer',
          minBindings: 0,
          maxBindings: 1,
        },
        steps: {
          type: 'integer',
          required: false,
          editorField: 'integer',
          defaultValue: 20,
          minBindings: 0,
          maxBindings: 1,
        },
        cfg: {
          type: 'number',
          required: false,
          editorField: 'number',
          minBindings: 0,
          maxBindings: 1,
        },
        filenamePrefix: {
          type: 'string',
          required: false,
          editorField: 'text',
          defaultValue: 'NovelTea',
          minBindings: 0,
          maxBindings: 1,
        },
      },
      outputs: {
        images: {
          mediaType: 'image',
          required: true,
          cardinality: 'many',
          minBindings: 1,
          maxBindings: 1,
        },
      },
    },
    inference: {
      titleMarkers: {
        prompt: 'noveltea.prompt',
        negativePrompt: 'noveltea.negativePrompt',
        width: 'noveltea.width',
        height: 'noveltea.height',
        seed: 'noveltea.seed',
        steps: 'noveltea.steps',
        cfg: 'noveltea.cfg',
        filenamePrefix: 'noveltea.filenamePrefix',
        images: 'noveltea.output',
      },
    },
  },
  'image.edit': {
    classification: 'image.edit',
    label: 'Image Edit',
    description: 'Edit an existing image from a source image and text prompt.',
    provider: 'comfyui',
    contract: {
      inputs: {
        sourceImage: {
          type: 'image',
          required: true,
          editorField: 'imageAsset',
          minBindings: 1,
          maxBindings: 1,
        },
        prompt: {
          type: 'string',
          required: true,
          editorField: 'textarea',
          minBindings: 1,
          maxBindings: 1,
        },
        negativePrompt: {
          type: 'string',
          required: false,
          editorField: 'textarea',
          minBindings: 0,
          maxBindings: 1,
        },
        seed: {
          type: 'integer',
          required: false,
          editorField: 'integer',
          minBindings: 0,
          maxBindings: 1,
        },
        steps: {
          type: 'integer',
          required: false,
          editorField: 'integer',
          defaultValue: 4,
          minBindings: 0,
          maxBindings: 1,
        },
        cfg: {
          type: 'number',
          required: false,
          editorField: 'number',
          minBindings: 0,
          maxBindings: 1,
        },
        filenamePrefix: {
          type: 'string',
          required: false,
          editorField: 'text',
          defaultValue: 'NovelTea',
          minBindings: 0,
          maxBindings: 1,
        },
      },
      outputs: {
        images: {
          mediaType: 'image',
          required: true,
          cardinality: 'many',
          minBindings: 1,
          maxBindings: 1,
        },
      },
    },
    inference: {
      titleMarkers: {
        sourceImage: 'noveltea.sourceImage',
        prompt: 'noveltea.prompt',
        maskImage: 'noveltea.maskImage',
        negativePrompt: 'noveltea.negativePrompt',
        seed: 'noveltea.seed',
        steps: 'noveltea.steps',
        cfg: 'noveltea.cfg',
        filenamePrefix: 'noveltea.filenamePrefix',
        images: 'noveltea.output',
      },
    },
  },
};

export const KNOWN_COMFYUI_WORKFLOW_CLASSIFICATIONS = Object.keys(
  COMFYUI_WORKFLOW_CLASSIFICATION_CATALOG,
) as ComfyUiKnownWorkflowClassification[];

export const BUILTIN_COMFYUI_WORKFLOW_MANIFESTS = [
  'flux2-klein-text-to-image.manifest.json',
  'flux2-klein-image-edit.manifest.json',
] as const;

const contractInputTypes = new Set<ComfyUiWorkflowInputType>([
  'string',
  'integer',
  'number',
  'boolean',
  'image',
]);
const outputCardinalities = new Set<ComfyUiWorkflowOutputCardinality>(['one', 'many']);
const editorFields = new Set<ComfyUiWorkflowEditorField>([
  'textarea',
  'text',
  'integer',
  'number',
  'boolean',
  'imageAsset',
]);
const publicIdPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const classificationPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const mediaTypePattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${path}.${unknown} is not supported.`);
}

function asString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value;
}

function asBoolean(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') throw new Error(message);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, `${path} must be a string.`);
}

function optionalStringArray(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value.map((item) => asString(item, `${path} entries must be strings.`));
}

function parseSchemaVersion(value: unknown): ComfyUiWorkflowSchemaVersion {
  if (value !== COMFYUI_WORKFLOW_SCHEMA_VERSION) {
    const serialized = JSON.stringify(value);
    throw new Error(
      `schemaVersion '${serialized ?? typeof value}' is not supported; expected ${COMFYUI_WORKFLOW_SCHEMA_VERSION}.`,
    );
  }
  return COMFYUI_WORKFLOW_SCHEMA_VERSION;
}

function parseBindingSelector(
  value: unknown,
  path: string,
): ComfyUiWorkflowBindingSelector | undefined {
  if (value === undefined) return undefined;
  const selector = asRecord(value, `${path} must be an object.`);
  assertExactKeys(
    selector,
    ['title', 'classType', 'inputName', 'upstreamClassType', 'downstreamClassType'],
    path,
  );
  return {
    title: optionalString(selector.title, `${path}.title`),
    classType: optionalString(selector.classType, `${path}.classType`),
    inputName: optionalString(selector.inputName, `${path}.inputName`),
    upstreamClassType: optionalString(selector.upstreamClassType, `${path}.upstreamClassType`),
    downstreamClassType: optionalString(
      selector.downstreamClassType,
      `${path}.downstreamClassType`,
    ),
  };
}

function parseBinding(value: unknown, path: string): ComfyUiWorkflowBinding {
  const binding = asRecord(value, `${path} must be an object.`);
  assertExactKeys(
    binding,
    ['nodeId', 'nodeTitle', 'classType', 'inputName', 'selector', 'resolvedNodeId'],
    path,
  );
  const parsed = {
    nodeId: optionalString(binding.nodeId, `${path}.nodeId`),
    nodeTitle: optionalString(binding.nodeTitle, `${path}.nodeTitle`),
    classType: optionalString(binding.classType, `${path}.classType`),
    inputName: asString(binding.inputName, `${path}.inputName is required.`),
    selector: parseBindingSelector(binding.selector, `${path}.selector`),
    resolvedNodeId: optionalString(binding.resolvedNodeId, `${path}.resolvedNodeId`),
  };
  if (!parsed.nodeId && !parsed.nodeTitle && !parsed.classType && !parsed.selector)
    throw new Error(`${path} must include nodeId, nodeTitle, classType, or selector metadata.`);
  return parsed;
}

function parseAuthoringMetadata(
  value: unknown,
  path: string,
): ComfyUiWorkflowAuthoringMetadata | undefined {
  if (value === undefined) return undefined;
  const authoring = asRecord(value, `${path} must be an object.`);
  assertExactKeys(authoring, ['label', 'description', 'editorField'], path);
  const editorField =
    authoring.editorField === undefined
      ? undefined
      : (asString(
          authoring.editorField,
          `${path}.editorField must be a string.`,
        ) as ComfyUiWorkflowEditorField);
  if (editorField && !editorFields.has(editorField))
    throw new Error(`${path}.editorField '${editorField}' is not supported.`);
  return {
    label: optionalString(authoring.label, `${path}.label`),
    description: optionalString(authoring.description, `${path}.description`),
    editorField,
  };
}

function validateDefaultValue(
  type: ComfyUiWorkflowInputType,
  value: unknown,
  path: string,
): ComfyUiWorkflowDefaultValue | undefined {
  if (value === undefined) return undefined;
  if (type === 'string' || type === 'image') {
    if (typeof value !== 'string') throw new Error(`${path} must be a string for type '${type}'.`);
    return value;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean.`);
    return value;
  }
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${path} must be a finite number.`);
  if (type === 'integer' && !Number.isInteger(value))
    throw new Error(`${path} must be an integer.`);
  return value;
}

function parseContractInput(value: unknown, path: string): ComfyUiWorkflowContractInput {
  const input = asRecord(value, `${path} must be an object.`);
  assertExactKeys(input, ['type', 'required', 'defaultValue', 'authoring'], path);
  const type = asString(input.type, `${path}.type is required.`) as ComfyUiWorkflowInputType;
  if (!contractInputTypes.has(type)) throw new Error(`${path}.type '${type}' is not supported.`);
  return {
    type,
    required: asBoolean(input.required, `${path}.required is required.`),
    defaultValue: validateDefaultValue(type, input.defaultValue, `${path}.defaultValue`),
    authoring: parseAuthoringMetadata(input.authoring, `${path}.authoring`),
  };
}

function parseContractOutput(value: unknown, path: string): ComfyUiWorkflowContractOutput {
  const output = asRecord(value, `${path} must be an object.`);
  assertExactKeys(output, ['mediaType', 'required', 'cardinality'], path);
  const mediaType = asString(output.mediaType, `${path}.mediaType is required.`);
  if (!mediaTypePattern.test(mediaType))
    throw new Error(`${path}.mediaType '${mediaType}' is not a valid media type identifier.`);
  const cardinality = asString(
    output.cardinality,
    `${path}.cardinality is required.`,
  ) as ComfyUiWorkflowOutputCardinality;
  if (!outputCardinalities.has(cardinality))
    throw new Error(`${path}.cardinality '${cardinality}' is not supported.`);
  return {
    mediaType,
    required: asBoolean(output.required, `${path}.required is required.`),
    cardinality,
  };
}

function assertPublicId(value: string, path: string) {
  if (!publicIdPattern.test(value))
    throw new Error(`${path} '${value}' is not a CLI-safe public identifier.`);
}

function parseContract(value: unknown): ComfyUiWorkflowContract {
  const contract = asRecord(value, 'contract must be an object.');
  assertExactKeys(contract, ['inputs', 'outputs'], 'contract');
  const inputsRecord = asRecord(contract.inputs, 'contract.inputs must be an object.');
  const inputs: Record<string, ComfyUiWorkflowContractInput> = {};
  for (const [key, input] of Object.entries(inputsRecord)) {
    assertPublicId(key, 'contract input id');
    inputs[key] = parseContractInput(input, `contract.inputs.${key}`);
  }
  const outputsRecord = asRecord(contract.outputs, 'contract.outputs must be an object.');
  const outputs: Record<string, ComfyUiWorkflowContractOutput> = {};
  for (const [key, output] of Object.entries(outputsRecord)) {
    assertPublicId(key, 'contract output id');
    outputs[key] = parseContractOutput(output, `contract.outputs.${key}`);
  }
  if (Object.keys(outputs).length === 0)
    throw new Error('contract.outputs must declare at least one output.');
  return { inputs, outputs };
}

function parseBindings(value: unknown): Record<string, ComfyUiWorkflowBinding[]> {
  const record = asRecord(value, 'bindings must be an object.');
  const bindings: Record<string, ComfyUiWorkflowBinding[]> = {};
  for (const [key, rawBindings] of Object.entries(record)) {
    assertPublicId(key, 'binding public input id');
    if (!Array.isArray(rawBindings)) throw new Error(`bindings.${key} must be an array.`);
    if (rawBindings.length === 0)
      throw new Error(`bindings.${key} must contain at least one graph binding.`);
    bindings[key] = rawBindings.map((binding, index) =>
      parseBinding(binding, `bindings.${key}.${index}`),
    );
  }
  return bindings;
}

function parseOutputBinding(value: unknown, path: string): ComfyUiWorkflowOutputBinding {
  const binding = asRecord(value, `${path} must be an object.`);
  assertExactKeys(binding, ['nodeId', 'nodeTitle', 'classType'], path);
  const parsed = {
    nodeId: optionalString(binding.nodeId, `${path}.nodeId`),
    nodeTitle: optionalString(binding.nodeTitle, `${path}.nodeTitle`),
    classType: optionalString(binding.classType, `${path}.classType`),
  };
  if (!parsed.nodeId && !parsed.nodeTitle && !parsed.classType)
    throw new Error(`${path} must include nodeId, nodeTitle, or classType.`);
  return parsed;
}

function parseOutputBindings(value: unknown): Record<string, ComfyUiWorkflowOutputBinding[]> {
  const record = asRecord(value, 'outputBindings must be an object.');
  const bindings: Record<string, ComfyUiWorkflowOutputBinding[]> = {};
  for (const [key, rawBindings] of Object.entries(record)) {
    assertPublicId(key, 'output binding public output id');
    if (!Array.isArray(rawBindings)) throw new Error(`outputBindings.${key} must be an array.`);
    if (rawBindings.length === 0)
      throw new Error(`outputBindings.${key} must contain at least one graph binding.`);
    bindings[key] = rawBindings.map((binding, index) =>
      parseOutputBinding(binding, `outputBindings.${key}.${index}`),
    );
  }
  return bindings;
}

function parseClassification(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const classification = asString(value, 'classification must be a string.');
  if (!classificationPattern.test(classification))
    throw new Error(
      `classification '${classification}' is not a dotted classification identifier.`,
    );
  return classification;
}

function safeWorkflowSiblingPath(value: string, label: string) {
  if (
    value.includes('/') ||
    value.includes('\\') ||
    value === '.' ||
    value === '..' ||
    value.startsWith('.')
  ) {
    throw new Error(`${label} must be a safe file name in the workflows directory.`);
  }
}

function workflowContractDiagnostic(
  path: string,
  message: string,
  severity: ComfyUiWorkflowDiagnostic['severity'] = 'error',
): ComfyUiWorkflowDiagnostic {
  return { severity, category: 'comfyui-workflows', path, message };
}

export interface ComfyUiWorkflowExecutionSupport {
  runnable: boolean;
  unsupportedOutputMediaTypes: string[];
}

export function getComfyUiWorkflowExecutionSupport(
  definition: ComfyUiWorkflowDefinition,
): ComfyUiWorkflowExecutionSupport {
  const unsupportedOutputMediaTypes = [
    ...new Set(
      Object.values(definition.contract.outputs)
        .map((output) => output.mediaType)
        .filter((mediaType) => mediaType !== 'image'),
    ),
  ].sort();
  return {
    runnable: unsupportedOutputMediaTypes.length === 0,
    unsupportedOutputMediaTypes,
  };
}

export function validateComfyUiWorkflowDefinitionContract(
  definition: ComfyUiWorkflowDefinition,
): ComfyUiWorkflowDiagnostic[] {
  const diagnostics: ComfyUiWorkflowDiagnostic[] = [];

  for (const inputId of Object.keys(definition.contract.inputs)) {
    if (!definition.bindings[inputId]?.length) {
      diagnostics.push(
        workflowContractDiagnostic(
          `/bindings/${inputId}`,
          `contract.inputs.${inputId} must declare at least one graph binding.`,
        ),
      );
    }
  }
  for (const inputId of Object.keys(definition.bindings)) {
    if (!definition.contract.inputs[inputId]) {
      diagnostics.push(
        workflowContractDiagnostic(
          `/bindings/${inputId}`,
          `bindings.${inputId} must be declared by contract.inputs.${inputId}.`,
        ),
      );
    }
  }

  for (const [outputId, output] of Object.entries(definition.contract.outputs)) {
    if (!definition.outputBindings[outputId]?.length) {
      diagnostics.push(
        workflowContractDiagnostic(
          `/outputBindings/${outputId}`,
          `contract.outputs.${outputId} must declare at least one graph binding.`,
        ),
      );
    }
    if (output.mediaType !== 'image') {
      diagnostics.push(
        workflowContractDiagnostic(
          `/contract/outputs/${outputId}/mediaType`,
          `Output media type '${output.mediaType}' is discoverable but not runnable by this NovelTea build.`,
          'warning',
        ),
      );
    }
  }
  for (const outputId of Object.keys(definition.outputBindings)) {
    if (!definition.contract.outputs[outputId]) {
      diagnostics.push(
        workflowContractDiagnostic(
          `/outputBindings/${outputId}`,
          `outputBindings.${outputId} must be declared by contract.outputs.${outputId}.`,
        ),
      );
    }
  }

  return diagnostics;
}

function assertCanonicalContract(definition: ComfyUiWorkflowDefinition) {
  const diagnostics = validateComfyUiWorkflowDefinitionContract(definition);
  const firstError = diagnostics.find((item) => item.severity === 'error');
  if (firstError) throw new Error(firstError.message);
}

export function parseComfyUiWorkflowDefinition(
  value: unknown,
  manifestFile?: string,
): ComfyUiWorkflowDefinition {
  const manifest = asRecord(value, 'ComfyUI workflow manifest must be an object.');
  assertExactKeys(
    manifest,
    [
      'schemaVersion',
      'id',
      'label',
      'provider',
      'classification',
      'description',
      'workflowFile',
      'contract',
      'requiredNodeClasses',
      'bindings',
      'outputBindings',
    ],
    'manifest',
  );
  const provider = asString(manifest.provider, 'provider is required.') as ComfyUiWorkflowProvider;
  if (provider !== 'comfyui') throw new Error(`provider '${String(provider)}' is not supported.`);
  const workflowFile = asString(manifest.workflowFile, 'workflowFile is required.');
  safeWorkflowSiblingPath(workflowFile, 'workflowFile');
  const definition: ComfyUiWorkflowDefinition = {
    schemaVersion: parseSchemaVersion(manifest.schemaVersion),
    id: asString(manifest.id, 'id is required.'),
    label: asString(manifest.label, 'label is required.'),
    provider,
    classification: parseClassification(manifest.classification),
    description: optionalString(manifest.description, 'description'),
    workflowFile,
    contract: parseContract(manifest.contract),
    bindings: parseBindings(manifest.bindings),
    outputBindings: parseOutputBindings(manifest.outputBindings),
    requiredNodeClasses: optionalStringArray(manifest.requiredNodeClasses, 'requiredNodeClasses'),
    manifestFile,
  };
  safeWorkflowSiblingPath(definition.id, 'id');
  assertCanonicalContract(definition);
  return definition;
}

function workflowNodeTitle(node: ComfyUiWorkflowNodeLike): string | undefined {
  return typeof node._meta?.title === 'string' && node._meta.title.trim()
    ? node._meta.title
    : undefined;
}

function nodeMatchesInput(node: ComfyUiWorkflowNodeLike, inputName: string) {
  return Boolean(node.inputs && inputName in node.inputs);
}

function nodeMatchesClass(node: ComfyUiWorkflowNodeLike, classType: string | undefined) {
  return !classType || node.class_type === classType;
}

function nodeMatchesTitle(node: ComfyUiWorkflowNodeLike, title: string | undefined) {
  return !title || workflowNodeTitle(node) === title;
}

function nodeMatches(
  graph: ComfyUiWorkflowGraphLike,
  predicate: (nodeId: string, node: ComfyUiWorkflowNodeLike) => boolean,
): string[] {
  return Object.entries(graph)
    .filter(([nodeId, node]) => predicate(nodeId, node))
    .map(([nodeId]) => nodeId);
}

function resolutionFromMatches(
  matches: string[],
  bindingLabel: string,
  currentNodeId?: string,
): ComfyUiBindingResolution | null {
  if (matches.length === 1)
    return { ok: true, nodeId: matches[0], rebased: matches[0] !== currentNodeId };
  if (matches.length > 1) {
    return {
      ok: false,
      ambiguous: true,
      message: `Binding '${bindingLabel}' matches multiple workflow nodes: ${matches.join(', ')}.`,
    };
  }
  return null;
}

export function resolveComfyUiWorkflowBinding(
  graph: ComfyUiWorkflowGraphLike,
  binding: ComfyUiWorkflowBinding,
): ComfyUiBindingResolution {
  if (binding.nodeId) {
    const node = graph[binding.nodeId];
    if (nodeMatchesInput(node ?? {}, binding.inputName))
      return { ok: true, nodeId: binding.nodeId };
  }

  const title = binding.selector?.title ?? binding.nodeTitle;
  const classType = binding.selector?.classType ?? binding.classType;
  const inputName = binding.selector?.inputName ?? binding.inputName;
  const bindingLabel = `${binding.nodeId ?? binding.nodeTitle ?? classType ?? 'unknown'}.${binding.inputName}`;

  if (title && classType) {
    const resolution = resolutionFromMatches(
      nodeMatches(
        graph,
        (_nodeId, node) =>
          nodeMatchesTitle(node, title) &&
          nodeMatchesClass(node, classType) &&
          nodeMatchesInput(node, inputName),
      ),
      bindingLabel,
      binding.nodeId,
    );
    if (resolution) return resolution;
  }
  if (title) {
    const resolution = resolutionFromMatches(
      nodeMatches(
        graph,
        (_nodeId, node) => nodeMatchesTitle(node, title) && nodeMatchesInput(node, inputName),
      ),
      bindingLabel,
      binding.nodeId,
    );
    if (resolution) return resolution;
  }
  if (classType) {
    const resolution = resolutionFromMatches(
      nodeMatches(
        graph,
        (_nodeId, node) => nodeMatchesClass(node, classType) && nodeMatchesInput(node, inputName),
      ),
      bindingLabel,
      binding.nodeId,
    );
    if (resolution) return resolution;
  }

  return { ok: false, message: `Could not resolve binding '${bindingLabel}'.` };
}

export function resolveComfyUiWorkflowOutputBinding(
  graph: ComfyUiWorkflowGraphLike,
  binding: ComfyUiWorkflowOutputBinding,
): ComfyUiBindingResolution {
  if (binding.nodeId && graph[binding.nodeId]) return { ok: true, nodeId: binding.nodeId };

  const title = binding.nodeTitle;
  const classType = binding.classType;
  const bindingLabel = binding.nodeId ?? binding.nodeTitle ?? classType ?? 'unknown';

  if (title && classType) {
    const resolution = resolutionFromMatches(
      nodeMatches(
        graph,
        (_nodeId, node) => nodeMatchesTitle(node, title) && nodeMatchesClass(node, classType),
      ),
      bindingLabel,
      binding.nodeId,
    );
    if (resolution) return resolution;
  }
  if (title) {
    const resolution = resolutionFromMatches(
      nodeMatches(graph, (_nodeId, node) => nodeMatchesTitle(node, title)),
      bindingLabel,
      binding.nodeId,
    );
    if (resolution) return resolution;
  }
  if (classType) {
    const resolution = resolutionFromMatches(
      nodeMatches(graph, (_nodeId, node) => nodeMatchesClass(node, classType)),
      bindingLabel,
      binding.nodeId,
    );
    if (resolution) return resolution;
  }

  return { ok: false, message: `Could not resolve output binding '${bindingLabel}'.` };
}

export function resolveComfyUiWorkflowOutputNodeIds(
  graph: ComfyUiWorkflowGraphLike,
  definition: ComfyUiWorkflowDefinition,
  outputId?: string,
): ComfyUiBindingResolution {
  const outputIds = outputId ? [outputId] : Object.keys(definition.contract.outputs);
  const resolvedNodeIds: string[] = [];
  let rebased = false;
  for (const publicOutputId of outputIds) {
    const bindings = definition.outputBindings[publicOutputId] ?? [];
    if (bindings.length === 0) {
      return {
        ok: false,
        message: `Workflow '${definition.label}' has no output binding for '${publicOutputId}'.`,
      };
    }
    for (const binding of bindings) {
      const resolution = resolveComfyUiWorkflowOutputBinding(graph, binding);
      if (!resolution.ok) return resolution;
      if (resolution.nodeId) resolvedNodeIds.push(resolution.nodeId);
      rebased ||= Boolean(resolution.rebased);
    }
  }
  return { ok: true, nodeId: [...new Set(resolvedNodeIds)].join('\0'), rebased };
}

export function resolvedComfyUiWorkflowOutputNodeIdList(
  graph: ComfyUiWorkflowGraphLike,
  definition: ComfyUiWorkflowDefinition,
  outputId?: string,
): string[] {
  const resolution = resolveComfyUiWorkflowOutputNodeIds(graph, definition, outputId);
  if (!resolution.ok)
    throw new Error(
      resolution.message ?? `Workflow '${definition.label}' output bindings could not be resolved.`,
    );
  return resolution.nodeId ? resolution.nodeId.split('\0').filter(Boolean) : [];
}

export function resolvedComfyUiWorkflowOutputNodeIdsById(
  graph: ComfyUiWorkflowGraphLike,
  definition: ComfyUiWorkflowDefinition,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.keys(definition.contract.outputs).map((outputId) => [
      outputId,
      resolvedComfyUiWorkflowOutputNodeIdList(graph, definition, outputId),
    ]),
  );
}
