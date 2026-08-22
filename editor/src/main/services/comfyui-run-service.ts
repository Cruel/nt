import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  prepareComfyUiImageInput,
  uploadComfyUiImageInput,
  validateComfyUiImageUploadTarget,
  type PreparedComfyUiImageInput,
} from './comfyui-image-media-service';
import { ComfyUiRunError } from './comfyui-run-errors';
import {
  resolveComfyUiWorkflowBinding,
  resolvedComfyUiWorkflowOutputNodeIdList,
  type ComfyUiWorkflowBinding,
  type ComfyUiWorkflowLibraryEntry,
  type ComfyUiWorkflowContractInput,
} from '../../shared/comfyui-workflows';
import { normalizeComfyUiServerUrl, type ComfyUiConfig } from '../../shared/comfyui';

const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_IMAGE_OUTPUT_BYTES = 32 * 1024 * 1024;
const HISTORY_POLL_INTERVAL_MS = 250;

type WorkflowGraph = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

export interface PreparedComfyUiWorkflow {
  workflow: WorkflowGraph;
  imageInputs: PreparedComfyUiImageInput[];
}

export type ComfyUiRunnableWorkflowEntry = ComfyUiWorkflowLibraryEntry & {
  id: string;
  label: string;
  definition: NonNullable<ComfyUiWorkflowLibraryEntry['definition']>;
  workflowJsonText: string;
  packageHash: NonNullable<ComfyUiWorkflowLibraryEntry['packageHash']>;
  active: true;
  runnable: true;
};

interface ImageDescriptor {
  filename: string;
  subfolder?: string;
  type?: string;
}

export interface ComfyUiGeneratedImage {
  outputId: string;
  format: 'png' | 'jpeg' | 'webp' | 'gif';
  mimeType: string;
  byteSize: number;
  contentHash: `sha256:${string}`;
  width: number;
  height: number;
  hasAlpha: boolean;
  bytes: Uint8Array;
}

interface ComfyUiScalarRunOutput extends Omit<ComfyUiGeneratedImage, 'bytes'> {
  target: 'filesystem';
  path: string;
}

interface ComfyUiPendingRunOutput extends ComfyUiGeneratedImage {
  target: 'pending';
}

interface ComfyUiScalarRunResult {
  workflowId: string;
  workflowKey: string;
  workflowSource: string;
  packageHash: string;
  serverUrl: string;
  clientId: string;
  promptId: string;
  output: ComfyUiScalarRunOutput | ComfyUiPendingRunOutput;
}

export interface ComfyUiOutputRoutePlan {
  outputId: string;
  target: 'asset' | 'filesystem';
  path?: string;
  cardinality: 'one' | 'many';
}

export interface ComfyUiRunPlan {
  routes: Record<string, ComfyUiOutputRoutePlan>;
}

export interface ComfyUiRunResult {
  workflowId: string;
  workflowKey: string;
  workflowSource: string;
  packageHash: string;
  serverUrl: string;
  clientId: string;
  promptId: string;
  outputs: Record<string, ComfyUiGeneratedImage[]>;
}

export { ComfyUiRunError } from './comfyui-run-errors';

function boundedMessage(value: unknown, fallback: string) {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 512);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const candidate of [record.message, record.error, record.exception_message])
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 512);
  }
  return fallback;
}

