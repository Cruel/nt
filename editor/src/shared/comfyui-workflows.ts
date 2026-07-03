export type ComfyUiWorkflowId = string;
export type ComfyUiWorkflowRole = 'image.generate' | 'image.edit';
export type ComfyUiWorkflowProvider = 'comfyui';
export type ComfyUiWorkflowValueType = 'string' | 'integer' | 'number' | 'image-upload-reference';
export type ComfyUiContractInputType = 'string' | 'integer' | 'number' | 'image';
export type ComfyUiContractOutputType = 'image-list';
export type ComfyUiImagePrimaryOutput = 'first';

export type ComfyUiSemanticInput = 'prompt' | 'negativePrompt' | 'sourceImage' | 'maskImage' | 'width' | 'height' | 'seed' | 'steps' | 'cfg' | 'filenamePrefix';

export interface ComfyUiWorkflowBinding {
  nodeId: string;
  inputName: string;
  valueType: ComfyUiWorkflowValueType;
}

export interface ComfyUiWorkflowContractInput {
  type: ComfyUiContractInputType;
  required: boolean;
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
  defaults: Record<string, string | number> & { filenamePrefix: string };
  manifestFile?: string;
}

export interface ComfyUiWorkflowDiagnostic {
  severity: 'error' | 'warning' | 'info';
  category: 'comfyui-workflows';
  path: string;
  message: string;
}

export interface ComfyUiWorkflowListResponse {
  ok: boolean;
  success: boolean;
  workflows: ComfyUiWorkflowDefinition[];
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

export const SUPPORTED_COMFYUI_WORKFLOW_ROLES: ComfyUiWorkflowRole[] = ['image.generate', 'image.edit'];

export const BUILTIN_COMFYUI_WORKFLOW_MANIFESTS = [
  'flux2-klein-text-to-image.manifest.json',
  'flux2-klein-image-edit.manifest.json',
] as const;

const bindingValueTypes = new Set<ComfyUiWorkflowValueType>(['string', 'integer', 'number', 'image-upload-reference']);
const contractInputTypes = new Set<ComfyUiContractInputType>(['string', 'integer', 'number', 'image']);
const semanticInputs = new Set<ComfyUiSemanticInput>(['prompt', 'negativePrompt', 'sourceImage', 'maskImage', 'width', 'height', 'seed', 'steps', 'cfg', 'filenamePrefix']);

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

function parseBinding(value: unknown, path: string): ComfyUiWorkflowBinding {
  const binding = asRecord(value, `${path} must be an object.`);
  const valueType = asString(binding.valueType, `${path}.valueType is required.`) as ComfyUiWorkflowValueType;
  if (!bindingValueTypes.has(valueType)) throw new Error(`${path}.valueType '${valueType}' is not supported.`);
  return {
    nodeId: asString(binding.nodeId, `${path}.nodeId is required.`),
    inputName: asString(binding.inputName, `${path}.inputName is required.`),
    valueType,
  };
}

function parseContractInput(value: unknown, path: string): ComfyUiWorkflowContractInput {
  const input = asRecord(value, `${path} must be an object.`);
  const type = asString(input.type, `${path}.type is required.`) as ComfyUiContractInputType;
  if (!contractInputTypes.has(type)) throw new Error(`${path}.type '${type}' is not supported.`);
  return { type, required: asBoolean(input.required, `${path}.required is required.`) };
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

function validateRoleContract(definition: ComfyUiWorkflowDefinition) {
  const images = definition.contract.outputs.images;
  if (!images?.required || images.type !== 'image-list') throw new Error(`${definition.role} workflows must declare required contract.outputs.images.`);
  const requireInput = (input: ComfyUiSemanticInput, type: ComfyUiContractInputType) => {
    const contractInput = definition.contract.inputs[input];
    if (!contractInput?.required || contractInput.type !== type) throw new Error(`${definition.role} workflows must declare required contract.inputs.${input} as ${type}.`);
    if (!definition.bindings[input]) throw new Error(`${definition.role} workflows must bind ${input}.`);
  };
  if (definition.role === 'image.generate') {
    requireInput('prompt', 'string');
  } else if (definition.role === 'image.edit') {
    requireInput('sourceImage', 'image');
    requireInput('prompt', 'string');
  }
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
    requiredNodeClasses: Array.isArray(manifest.requiredNodeClasses) ? manifest.requiredNodeClasses.map((item) => asString(item, 'requiredNodeClasses entries must be strings.')) : [],
    manifestFile,
  };
  safeWorkflowSiblingPath(definition.id, 'id');
  validateRoleContract(definition);
  return definition;
}
