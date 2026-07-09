import type { ComfyUiConfig } from './comfyui';
import type { ComfyUiAnalyzedWorkflow } from './comfyui-workflow-graph';
import type { ComfyUiRoleCandidateMap } from './comfyui-workflow-inference';

export type ComfyUiWorkflowId = string;
export type ComfyUiWorkflowRole = 'image.generate' | 'image.edit';
export type ComfyUiWorkflowProvider = 'comfyui';
export type ComfyUiWorkflowValueType = 'string' | 'integer' | 'number' | 'image-upload-reference';
export type ComfyUiContractInputType = 'string' | 'integer' | 'number' | 'image';
export type ComfyUiContractOutputType = 'image-list';
export type ComfyUiImagePrimaryOutput = 'first';

export type ComfyUiSemanticInput = 'prompt' | 'negativePrompt' | 'sourceImage' | 'maskImage' | 'width' | 'height' | 'seed' | 'steps' | 'cfg' | 'filenamePrefix';
export type ComfyUiSemanticOutput = 'images';
export type ComfyUiWorkflowSchemaVersion = 1 | 2;
export type ComfyUiWorkflowEditorField = 'textarea' | 'text' | 'integer' | 'number' | 'imageAsset';

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
  valueType: ComfyUiWorkflowValueType;
  selector?: ComfyUiWorkflowBindingSelector;
  resolvedNodeId?: string;
}

export interface ComfyUiWorkflowOutputBinding {
  nodeId?: string;
  nodeTitle?: string;
  classType?: string;
  outputName?: string;
  valueType: ComfyUiContractOutputType;
  primary: ComfyUiImagePrimaryOutput;
}

export interface ComfyUiWorkflowNodeLike {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: {
    title?: unknown;
  };
}

export type ComfyUiWorkflowGraphLike = Record<string, ComfyUiWorkflowNodeLike>;

export interface ComfyUiWorkflowContractInput {
  type: ComfyUiContractInputType;
  required: boolean;
  editorField?: ComfyUiWorkflowEditorField;
  defaultValue?: string | number;
}

export interface ComfyUiWorkflowContractOutput {
  type: ComfyUiContractOutputType;
  required: boolean;
  primary: ComfyUiImagePrimaryOutput;
}

export interface ComfyUiWorkflowContract {
  inputs: Partial<Record<ComfyUiSemanticInput, ComfyUiWorkflowContractInput>>;
  outputs: {
    images?: ComfyUiWorkflowContractOutput;
  };
}

export interface ComfyUiWorkflowDefinition {
  schemaVersion: ComfyUiWorkflowSchemaVersion;
  id: ComfyUiWorkflowId;
  label: string;
  provider: ComfyUiWorkflowProvider;
  role: ComfyUiWorkflowRole;
  description?: string;
  workflowFile: string;
  contract: ComfyUiWorkflowContract;
  requiredNodeClasses: string[];
  outputNodeIds: string[];
  bindings: Partial<Record<ComfyUiSemanticInput, ComfyUiWorkflowBinding>>;
  outputBindings: Partial<Record<ComfyUiSemanticOutput, ComfyUiWorkflowOutputBinding[]>>;
  defaults: Record<string, string | number> & { filenamePrefix: string };
  manifestFile?: string;
}

export interface ComfyUiWorkflowRoleInputDefinition {
  type: ComfyUiContractInputType;
  required: boolean;
  editorField?: ComfyUiWorkflowEditorField;
  defaultValue?: string | number;
  minBindings: number;
  maxBindings: number;
}

export interface ComfyUiWorkflowRoleOutputDefinition {
  type: ComfyUiContractOutputType;
  required: boolean;
  primary: ComfyUiImagePrimaryOutput;
  minBindings: number;
  maxBindings: number;
}