function endpoint(config: ComfyUiConfig, pathname: string) {
  const base = new URL(normalizeComfyUiServerUrl(config.serverUrl));
  return new URL(
    pathname,
    `${base.origin}${base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`}`,
  );
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes)
    throw new ComfyUiRunError(
      'COMFYUI_RESPONSE_TOO_LARGE',
      '/server',
      'ComfyUI response exceeded the allowed size.',
    );
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ComfyUiRunError(
        'COMFYUI_RESPONSE_TOO_LARGE',
        '/server',
        'ComfyUI response exceeded the allowed size.',
      );
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function requestBytes(
  config: ComfyUiConfig,
  pathname: string,
  init?: RequestInit,
  maximumBytes = MAX_JSON_RESPONSE_BYTES,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(endpoint(config, pathname), {
      ...init,
      signal: controller.signal,
    });
    const bytes = await readBoundedResponse(response, maximumBytes);
    if (!response.ok)
      throw new ComfyUiRunError(
        'COMFYUI_SERVER_ERROR',
        '/server',
        `ComfyUI returned HTTP ${response.status}: ${boundedMessage(
          new TextDecoder().decode(bytes),
          'request failed',
        )}`,
      );
    return bytes;
  } catch (error) {
    if (error instanceof ComfyUiRunError) throw error;
    if (error instanceof Error && error.name === 'AbortError')
      throw new ComfyUiRunError('COMFYUI_REQUEST_TIMEOUT', '/server', 'ComfyUI request timed out.');
    throw new ComfyUiRunError('COMFYUI_SERVER_UNAVAILABLE', '/server', 'ComfyUI request failed.');
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(config: ComfyUiConfig, pathname: string, init?: RequestInit) {
  const bytes = await requestBytes(config, pathname, init);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ComfyUiRunError(
      'COMFYUI_INVALID_RESPONSE',
      '/server',
      'ComfyUI returned invalid JSON.',
    );
  }
}

function coerceScalarInput(id: string, input: ComfyUiWorkflowContractInput, value: string) {
  if (input.type === 'string') return value;
  if (input.type === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new ComfyUiRunError(
      'COMFYUI_INPUT_TYPE',
      `/inputs/${id}`,
      `Input '${id}' must be 'true' or 'false'.`,
    );
  }
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new ComfyUiRunError(
      'COMFYUI_INPUT_TYPE',
      `/inputs/${id}`,
      `Input '${id}' must be a ${input.type}.`,
    );
  if (input.type === 'integer' && !Number.isInteger(number))
    throw new ComfyUiRunError(
      'COMFYUI_INPUT_TYPE',
      `/inputs/${id}`,
      `Input '${id}' must be an integer.`,
    );
  return number;
}

function setBinding(workflow: WorkflowGraph, binding: ComfyUiWorkflowBinding, value: unknown) {
  const resolved = resolveComfyUiWorkflowBinding(workflow, binding);
  if (!resolved.ok || !resolved.nodeId)
    throw new ComfyUiRunError(
      'COMFYUI_BINDING_INVALID',
      '/workflow',
      resolved.message ?? 'Workflow binding could not be resolved.',
    );
  const node = workflow[resolved.nodeId];
  const inputName = binding.selector?.inputName ?? binding.inputName;
  if (!node?.inputs || !(inputName in node.inputs))
    throw new ComfyUiRunError(
      'COMFYUI_BINDING_INVALID',
      '/workflow',
      `Workflow input '${resolved.nodeId}.${inputName}' is missing.`,
    );
  node.inputs[inputName] = value;
}

export async function prepareComfyUiWorkflow(
  entry: ComfyUiRunnableWorkflowEntry,
  suppliedInputs: ReadonlyMap<string, string>,
  cwd: string,
): Promise<PreparedComfyUiWorkflow> {
  if (!entry.workflowJsonText)
    throw new ComfyUiRunError(
      'COMFYUI_WORKFLOW_INVALID',
      '/workflow',
      'Workflow JSON is unavailable.',
    );
  let workflow: WorkflowGraph;
  try {
    workflow = JSON.parse(entry.workflowJsonText) as WorkflowGraph;
  } catch {
    throw new ComfyUiRunError('COMFYUI_WORKFLOW_INVALID', '/workflow', 'Workflow JSON is invalid.');
  }
  for (const id of suppliedInputs.keys())
    if (!entry.definition.contract.inputs[id])
      throw new ComfyUiRunError(
        'COMFYUI_INPUT_UNKNOWN',
        `/inputs/${id}`,
        `Unknown workflow input '${id}'.`,
      );
  const imageInputs: PreparedComfyUiImageInput[] = [];
  for (const [id, input] of Object.entries(entry.definition.contract.inputs)) {
    const supplied = suppliedInputs.get(id);
    const sourceValue = supplied ?? input.defaultValue;
    if (sourceValue === undefined) {
      if (input.required)
        throw new ComfyUiRunError(
          'COMFYUI_INPUT_REQUIRED',
          `/inputs/${id}`,
          `Required workflow input '${id}' was not supplied.`,
        );
      continue;
    }
    if (input.type === 'image') {
      imageInputs.push(await prepareComfyUiImageInput(id, String(sourceValue), cwd));
      continue;
    }
    const value = supplied !== undefined ? coerceScalarInput(id, input, supplied) : sourceValue;
    for (const binding of entry.definition.bindings[id] ?? []) setBinding(workflow, binding, value);
  }
  return { workflow, imageInputs };
}

function imageFormat(bytes: Uint8Array): {
  format: ComfyUiGeneratedImage['format'];
  mimeType: string;
  width: number;
  height: number;
  hasAlpha: boolean;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength >= 33 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    let offset = 8;
    let width = 0;
    let height = 0;
    let sawImageData = false;
    let sawEnd = false;
    let sawTransparency = false;
    while (offset + 12 <= bytes.byteLength) {
      const length = view.getUint32(offset, false);
      const chunkEnd = offset + 12 + length;
      if (chunkEnd > bytes.byteLength) break;
      const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      if (type === 'IHDR' && length === 13 && offset === 8) {
        width = view.getUint32(offset + 8, false);
        height = view.getUint32(offset + 12, false);
      } else if (type === 'IDAT') {
        sawImageData = true;
      } else if (type === 'tRNS') {
        sawTransparency = true;
      } else if (type === 'IEND' && length === 0) {
        sawEnd = true;
        break;
      }
      offset = chunkEnd;
    }
    if (width && height && sawImageData && sawEnd) {
      const colorType = bytes[25];
      return {
        format: 'png',
        mimeType: 'image/png',
        width,
        height,
        hasAlpha: colorType === 4 || colorType === 6 || sawTransparency,
      };
    }
  }
  if (
    bytes.byteLength >= 10 &&
    (String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a' ||
      String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a')
  ) {
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    if (width && height) {
      let hasAlpha = false;
      for (let index = 13; index + 3 < bytes.byteLength; index += 1)
        if (bytes[index] === 0x21 && bytes[index + 1] === 0xf9 && bytes[index + 2] === 0x04) {
          hasAlpha ||= (bytes[index + 3]! & 0x01) !== 0;
          if (hasAlpha) break;
        }
      return { format: 'gif', mimeType: 'image/gif', width, height, hasAlpha };
    }
  }
  if (
    bytes.byteLength >= 30 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === 'VP8X' && bytes.byteLength >= 30) {
      const width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      const height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
      return {
        format: 'webp',
        mimeType: 'image/webp',
        width,
        height,
        hasAlpha: (bytes[20]! & 0x10) !== 0,
      };
    }
    if (chunk === 'VP8L' && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
      const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
      return {
        format: 'webp',
        mimeType: 'image/webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
        hasAlpha: ((bits >>> 28) & 1) !== 0,
      };
    }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const width = view.getUint16(26, true) & 0x3fff;
      const height = view.getUint16(28, true) & 0x3fff;
      if (width && height)
        return { format: 'webp', mimeType: 'image/webp', width, height, hasAlpha: false };
    }
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      if (marker === 0xd9 || marker === 0xda) break;
      const length = view.getUint16(offset + 2, false);
      if (length < 2 || offset + 2 + length > bytes.byteLength) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        const height = view.getUint16(offset + 5, false);
        const width = view.getUint16(offset + 7, false);
        if (width && height)
          return { format: 'jpeg', mimeType: 'image/jpeg', width, height, hasAlpha: false };
      }
      offset += 2 + length;
    }
  }
  throw new ComfyUiRunError(
    'COMFYUI_OUTPUT_INVALID',
    '/outputs',
    'ComfyUI returned an invalid or unsupported image.',
  );
}

function extensionMatches(outputPath: string, format: ComfyUiGeneratedImage['format']) {
  const extension = path.extname(outputPath).toLowerCase();
  if (format === 'jpeg') return extension === '.jpg' || extension === '.jpeg';
  return extension === `.${format}`;
}

function promptHistoryRecord(history: unknown, promptId: string): Record<string, unknown> | null {
  if (!history || typeof history !== 'object') return null;
  const prompt = (history as Record<string, unknown>)[promptId];
  return prompt && typeof prompt === 'object' ? (prompt as Record<string, unknown>) : null;
}

function historyFailure(history: unknown, promptId: string) {
  const prompt = promptHistoryRecord(history, promptId);
  if (!prompt) return null;
  const status = prompt.status;
  if (!status || typeof status !== 'object') return null;
  const record = status as Record<string, unknown>;
  if (record.status_str === 'error')
    return new ComfyUiRunError(
      'COMFYUI_EXECUTION_FAILED',
      '/prompt',
      boundedMessage(record.messages, 'ComfyUI workflow execution failed.'),
    );
  return null;
}

function historyCompleted(history: unknown, promptId: string) {
  const prompt = promptHistoryRecord(history, promptId);
  if (!prompt) return false;
  const status = prompt.status;
  return Boolean(
    status && typeof status === 'object' && (status as Record<string, unknown>).completed === true,
  );
}

function descriptorsForOutput(history: unknown, promptId: string, nodeIds: string[]) {
  if (!history || typeof history !== 'object') return [];
  const prompt = promptHistoryRecord(history, promptId);
  if (!prompt) return [];
  const outputs = prompt.outputs;
  if (!outputs || typeof outputs !== 'object') return [];
  const descriptors: ImageDescriptor[] = [];
  for (const nodeId of nodeIds) {
    const nodeOutput = (outputs as Record<string, unknown>)[nodeId];
    const images =
      nodeOutput && typeof nodeOutput === 'object'
        ? (nodeOutput as { images?: unknown }).images
        : null;
    if (!Array.isArray(images)) continue;
    for (const value of images)
      if (
        value &&
        typeof value === 'object' &&
        typeof (value as ImageDescriptor).filename === 'string'
      )
        descriptors.push(value as ImageDescriptor);
  }
  return descriptors;
}

async function bindPreparedImageInputs(
  config: ComfyUiConfig,
  workflow: WorkflowGraph,
  entry: ComfyUiRunnableWorkflowEntry,
  imageInputs: PreparedComfyUiImageInput[],
) {
  if (imageInputs.length === 0) return;
  validateComfyUiImageUploadTarget(config);
  for (const input of imageInputs) {
    const remoteReference = await uploadComfyUiImageInput(config, input);
    for (const binding of entry.definition.bindings[input.id] ?? [])
      setBinding(workflow, binding, remoteReference);
  }
}

async function cancelPrompt(config: ComfyUiConfig, promptId: string) {
  await requestJson(config, '/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delete: [promptId] }),
  }).catch(() => undefined);
}

function abortError(promptId: string) {
  return new ComfyUiRunError(
    'COMFYUI_INTERRUPTED',
    '/prompt',
    `ComfyUI prompt '${promptId}' was interrupted.`,
    true,
  );
}

async function validateFilesystemOutputParent(outputPath: string, outputId: string) {
  let candidate = path.dirname(outputPath);
  for (;;) {
    try {
      const stats = await fs.stat(candidate);
      if (!stats.isDirectory())
        throw new ComfyUiRunError(
          'COMFYUI_OUTPUT_PARENT_INVALID',
          `/outputs/${outputId}`,
          `Output parent is not a directory: ${candidate}`,
        );
      return;
    } catch (error) {
      if (error instanceof ComfyUiRunError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return;
      candidate = parent;
    }
  }
}

export async function preflightComfyUiScalarRun(options: {
  entry: ComfyUiRunnableWorkflowEntry;
  outputPath?: string;
  force: boolean;
  config?: ComfyUiConfig;
  imageInputs?: PreparedComfyUiImageInput[];
}) {
  if (options.imageInputs?.length) {
    if (!options.config)
      throw new ComfyUiRunError(
        'COMFYUI_UPLOAD_TARGET_DENIED',
        '/server',
        'ComfyUI server configuration is required for local image inputs.',
      );
    validateComfyUiImageUploadTarget(options.config);
  }
  const outputIds = Object.keys(options.entry.definition.contract.outputs);
  if (outputIds.length !== 1)
    throw new ComfyUiRunError(
      'COMFYUI_OUTPUT_ROUTING',
      '/outputs',
      'This execution slice requires exactly one declared output.',
    );
  const outputId = outputIds[0]!;
  const outputContract = options.entry.definition.contract.outputs[outputId]!;
  if (outputContract.mediaType !== 'image')
    throw new ComfyUiRunError(
      'COMFYUI_OUTPUT_UNSUPPORTED',
      `/outputs/${outputId}`,
      `Output '${outputId}' is not an image output.`,
    );
  if (!outputContract.required || outputContract.cardinality !== 'one')
    throw new ComfyUiRunError(
      'COMFYUI_OUTPUT_CARDINALITY',
      `/outputs/${outputId}`,
      `Output '${outputId}' must be a required cardinality-'one' image for file publication in this execution slice.`,
    );
  if (!options.outputPath) return { outputId, absoluteOutputPath: null };
  const absoluteOutputPath = path.resolve(options.outputPath);
  const extension = path.extname(absoluteOutputPath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension))
    throw new ComfyUiRunError(
      'COMFYUI_OUTPUT_EXTENSION',
      `/outputs/${outputId}`,
      'Filesystem image output must use .png, .jpg, .jpeg, .webp, or .gif.',
    );
  await validateFilesystemOutputParent(absoluteOutputPath, outputId);
  try {
    const stats = await fs.lstat(absoluteOutputPath);
    if (stats.isDirectory())
      throw new ComfyUiRunError(
        'COMFYUI_OUTPUT_DESTINATION_INVALID',
        `/outputs/${outputId}`,
        `Output destination is a directory: ${absoluteOutputPath}`,
      );
    if (!options.force)
      throw new ComfyUiRunError(
        'COMFYUI_OUTPUT_EXISTS',
        `/outputs/${outputId}`,
        `Output destination already exists: ${absoluteOutputPath}`,
      );
  } catch (error) {
    if (error instanceof ComfyUiRunError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { outputId, absoluteOutputPath };
}

export async function runComfyUiScalarWorkflow(options: {
  entry: ComfyUiRunnableWorkflowEntry;
  workflow: WorkflowGraph;
  imageInputs?: PreparedComfyUiImageInput[];
  config: ComfyUiConfig;
  outputPath?: string;
  force: boolean;
  signal?: AbortSignal;
  onProgress?: (stage: 'queued' | 'running' | 'completed', message: string) => void;
}): Promise<ComfyUiScalarRunResult> {
  const { entry, config } = options;
  const { outputId, absoluteOutputPath } = await preflightComfyUiScalarRun({
    ...options,
    config,
    imageInputs: options.imageInputs,
  });

  const clientId = randomUUID();
  const requestedPromptId = randomUUID();
  if (options.signal?.aborted) throw abortError(requestedPromptId);
  await bindPreparedImageInputs(config, options.workflow, entry, options.imageInputs ?? []);
  if (options.signal?.aborted) throw abortError(requestedPromptId);
  const submission = await requestJson(config, '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: options.workflow,
      prompt_id: requestedPromptId,
      client_id: clientId,
    }),
  });
  if (
    !submission ||
    typeof submission !== 'object' ||
    typeof (submission as { prompt_id?: unknown }).prompt_id !== 'string'
  )
    throw new ComfyUiRunError(
      'COMFYUI_PROMPT_REJECTED',
      '/prompt',
      boundedMessage(submission, 'ComfyUI did not return a prompt id.'),
    );
  const promptId = (submission as { prompt_id: string }).prompt_id;
  const onAbort = () => void cancelPrompt(config, promptId);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  options.onProgress?.('queued', `Queued ComfyUI prompt ${promptId}.`);
  try {
    const nodeIds = resolvedComfyUiWorkflowOutputNodeIdList(
      options.workflow,
      entry.definition,
      outputId,
    );
    let descriptors: ImageDescriptor[] = [];
    for (;;) {
      if (options.signal?.aborted) throw abortError(promptId);
      const history = await requestJson(config, `/history/${encodeURIComponent(promptId)}`);
      const failure = historyFailure(history, promptId);
      if (failure) throw failure;
      descriptors = descriptorsForOutput(history, promptId, nodeIds);
      if (descriptors.length > 0) break;
      if (historyCompleted(history, promptId))
        throw new ComfyUiRunError(
          'COMFYUI_OUTPUT_MISSING',
          `/outputs/${outputId}`,
          `ComfyUI completed without required output '${outputId}'.`,
        );
      options.onProgress?.('running', `Waiting for ComfyUI prompt ${promptId}.`);
      await new Promise<void>((resolve) => setTimeout(resolve, HISTORY_POLL_INTERVAL_MS));
    }
    if (descriptors.length !== 1)
      throw new ComfyUiRunError(
        'COMFYUI_OUTPUT_CARDINALITY',
        `/outputs/${outputId}`,
        `Output '${outputId}' produced ${descriptors.length} images; expected exactly one.`,
      );
    const descriptor = descriptors[0]!;
    const params = new URLSearchParams({
      filename: descriptor.filename,
      subfolder: descriptor.subfolder ?? '',
      type: descriptor.type ?? 'output',
    });
    const bytes = await requestBytes(
      config,
      `/view?${params.toString()}`,
      undefined,
      MAX_IMAGE_OUTPUT_BYTES,
    );
    const metadata = imageFormat(bytes);
    const generated: ComfyUiGeneratedImage = {
      outputId,
      ...metadata,
      byteSize: bytes.byteLength,
      contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      bytes,
    };
    let output: ComfyUiScalarRunOutput | ComfyUiPendingRunOutput;
    if (absoluteOutputPath) {
      if (!extensionMatches(absoluteOutputPath, metadata.format))
        throw new ComfyUiRunError(
          'COMFYUI_OUTPUT_EXTENSION',
          `/outputs/${outputId}`,
          `Destination extension does not match returned ${metadata.format} image format.`,
        );
      await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
      const temporaryPath = path.join(
        path.dirname(absoluteOutputPath),
        `.${path.basename(absoluteOutputPath)}.${randomUUID()}.tmp`,
      );
      try {
        await fs.writeFile(temporaryPath, bytes, { flag: 'wx' });
        if (options.force) await fs.rm(absoluteOutputPath, { force: true });
        await fs.rename(temporaryPath, absoluteOutputPath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
      options.onProgress?.('completed', `Wrote ${absoluteOutputPath}.`);
      const { bytes: _bytes, ...published } = generated;
      output = { ...published, target: 'filesystem', path: absoluteOutputPath };
    } else output = { ...generated, target: 'pending' };
    return {
      workflowId: entry.id,
      workflowKey: entry.workflowKey,
      workflowSource: entry.source,
      packageHash: entry.packageHash ?? '',
      serverUrl: normalizeComfyUiServerUrl(config.serverUrl),
      clientId,
      promptId,
      output,
    };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

async function preflightFilesystemRoute(
  outputId: string,
  cardinality: 'one' | 'many',
  routePath: string,
  force: boolean,
): Promise<string> {
  const absolutePath = path.resolve(routePath);
  if (cardinality === 'one') {
    const extension = path.extname(absolutePath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension))
      throw new ComfyUiRunError(
        'COMFYUI_OUTPUT_EXTENSION',
        `/outputs/${outputId}`,
        `Filesystem route for output '${outputId}' must use .png, .jpg, .jpeg, .webp, or .gif.`,
      );
    await validateFilesystemOutputParent(absolutePath, outputId);
    try {
      const stats = await fs.lstat(absolutePath);
      if (stats.isDirectory())
        throw new ComfyUiRunError(
          'COMFYUI_OUTPUT_DESTINATION_INVALID',
          `/outputs/${outputId}`,
          `Cardinality-one output '${outputId}' requires a file destination, not a directory.`,
        );
      if (!force)
        throw new ComfyUiRunError(
          'COMFYUI_OUTPUT_EXISTS',
          `/outputs/${outputId}`,
          `Output destination already exists: ${absolutePath}`,
        );
    } catch (error) {
      if (error instanceof ComfyUiRunError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return absolutePath;
  }

  await validateFilesystemOutputParent(path.join(absolutePath, 'result.png'), outputId);
  try {
    const stats = await fs.lstat(absolutePath);
    if (!stats.isDirectory())
      throw new ComfyUiRunError(
        'COMFYUI_OUTPUT_DESTINATION_INVALID',
        `/outputs/${outputId}`,
        `Cardinality-many output '${outputId}' requires a directory destination.`,
      );
  } catch (error) {
    if (error instanceof ComfyUiRunError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return absolutePath;
}

export async function preflightComfyUiRun(options: {
  entry: ComfyUiRunnableWorkflowEntry;
  filesystemRoutes: ReadonlyMap<string, string>;
  projectAvailable: boolean;
  force: boolean;
  config?: ComfyUiConfig;
  imageInputs?: PreparedComfyUiImageInput[];
}): Promise<ComfyUiRunPlan> {
  if (options.imageInputs?.length) {
    if (!options.config)
      throw new ComfyUiRunError(
        'COMFYUI_UPLOAD_TARGET_DENIED',
        '/server',
        'ComfyUI server configuration is required for local image inputs.',
      );
    validateComfyUiImageUploadTarget(options.config);
  }

  const outputs = options.entry.definition.contract.outputs;
  for (const outputId of options.filesystemRoutes.keys())
    if (!(outputId in outputs))
      throw new ComfyUiRunError(
        'COMFYUI_OUTPUT_UNKNOWN',
        `/outputs/${outputId}`,
        `Workflow does not declare output '${outputId}'.`,
      );

  const routes: Record<string, ComfyUiOutputRoutePlan> = {};
  for (const [outputId, contract] of Object.entries(outputs)) {
    if (contract.mediaType !== 'image')
      throw new ComfyUiRunError(
        'COMFYUI_OUTPUT_UNSUPPORTED',
        `/outputs/${outputId}`,
        `Output '${outputId}' uses unsupported media type '${contract.mediaType}'.`,
      );
    const explicitPath = options.filesystemRoutes.get(outputId);
    if (explicitPath !== undefined) {
      routes[outputId] = {
        outputId,
        target: 'filesystem',
        path: await preflightFilesystemRoute(
          outputId,
          contract.cardinality,
          explicitPath,
          options.force,
        ),
        cardinality: contract.cardinality,
      };
      continue;
    }
    if (!options.projectAvailable)
      throw new ComfyUiRunError(
        'COMFYUI_OUTPUT_ROUTE_REQUIRED',
        `/outputs/${outputId}`,
        `Output '${outputId}' requires an explicit filesystem route when no Project is available.`,
      );
    routes[outputId] = {
      outputId,
      target: 'asset',
      cardinality: contract.cardinality,
    };
  }
  const filesystemRoutes = Object.values(routes).filter(
    (route): route is ComfyUiOutputRoutePlan & { target: 'filesystem'; path: string } =>
      route.target === 'filesystem' && typeof route.path === 'string',
  );
  for (let left = 0; left < filesystemRoutes.length; left += 1)
    for (let right = left + 1; right < filesystemRoutes.length; right += 1) {
      const a = filesystemRoutes[left]!;
      const b = filesystemRoutes[right]!;
      if (a.path === b.path && (a.cardinality === 'one' || b.cardinality === 'one'))
        throw new ComfyUiRunError(
          'COMFYUI_OUTPUT_DESTINATION_CONFLICT',
          '/outputs',
          `Outputs '${a.outputId}' and '${b.outputId}' resolve to the same filesystem destination.`,
        );
    }
  return { routes };
}

function validateOutputCardinality(
  outputId: string,
  count: number,
  required: boolean,
  cardinality: 'one' | 'many',
) {
  const valid =
    cardinality === 'one' ? (required ? count === 1 : count <= 1) : required ? count >= 1 : true;
  if (valid) return;
  const expectation =
    cardinality === 'one'
      ? required
        ? 'exactly one result'
        : 'zero or one result'
      : 'at least one result';
  throw new ComfyUiRunError(
    count === 0 && required ? 'COMFYUI_OUTPUT_MISSING' : 'COMFYUI_OUTPUT_CARDINALITY',
    `/outputs/${outputId}`,
    `Output '${outputId}' produced ${count} results; expected ${expectation}.`,
  );
}

export async function runComfyUiWorkflow(options: {
  entry: ComfyUiRunnableWorkflowEntry;
  workflow: WorkflowGraph;
  imageInputs?: PreparedComfyUiImageInput[];
  config: ComfyUiConfig;
  signal?: AbortSignal;
  promptId?: string;
  clientId?: string;
  onProgress?: (
    stage: 'queued' | 'running' | 'completed',
    message: string,
    details: { promptId: string; clientId: string },
  ) => void;
}): Promise<ComfyUiRunResult> {
  const { entry, config } = options;
  const clientId = options.clientId ?? randomUUID();
  const requestedPromptId = options.promptId ?? randomUUID();
  if (options.signal?.aborted) throw abortError(requestedPromptId);
  await bindPreparedImageInputs(config, options.workflow, entry, options.imageInputs ?? []);
  if (options.signal?.aborted) throw abortError(requestedPromptId);
  const submission = await requestJson(config, '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: options.workflow,
      prompt_id: requestedPromptId,
      client_id: clientId,
    }),
  });
  if (
    !submission ||
    typeof submission !== 'object' ||
    typeof (submission as { prompt_id?: unknown }).prompt_id !== 'string'
  )
    throw new ComfyUiRunError(
      'COMFYUI_PROMPT_REJECTED',
      '/prompt',
      boundedMessage(submission, 'ComfyUI did not return a prompt id.'),
    );
  const promptId = (submission as { prompt_id: string }).prompt_id;
  const onAbort = () => void cancelPrompt(config, promptId);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  options.onProgress?.('queued', `Queued ComfyUI prompt ${promptId}.`, { promptId, clientId });
  try {
    let history: unknown;
    for (;;) {
      if (options.signal?.aborted) throw abortError(promptId);
      history = await requestJson(config, `/history/${encodeURIComponent(promptId)}`);
      const failure = historyFailure(history, promptId);
      if (failure) throw failure;
      if (historyCompleted(history, promptId)) break;
      options.onProgress?.('running', `Waiting for ComfyUI prompt ${promptId}.`, {
        promptId,
        clientId,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, HISTORY_POLL_INTERVAL_MS));
    }

    const descriptorGroups: Record<string, ImageDescriptor[]> = {};
    for (const [outputId, contract] of Object.entries(entry.definition.contract.outputs)) {
      const nodeIds = resolvedComfyUiWorkflowOutputNodeIdList(
        options.workflow,
        entry.definition,
        outputId,
      );
      const descriptors = descriptorsForOutput(history, promptId, nodeIds);
      validateOutputCardinality(
        outputId,
        descriptors.length,
        contract.required,
        contract.cardinality,
      );
      descriptorGroups[outputId] = descriptors;
    }

    const outputs: Record<string, ComfyUiGeneratedImage[]> = {};
    for (const [outputId, descriptors] of Object.entries(descriptorGroups)) {
      const generated: ComfyUiGeneratedImage[] = [];
      for (const descriptor of descriptors) {
        const params = new URLSearchParams({
          filename: descriptor.filename,
          subfolder: descriptor.subfolder ?? '',
          type: descriptor.type ?? 'output',
        });
        const bytes = await requestBytes(
          config,
          `/view?${params.toString()}`,
          undefined,
          MAX_IMAGE_OUTPUT_BYTES,
        );
        const metadata = imageFormat(bytes);
        generated.push({
          outputId,
          ...metadata,
          byteSize: bytes.byteLength,
          contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          bytes,
        });
      }
      outputs[outputId] = generated;
    }
    options.onProgress?.('completed', `Downloaded and validated ComfyUI prompt ${promptId}.`, {
      promptId,
      clientId,
    });
    return {
      workflowId: entry.id,
      workflowKey: entry.workflowKey,
      workflowSource: entry.source,
      packageHash: entry.packageHash ?? '',
      serverUrl: normalizeComfyUiServerUrl(config.serverUrl),
      clientId,
      promptId,
      outputs,
    };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}
