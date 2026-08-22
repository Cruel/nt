import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
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

export interface ComfyUiScalarRunOutput {
  outputId: string;
  target: 'filesystem';
  path: string;
  format: 'png' | 'jpeg' | 'webp' | 'gif';
  mimeType: string;
  byteSize: number;
  contentHash: `sha256:${string}`;
  width: number;
  height: number;
}

export interface ComfyUiScalarRunResult {
  workflowId: string;
  workflowKey: string;
  workflowSource: string;
  packageHash: string;
  serverUrl: string;
  clientId: string;
  promptId: string;
  output: ComfyUiScalarRunOutput;
}

export class ComfyUiRunError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
    readonly interrupted = false,
  ) {
    super(message);
    this.name = 'ComfyUiRunError';
  }
}

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
  if (input.type === 'image')
    throw new ComfyUiRunError(
      'COMFYUI_INPUT_UNSUPPORTED',
      `/inputs/${id}`,
      `Input '${id}' requires image-file support from a later execution slice.`,
    );
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

export function prepareComfyUiScalarWorkflow(
  entry: ComfyUiRunnableWorkflowEntry,
  suppliedInputs: ReadonlyMap<string, string>,
) {
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
  for (const [id, input] of Object.entries(entry.definition.contract.inputs)) {
    const supplied = suppliedInputs.get(id);
    let value: unknown;
    if (supplied !== undefined) value = coerceScalarInput(id, input, supplied);
    else if (input.defaultValue !== undefined) value = input.defaultValue;
    else if (input.required)
      throw new ComfyUiRunError(
        'COMFYUI_INPUT_REQUIRED',
        `/inputs/${id}`,
        `Required workflow input '${id}' was not supplied.`,
      );
    else continue;
    for (const binding of entry.definition.bindings[id] ?? []) setBinding(workflow, binding, value);
  }
  return workflow;
}

function imageFormat(bytes: Uint8Array): {
  format: ComfyUiScalarRunOutput['format'];
  mimeType: string;
  width: number;
  height: number;
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
      } else if (type === 'IEND' && length === 0) {
        sawEnd = true;
        break;
      }
      offset = chunkEnd;
    }
    if (width && height && sawImageData && sawEnd)
      return { format: 'png', mimeType: 'image/png', width, height };
  }
  if (
    bytes.byteLength >= 10 &&
    (String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a' ||
      String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a')
  ) {
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    if (width && height) return { format: 'gif', mimeType: 'image/gif', width, height };
  }
  if (
    bytes.byteLength >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return { format: 'webp', mimeType: 'image/webp', width: 1, height: 1 };
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
        if (width && height) return { format: 'jpeg', mimeType: 'image/jpeg', width, height };
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

function extensionMatches(outputPath: string, format: ComfyUiScalarRunOutput['format']) {
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
  outputPath: string;
  force: boolean;
}) {
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
  config: ComfyUiConfig;
  outputPath: string;
  force: boolean;
  signal?: AbortSignal;
  onProgress?: (stage: 'queued' | 'running' | 'completed', message: string) => void;
}): Promise<ComfyUiScalarRunResult> {
  const { entry, config } = options;
  const { outputId, absoluteOutputPath } = await preflightComfyUiScalarRun(options);

  const clientId = randomUUID();
  const requestedPromptId = randomUUID();
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
    return {
      workflowId: entry.id,
      workflowKey: entry.workflowKey,
      workflowSource: entry.source,
      packageHash: entry.packageHash ?? '',
      serverUrl: normalizeComfyUiServerUrl(config.serverUrl),
      clientId,
      promptId,
      output: {
        outputId,
        target: 'filesystem',
        path: absoluteOutputPath,
        ...metadata,
        byteSize: bytes.byteLength,
        contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
    };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}