export interface ComfyUiWorkflowRoleDefinition {
  role: ComfyUiWorkflowRole;
  label: string;
  description: string;
  provider: ComfyUiWorkflowProvider;
  contract: {
    inputs: Partial<Record<ComfyUiSemanticInput, ComfyUiWorkflowRoleInputDefinition>>;
    outputs: Record<ComfyUiSemanticOutput, ComfyUiWorkflowRoleOutputDefinition>;
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
  role?: ComfyUiWorkflowRole;
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
  projectFilePath: string;
  workflowJsonText: string;
  config?: ComfyUiConfig;
}

export interface ComfyUiWorkflowRoleImportAnalysis {
  candidates: ComfyUiRoleCandidateMap;
}

export interface ComfyUiAnalyzeWorkflowImportResponse {
  ok: boolean;
  analysis?: ComfyUiAnalyzedWorkflow;
  roleCandidates: Partial<Record<ComfyUiWorkflowRole, ComfyUiWorkflowRoleImportAnalysis>>;
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

export const COMFYUI_WORKFLOW_ROLE_CATALOG: Record<ComfyUiWorkflowRole, ComfyUiWorkflowRoleDefinition> = {
  'image.generate': {
    role: 'image.generate',
    label: 'Text to Image',
    description: 'Generate images from a text prompt.',
    provider: 'comfyui',
    contract: {
      inputs: {
        prompt: { type: 'string', required: true, editorField: 'textarea', minBindings: 1, maxBindings: 1 },
        negativePrompt: { type: 'string', required: false, editorField: 'textarea', minBindings: 0, maxBindings: 1 },
        width: { type: 'integer', required: false, editorField: 'integer', defaultValue: 1024, minBindings: 0, maxBindings: 1 },
        height: { type: 'integer', required: false, editorField: 'integer', defaultValue: 1024, minBindings: 0, maxBindings: 1 },
        seed: { type: 'integer', required: false, editorField: 'integer', minBindings: 0, maxBindings: 1 },
        steps: { type: 'integer', required: false, editorField: 'integer', defaultValue: 20, minBindings: 0, maxBindings: 1 },
        cfg: { type: 'number', required: false, editorField: 'number', minBindings: 0, maxBindings: 1 },
        filenamePrefix: { type: 'string', required: false, editorField: 'text', defaultValue: 'NovelTea', minBindings: 0, maxBindings: 1 },
      },
      outputs: {
        images: { type: 'image-list', required: true, primary: 'first', minBindings: 1, maxBindings: 1 },
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
    role: 'image.edit',
    label: 'Image Edit',
    description: 'Edit an existing image from a source image and text prompt.',
    provider: 'comfyui',
    contract: {
      inputs: {
        sourceImage: { type: 'image', required: true, editorField: 'imageAsset', minBindings: 1, maxBindings: 1 },
        prompt: { type: 'string', required: true, editorField: 'textarea', minBindings: 1, maxBindings: 1 },
        negativePrompt: { type: 'string', required: false, editorField: 'textarea', minBindings: 0, maxBindings: 1 },
        seed: { type: 'integer', required: false, editorField: 'integer', minBindings: 0, maxBindings: 1 },
        steps: { type: 'integer', required: false, editorField: 'integer', defaultValue: 4, minBindings: 0, maxBindings: 1 },
        cfg: { type: 'number', required: false, editorField: 'number', minBindings: 0, maxBindings: 1 },
        filenamePrefix: { type: 'string', required: false, editorField: 'text', defaultValue: 'NovelTea', minBindings: 0, maxBindings: 1 },
      },
      outputs: {
        images: { type: 'image-list', required: true, primary: 'first', minBindings: 1, maxBindings: 1 },
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

export const SUPPORTED_COMFYUI_WORKFLOW_ROLES = Object.keys(COMFYUI_WORKFLOW_ROLE_CATALOG) as ComfyUiWorkflowRole[];

export const BUILTIN_COMFYUI_WORKFLOW_MANIFESTS = [
  'flux2-klein-text-to-image.manifest.json',
  'flux2-klein-image-edit.manifest.json',
] as const;

const bindingValueTypes = new Set<ComfyUiWorkflowValueType>(['string', 'integer', 'number', 'image-upload-reference']);
const contractInputTypes = new Set<ComfyUiContractInputType>(['string', 'integer', 'number', 'image']);
const semanticInputs = new Set<ComfyUiSemanticInput>(['prompt', 'negativePrompt', 'sourceImage', 'maskImage', 'width', 'height', 'seed', 'steps', 'cfg', 'filenamePrefix']);
const semanticOutputs = new Set<ComfyUiSemanticOutput>(['images']);
const editorFields = new Set<ComfyUiWorkflowEditorField>(['textarea', 'text', 'integer', 'number', 'imageAsset']);

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
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

function parseSchemaVersion(value: unknown): ComfyUiWorkflowSchemaVersion {
  if (value === undefined) return 1;
  if (value !== 1 && value !== 2) throw new Error(`schemaVersion '${String(value)}' is not supported.`);
  return value;
}

function parseBindingSelector(value: unknown, path: string): ComfyUiWorkflowBindingSelector | undefined {
  if (value === undefined) return undefined;
  const selector = asRecord(value, `${path} must be an object.`);
  return {
    title: optionalString(selector.title, `${path}.title`),
    classType: optionalString(selector.classType, `${path}.classType`),
    inputName: optionalString(selector.inputName, `${path}.inputName`),
    upstreamClassType: optionalString(selector.upstreamClassType, `${path}.upstreamClassType`),
    downstreamClassType: optionalString(selector.downstreamClassType, `${path}.downstreamClassType`),
  };
}

function parseBinding(value: unknown, path: string): ComfyUiWorkflowBinding {
  const binding = asRecord(value, `${path} must be an object.`);
  const valueType = asString(binding.valueType, `${path}.valueType is required.`) as ComfyUiWorkflowValueType;
  if (!bindingValueTypes.has(valueType)) throw new Error(`${path}.valueType '${valueType}' is not supported.`);
  return {
    nodeId: optionalString(binding.nodeId, `${path}.nodeId`),
    nodeTitle: optionalString(binding.nodeTitle, `${path}.nodeTitle`),
    classType: optionalString(binding.classType, `${path}.classType`),
    inputName: asString(binding.inputName, `${path}.inputName is required.`),
    valueType,
    selector: parseBindingSelector(binding.selector, `${path}.selector`),
    resolvedNodeId: optionalString(binding.resolvedNodeId, `${path}.resolvedNodeId`),
  };
}

function parseContractInput(value: unknown, path: string): ComfyUiWorkflowContractInput {
  const input = asRecord(value, `${path} must be an object.`);
  const type = asString(input.type, `${path}.type is required.`) as ComfyUiContractInputType;
  if (!contractInputTypes.has(type)) throw new Error(`${path}.type '${type}' is not supported.`);
  const editorField = input.editorField === undefined ? undefined : asString(input.editorField, `${path}.editorField must be a string.`) as ComfyUiWorkflowEditorField;
  if (editorField && !editorFields.has(editorField)) throw new Error(`${path}.editorField '${editorField}' is not supported.`);
  const defaultValue = input.defaultValue;
  if (defaultValue !== undefined && typeof defaultValue !== 'string' && typeof defaultValue !== 'number') throw new Error(`${path}.defaultValue must be a string or number.`);
  return { type, required: asBoolean(input.required, `${path}.required is required.`), editorField, defaultValue };
}

function parseContractOutput(value: unknown, path: string): ComfyUiWorkflowContractOutput {
  const output = asRecord(value, `${path} must be an object.`);
  const type = asString(output.type, `${path}.type is required.`) as ComfyUiContractOutputType;
  if (type !== 'image-list') throw new Error(`${path}.type '${type}' is not supported.`);
  const primary = asString(output.primary, `${path}.primary is required.`) as ComfyUiImagePrimaryOutput;
  if (primary !== 'first') throw new Error(`${path}.primary '${primary}' is not supported.`);
  return { type, required: asBoolean(output.required, `${path}.required is required.`), primary };
}

function parseContract(value: unknown): ComfyUiWorkflowContract {
  const contract = asRecord(value, 'contract must be an object.');
  const inputsRecord = asRecord(contract.inputs, 'contract.inputs must be an object.');
  const inputs: Partial<Record<ComfyUiSemanticInput, ComfyUiWorkflowContractInput>> = {};
  for (const [key, input] of Object.entries(inputsRecord)) {
    if (!semanticInputs.has(key as ComfyUiSemanticInput)) throw new Error(`contract.inputs.${key} is not a supported semantic input.`);
    inputs[key as ComfyUiSemanticInput] = parseContractInput(input, `contract.inputs.${key}`);
  }
  const outputsRecord = asRecord(contract.outputs, 'contract.outputs must be an object.');
  return { inputs, outputs: { images: outputsRecord.images === undefined ? undefined : parseContractOutput(outputsRecord.images, 'contract.outputs.images') } };
}

function parseBindings(value: unknown): Partial<Record<ComfyUiSemanticInput, ComfyUiWorkflowBinding>> {
  const record = asRecord(value, 'bindings must be an object.');
  const bindings: Partial<Record<ComfyUiSemanticInput, ComfyUiWorkflowBinding>> = {};
  for (const [key, binding] of Object.entries(record)) {
    if (!semanticInputs.has(key as ComfyUiSemanticInput)) throw new Error(`bindings.${key} is not a supported semantic input.`);
    bindings[key as ComfyUiSemanticInput] = parseBinding(binding, `bindings.${key}`);
  }
  return bindings;
}

function parseOutputBinding(value: unknown, path: string): ComfyUiWorkflowOutputBinding {
  const binding = asRecord(value, `${path} must be an object.`);
  const valueType = asString(binding.valueType, `${path}.valueType is required.`) as ComfyUiContractOutputType;
  if (valueType !== 'image-list') throw new Error(`${path}.valueType '${valueType}' is not supported.`);
  const primary = asString(binding.primary, `${path}.primary is required.`) as ComfyUiImagePrimaryOutput;
  if (primary !== 'first') throw new Error(`${path}.primary '${primary}' is not supported.`);
  return {
    nodeId: optionalString(binding.nodeId, `${path}.nodeId`),
    nodeTitle: optionalString(binding.nodeTitle, `${path}.nodeTitle`),
    classType: optionalString(binding.classType, `${path}.classType`),
    outputName: optionalString(binding.outputName, `${path}.outputName`),
    valueType,
    primary,
  };
}

function parseOutputBindings(value: unknown): Partial<Record<ComfyUiSemanticOutput, ComfyUiWorkflowOutputBinding[]>> {
  if (value === undefined) return {};
  const record = asRecord(value, 'outputBindings must be an object.');
  const bindings: Partial<Record<ComfyUiSemanticOutput, ComfyUiWorkflowOutputBinding[]>> = {};
  for (const [key, outputBindings] of Object.entries(record)) {
    if (!semanticOutputs.has(key as ComfyUiSemanticOutput)) throw new Error(`outputBindings.${key} is not a supported semantic output.`);
    if (!Array.isArray(outputBindings)) throw new Error(`outputBindings.${key} must be an array.`);
    bindings[key as ComfyUiSemanticOutput] = outputBindings.map((binding, index) => parseOutputBinding(binding, `outputBindings.${key}.${index}`));
  }
  return bindings;
}

function parseDefaults(value: unknown): ComfyUiWorkflowDefinition['defaults'] {
  const record = asRecord(value, 'defaults must be an object.');
  const defaults: Record<string, string | number> & { filenamePrefix: string } = {
    filenamePrefix: asString(record.filenamePrefix, 'defaults.filenamePrefix is required.'),
  };
  for (const [key, item] of Object.entries(record)) {
    if (key === 'filenamePrefix') continue;
    if (!semanticInputs.has(key as ComfyUiSemanticInput)) throw new Error(`defaults.${key} is not a supported semantic input.`);
    if (typeof item !== 'string' && typeof item !== 'number') throw new Error(`defaults.${key} must be a string or number.`);
    (defaults as Record<string, string | number>)[key] = item;
  }
  return defaults;
}

function safeWorkflowSiblingPath(value: string, label: string) {
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value.startsWith('.')) {
    throw new Error(`${label} must be a safe file name in the workflows directory.`);
  }
}

function workflowContractDiagnostic(path: string, message: string): ComfyUiWorkflowDiagnostic {
  return { severity: 'error', category: 'comfyui-workflows', path, message };
}

export function comfyUiWorkflowBindingValueTypeMatchesContract(contractType: ComfyUiContractInputType, valueType: ComfyUiWorkflowValueType): boolean {
  if (contractType === 'string') return valueType === 'string';
  if (contractType === 'integer') return valueType === 'integer';
  if (contractType === 'number') return valueType === 'number' || valueType === 'integer';
  if (contractType === 'image') return valueType === 'image-upload-reference';
  return false;
}

function inputBindingCount(definition: ComfyUiWorkflowDefinition, input: ComfyUiSemanticInput): number {
  return definition.bindings[input] ? 1 : 0;
}

function outputBindingCount(definition: ComfyUiWorkflowDefinition, output: ComfyUiSemanticOutput): number {
  const explicitBindings = definition.outputBindings[output] ?? [];
  return explicitBindings.length || definition.outputNodeIds.length;
}

export function validateComfyUiWorkflowDefinitionContract(definition: ComfyUiWorkflowDefinition): ComfyUiWorkflowDiagnostic[] {
  const diagnostics: ComfyUiWorkflowDiagnostic[] = [];
  const roleDefinition = COMFYUI_WORKFLOW_ROLE_CATALOG[definition.role];
  if (!roleDefinition) {
    diagnostics.push(workflowContractDiagnostic('/role', `role '${definition.role}' is not supported.`));
    return diagnostics;
  }

  for (const [input, contractInput] of Object.entries(definition.contract.inputs) as Array<[ComfyUiSemanticInput, ComfyUiWorkflowContractInput]>) {
    const roleInput = roleDefinition.contract.inputs[input];
    if (!roleInput) {
      diagnostics.push(workflowContractDiagnostic(`/contract/inputs/${input}`, `${definition.role} workflows do not support contract.inputs.${input}.`));
      continue;
    }
    if (contractInput.type !== roleInput.type) {
      diagnostics.push(workflowContractDiagnostic(`/contract/inputs/${input}/type`, `${definition.role} workflows must declare contract.inputs.${input} as ${roleInput.type}.`));
    }
  }

  for (const [input, roleInput] of Object.entries(roleDefinition.contract.inputs) as Array<[ComfyUiSemanticInput, ComfyUiWorkflowRoleInputDefinition]>) {
    const contractInput = definition.contract.inputs[input];
    const binding = definition.bindings[input];
    const bindingCount = inputBindingCount(definition, input);
    const minimum = contractInput?.required ? Math.max(1, roleInput.minBindings) : roleInput.minBindings;
    if (roleInput.required && (!contractInput?.required || contractInput.type !== roleInput.type)) {
      diagnostics.push(workflowContractDiagnostic(`/contract/inputs/${input}`, `${definition.role} workflows must declare required contract.inputs.${input} as ${roleInput.type}.`));
    }
    if (bindingCount < minimum) {
      diagnostics.push(workflowContractDiagnostic(`/bindings/${input}`, `${definition.role} workflows require ${minimum === 1 ? 'exactly one' : `at least ${minimum}`} ${input} binding.`));
    }
    if (bindingCount > roleInput.maxBindings) {
      diagnostics.push(workflowContractDiagnostic(`/bindings/${input}`, `${input} supports at most ${roleInput.maxBindings} binding${roleInput.maxBindings === 1 ? '' : 's'} for ${definition.role}.`));
    }
    if (binding && contractInput && !comfyUiWorkflowBindingValueTypeMatchesContract(contractInput.type, binding.valueType)) {
      diagnostics.push(workflowContractDiagnostic(`/bindings/${input}/valueType`, `bindings.${input}.valueType '${binding.valueType}' is not compatible with contract.inputs.${input}.type '${contractInput.type}'.`));
    }
  }

  for (const [input, binding] of Object.entries(definition.bindings) as Array<[ComfyUiSemanticInput, ComfyUiWorkflowBinding]>) {
    const contractInput = definition.contract.inputs[input];
    const roleInput = roleDefinition.contract.inputs[input];
    if (!roleInput) {
      diagnostics.push(workflowContractDiagnostic(`/bindings/${input}`, `${definition.role} workflows do not support bindings.${input}.`));
      continue;
    }
    if (!contractInput) {
      diagnostics.push(workflowContractDiagnostic(`/bindings/${input}`, `bindings.${input} must be declared by contract.inputs.${input}.`));
      continue;
    }
    if (!comfyUiWorkflowBindingValueTypeMatchesContract(contractInput.type, binding.valueType)) {
      diagnostics.push(workflowContractDiagnostic(`/bindings/${input}/valueType`, `bindings.${input}.valueType '${binding.valueType}' is not compatible with contract.inputs.${input}.type '${contractInput.type}'.`));
    }
  }

  for (const [input] of Object.entries(definition.defaults) as Array<[ComfyUiSemanticInput, string | number]>) {
    if (input === 'filenamePrefix') continue;
    if (!roleDefinition.contract.inputs[input]) {
      diagnostics.push(workflowContractDiagnostic(`/defaults/${input}`, `${definition.role} workflows do not support defaults.${input}.`));
      continue;
    }
    if (!definition.contract.inputs[input]) {
      diagnostics.push(workflowContractDiagnostic(`/defaults/${input}`, `defaults.${input} must be declared by contract.inputs.${input}.`));
    }
  }

  const roleImages = roleDefinition.contract.outputs.images;
  const images = definition.contract.outputs.images;
  if (!images) {
    diagnostics.push(workflowContractDiagnostic('/contract/outputs/images', `${definition.role} workflows must declare required contract.outputs.images.`));
  } else {
    if (roleImages.required && !images.required) {
      diagnostics.push(workflowContractDiagnostic('/contract/outputs/images/required', `${definition.role} workflows must declare required contract.outputs.images.`));
    }
    if (images.type !== roleImages.type || images.primary !== roleImages.primary) {
      diagnostics.push(workflowContractDiagnostic('/contract/outputs/images', `${definition.role} workflows must declare contract.outputs.images as ${roleImages.type}/${roleImages.primary}.`));
    }
  }
  const imageBindingCount = outputBindingCount(definition, 'images');
  if (imageBindingCount < roleImages.minBindings) {
    diagnostics.push(workflowContractDiagnostic('/outputBindings/images', `${definition.role} workflows require at least one images output binding.`));
  }
  if (imageBindingCount > roleImages.maxBindings) {
    diagnostics.push(workflowContractDiagnostic('/outputBindings/images', `images supports at most ${roleImages.maxBindings} output binding${roleImages.maxBindings === 1 ? '' : 's'} for ${definition.role}.`));
  }
  if (definition.outputBindings.images?.length && !images) {
    diagnostics.push(workflowContractDiagnostic('/outputBindings/images', 'outputBindings.images must be declared by contract.outputs.images.'));
  }

  return diagnostics;
}

function validateRoleContract(definition: ComfyUiWorkflowDefinition) {
  const diagnostics = validateComfyUiWorkflowDefinitionContract(definition);
  const firstError = diagnostics.find((item) => item.severity === 'error');
  if (firstError) throw new Error(firstError.message);
}

export function parseComfyUiWorkflowDefinition(value: unknown, manifestFile?: string): ComfyUiWorkflowDefinition {
  const manifest = asRecord(value, 'ComfyUI workflow manifest must be an object.');
  const provider = asString(manifest.provider, 'provider is required.') as ComfyUiWorkflowProvider;
  if (provider !== 'comfyui') throw new Error(`provider '${provider}' is not supported.`);
  const role = asString(manifest.role, 'role is required.') as ComfyUiWorkflowRole;
  if (!SUPPORTED_COMFYUI_WORKFLOW_ROLES.includes(role)) throw new Error(`role '${role}' is not supported.`);
  const workflowFile = asString(manifest.workflowFile, 'workflowFile is required.');
  safeWorkflowSiblingPath(workflowFile, 'workflowFile');
  const definition: ComfyUiWorkflowDefinition = {
    schemaVersion: parseSchemaVersion(manifest.schemaVersion),
    id: asString(manifest.id, 'id is required.'),
    label: asString(manifest.label, 'label is required.'),
    provider,
    role,
    description: typeof manifest.description === 'string' ? manifest.description : undefined,
    workflowFile,
    contract: parseContract(manifest.contract),
    bindings: parseBindings(manifest.bindings),
    defaults: parseDefaults(manifest.defaults),
    outputNodeIds: Array.isArray(manifest.outputNodeIds) ? manifest.outputNodeIds.map((item) => asString(item, 'outputNodeIds entries must be strings.')) : [],
    outputBindings: parseOutputBindings(manifest.outputBindings),
    requiredNodeClasses: Array.isArray(manifest.requiredNodeClasses) ? manifest.requiredNodeClasses.map((item) => asString(item, 'requiredNodeClasses entries must be strings.')) : [],
    manifestFile,
  };
  safeWorkflowSiblingPath(definition.id, 'id');
  validateRoleContract(definition);
  return definition;
}

function workflowNodeTitle(node: ComfyUiWorkflowNodeLike): string | undefined {
  return typeof node._meta?.title === 'string' && node._meta.title.trim() ? node._meta.title : undefined;
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

function nodeMatches(graph: ComfyUiWorkflowGraphLike, predicate: (nodeId: string, node: ComfyUiWorkflowNodeLike) => boolean): string[] {
  return Object.entries(graph).filter(([nodeId, node]) => predicate(nodeId, node)).map(([nodeId]) => nodeId);
}

function resolutionFromMatches(matches: string[], bindingLabel: string, currentNodeId?: string): ComfyUiBindingResolution | null {
  if (matches.length === 1) return { ok: true, nodeId: matches[0], rebased: matches[0] !== currentNodeId };
  if (matches.length > 1) {
    return {
      ok: false,
      ambiguous: true,
      message: `Binding '${bindingLabel}' matches multiple workflow nodes: ${matches.join(', ')}.`,
    };
  }
  return null;
}

export function resolveComfyUiWorkflowBinding(graph: ComfyUiWorkflowGraphLike, binding: ComfyUiWorkflowBinding): ComfyUiBindingResolution {
  if (binding.nodeId) {
    const node = graph[binding.nodeId];
    if (nodeMatchesInput(node ?? {}, binding.inputName)) return { ok: true, nodeId: binding.nodeId };
  }

  const title = binding.selector?.title ?? binding.nodeTitle;
  const classType = binding.selector?.classType ?? binding.classType;
  const inputName = binding.selector?.inputName ?? binding.inputName;
  const bindingLabel = `${binding.nodeId ?? binding.nodeTitle ?? classType ?? 'unknown'}.${binding.inputName}`;

  if (title && classType) {
    const resolution = resolutionFromMatches(nodeMatches(graph, (_nodeId, node) => nodeMatchesTitle(node, title) && nodeMatchesClass(node, classType) && nodeMatchesInput(node, inputName)), bindingLabel, binding.nodeId);
    if (resolution) return resolution;
  }
  if (title) {
    const resolution = resolutionFromMatches(nodeMatches(graph, (_nodeId, node) => nodeMatchesTitle(node, title) && nodeMatchesInput(node, inputName)), bindingLabel, binding.nodeId);
    if (resolution) return resolution;
  }
  if (classType) {
    const resolution = resolutionFromMatches(nodeMatches(graph, (_nodeId, node) => nodeMatchesClass(node, classType) && nodeMatchesInput(node, inputName)), bindingLabel, binding.nodeId);
    if (resolution) return resolution;
  }

  return { ok: false, message: `Could not resolve binding '${bindingLabel}'.` };
}

export function resolveComfyUiWorkflowOutputBinding(graph: ComfyUiWorkflowGraphLike, binding: ComfyUiWorkflowOutputBinding): ComfyUiBindingResolution {
  if (binding.nodeId && graph[binding.nodeId]) return { ok: true, nodeId: binding.nodeId };

  const title = binding.nodeTitle;
  const classType = binding.classType;
  const bindingLabel = binding.nodeId ?? binding.nodeTitle ?? classType ?? 'unknown';

  if (title && classType) {
    const resolution = resolutionFromMatches(nodeMatches(graph, (_nodeId, node) => nodeMatchesTitle(node, title) && nodeMatchesClass(node, classType)), bindingLabel, binding.nodeId);
    if (resolution) return resolution;
  }
  if (title) {
    const resolution = resolutionFromMatches(nodeMatches(graph, (_nodeId, node) => nodeMatchesTitle(node, title)), bindingLabel, binding.nodeId);
    if (resolution) return resolution;
  }
  if (classType) {
    const resolution = resolutionFromMatches(nodeMatches(graph, (_nodeId, node) => nodeMatchesClass(node, classType)), bindingLabel, binding.nodeId);
    if (resolution) return resolution;
  }

  return { ok: false, message: `Could not resolve output binding '${bindingLabel}'.` };
}

export function resolveComfyUiWorkflowOutputNodeIds(graph: ComfyUiWorkflowGraphLike, definition: ComfyUiWorkflowDefinition): ComfyUiBindingResolution {
  const outputBindings = definition.outputBindings.images ?? [];
  if (outputBindings.length) {
    const nodeIds: string[] = [];
    for (const binding of outputBindings) {
      const resolution = resolveComfyUiWorkflowOutputBinding(graph, binding);
      if (!resolution.ok || !resolution.nodeId) return resolution;
      nodeIds.push(resolution.nodeId);
    }
    return { ok: true, nodeId: nodeIds.join('\0') };
  }
  const missing = definition.outputNodeIds.find((nodeId) => !graph[nodeId]);
  if (missing) return { ok: false, message: `Workflow '${definition.label}' is missing output node '${missing}'.` };
  return { ok: true, nodeId: definition.outputNodeIds.join('\0') };
}

export function resolvedComfyUiWorkflowOutputNodeIdList(graph: ComfyUiWorkflowGraphLike, definition: ComfyUiWorkflowDefinition): string[] {
  const resolution = resolveComfyUiWorkflowOutputNodeIds(graph, definition);
  if (!resolution.ok) throw new Error(resolution.message ?? `Workflow '${definition.label}' output bindings could not be resolved.`);
  return resolution.nodeId ? resolution.nodeId.split('\0').filter(Boolean) : [];
}
