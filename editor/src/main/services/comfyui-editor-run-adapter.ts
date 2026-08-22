import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImportedAssetMetadata } from '../../shared/asset-import';
import {
  comfyUiServerIdentity,
  type ComfyUiConfig,
  type ComfyUiQueueProgress,
} from '../../shared/comfyui';
import type {
  ComfyUiEditImageRequest,
  ComfyUiGenerateImageRequest,
  ComfyUiGeneratedAsset,
  ComfyUiImageJobResponse,
} from '../../shared/comfyui-generation';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { PROJECT_TRUST_FAILURE } from '../../shared/project-trust-boundary';
import { getComfyUiWorkflowExecutionSupport } from '../../shared/comfyui-workflows';
import {
  createNodeProjectWorkspaceFileSystem,
  createNodeProjectWorkspaceService,
} from '../../shared/project-workspace';
import { publishComfyUiOutputs } from './comfyui-asset-publication-service';
import {
  listComfyUiWorkflowLibrary,
  verifyComfyUiWorkflowLibrary,
} from './comfyui-workflow-library-service';
import {
  preflightComfyUiRun,
  prepareComfyUiWorkflow,
  runComfyUiWorkflow,
  type ComfyUiRunnableWorkflowEntry,
} from './comfyui-run-service';

interface ComfyUiProgressOwner {
  webContents: { send(channel: string, payload: unknown): void };
}
interface SourceImage {
  bytes: Uint8Array;
  mimeType: string;
}
const activeRuns = new Map<string, AbortController>();

function generatedSeed(seed: number | undefined) {
  if (seed !== undefined && seed >= 0 && Number.isFinite(seed)) return Math.trunc(seed);
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

function safeStem(value: string) {
  const stem = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return stem || 'comfyui';
}

function generatedPath(projectRoot: string, workflowId: string, outputId: string, many: boolean) {
  const identity = `${safeStem(workflowId)}-${safeStem(outputId)}-${randomUUID().slice(0, 8)}`;
  return many
    ? path.join(projectRoot, 'assets', 'generated', identity)
    : path.join(projectRoot, 'assets', 'generated', `${identity}.png`);
}

function setInput(
  values: Map<string, string>,
  entry: ComfyUiRunnableWorkflowEntry,
  id: string,
  value: string | number | boolean | undefined,
  fallback?: string | number | boolean,
) {
  const input = entry.definition.contract.inputs[id];
  if (!input) return;
  const selected = value ?? (input.defaultValue === undefined ? fallback : undefined);
  if (selected !== undefined) values.set(id, String(selected));
}

async function resolveEditorWorkflow(
  projectFilePath: string,
  config: ComfyUiConfig,
  request: Pick<
    ComfyUiGenerateImageRequest | ComfyUiEditImageRequest,
    'workflowId' | 'workflowKey'
  >,
  classification: 'image.generate' | 'image.edit',
): Promise<ComfyUiRunnableWorkflowEntry> {
  const library = await listComfyUiWorkflowLibrary({
    projectFilePath,
    includeOverridden: true,
    serverIdentity: comfyUiServerIdentity(config.serverUrl),
    comfyUiVersion: 'unknown',
  });
  const defaultId = config.defaultWorkflows[classification];
  const entry = request.workflowKey
    ? library.entries.find((candidate) => candidate.workflowKey === request.workflowKey)
    : library.entries.find(
        (candidate) => candidate.active && candidate.id === (request.workflowId ?? defaultId),
      );
  const requested = request.workflowKey ?? request.workflowId ?? defaultId ?? classification;
  if (!entry || !entry.active || entry.overridden || !entry.id || !entry.label || !entry.definition)
    throw new Error(`ComfyUI workflow '${requested}' is unavailable or not runnable.`);
  if (!entry.runnable) {
    const support = getComfyUiWorkflowExecutionSupport(entry.definition);
    if (support.unsupportedOutputMediaTypes.length)
      throw new Error(
        `Workflow '${entry.id}' uses unsupported output media: ${support.unsupportedOutputMediaTypes.join(', ')}.`,
      );
    throw new Error(`ComfyUI workflow '${entry.id}' is unavailable or not runnable.`);
  }
  if (!entry.workflowJsonText || !entry.packageHash)
    throw new Error(`ComfyUI workflow '${entry.id}' is unavailable or not runnable.`);
  if (entry.classification !== classification)
    throw new Error(`Workflow '${entry.id}' is not an ${classification} workflow.`);
  if (
    Object.values(entry.definition.contract.outputs).some((output) => output.mediaType !== 'image')
  )
    throw new Error(
      `Workflow '${entry.id}' contains non-image outputs and is not runnable in this image editor.`,
    );
  const verification = await verifyComfyUiWorkflowLibrary({
    projectFilePath,
    config,
    workflowId: entry.id,
    force: true,
  });
  if (!verification.success)
    throw new Error(
      verification.diagnostics[0]?.message ?? `ComfyUI workflow '${entry.id}' verification failed.`,
    );
  if (
    !verification.verified.some(
      (record) =>
        record.workflowKey === entry.workflowKey && record.packageHash === entry.packageHash,
    )
  )
    throw new Error(
      `ComfyUI workflow '${entry.id}' changed while the editor invocation was prepared.`,
    );
  return entry as ComfyUiRunnableWorkflowEntry;
}

function emitProgress(
  owner: ComfyUiProgressOwner | null,
  details: {
    projectSessionId?: string;
    workflowId: string;
    workflowLabel: string;
    classification: 'image.generate' | 'image.edit';
    prompt: string;
    createdAt: string;
  },
  progress: Partial<ComfyUiQueueProgress> &
    Pick<ComfyUiQueueProgress, 'promptId' | 'state' | 'message'>,
) {
  owner?.webContents.send(IPC_CHANNELS.COMFYUI_PROGRESS_EVENT, {
    projectSessionId: details.projectSessionId,
    workflowId: details.workflowId,
    workflowLabel: details.workflowLabel,
    classification: details.classification,
    mode: details.classification === 'image.generate' ? 'generate' : 'edit',
    promptSummary: details.prompt.trim().slice(0, 120) || '(empty prompt)',
    createdAt: details.createdAt,
    queueRemaining: null,
    currentNode: null,
    progressValue: null,
    progressMax: null,
    updatedAt: new Date().toISOString(),
    ...progress,
  });
}

function importedMetadata(
  projectRoot: string,
  absolutePath: string,
  published: {
    mimeType: string;
    byteSize: number;
    contentHash: `sha256:${string}`;
    width: number;
    height: number;
    hasAlpha: boolean;
  },
  workflowId: string,
  promptId: string,
): ImportedAssetMetadata {
  const extension = path.extname(absolutePath).toLowerCase();
  return {
    originalPath: `comfyui:${workflowId}:${promptId}`,
    originalName: path.basename(absolutePath),
    projectRelativePath: path.relative(projectRoot, absolutePath).split(path.sep).join('/'),
    kind: 'image',
    extension,
    mimeType: published.mimeType,
    byteSize: published.byteSize,
    contentHash: published.contentHash,
    importedAt: new Date().toISOString(),
    imageMetadata: {
      width: published.width,
      height: published.height,
      hasAlpha: published.hasAlpha,
      orientation: 1,
    },
  };
}

async function executeEditorImageRun(options: {
  owner: ComfyUiProgressOwner | null;
  config: ComfyUiConfig;
  projectFilePath: string;
  request: ComfyUiGenerateImageRequest | ComfyUiEditImageRequest;
  classification: 'image.generate' | 'image.edit';
  isAuthorityCurrent: () => boolean;
  projectSessionId?: string;
  readSourceImage?: () => Promise<SourceImage>;
}): Promise<ComfyUiImageJobResponse> {
  if (!options.config.enabled)
    return {
      ok: false,
      success: false,
      assets: [],
      diagnostics: [],
      error: 'ComfyUI is disabled.',
    };
  if (!options.projectFilePath)
    return {
      ok: false,
      success: false,
      assets: [],
      diagnostics: [],
      error: 'Save the project before using ComfyUI image workflows.',
    };
  if (!options.isAuthorityCurrent())
    return {
      ok: false,
      success: false,
      assets: [],
      diagnostics: [],
      error: 'Project session is stale or unknown.',
      failureCode: PROJECT_TRUST_FAILURE.STALE_PROJECT_SESSION,
    };

  const controller = new AbortController();
  if (options.projectSessionId) {
    activeRuns.get(options.projectSessionId)?.abort();
    activeRuns.set(options.projectSessionId, controller);
  }
  const promptIdentity = options.request.clientJobId ?? randomUUID();
  const createdAt = new Date().toISOString();
  let temporaryRoot: string | null = null;
  try {
    const entry = await resolveEditorWorkflow(
      options.projectFilePath,
      options.config,
      options.request,
      options.classification,
    );
    if (!options.isAuthorityCurrent()) throw new Error('Project session is stale or unknown.');
    const seed = generatedSeed(options.request.seed);
    const inputs = new Map<string, string>();
    setInput(inputs, entry, 'prompt', options.request.prompt);
    setInput(inputs, entry, 'negativePrompt', options.request.negativePrompt, '');
    setInput(
      inputs,
      entry,
      'steps',
      options.request.steps,
      options.classification === 'image.generate' ? 20 : 4,
    );
    setInput(inputs, entry, 'cfg', options.request.cfg);
    setInput(inputs, entry, 'seed', seed);
    if (options.classification === 'image.generate') {
      const request = options.request as ComfyUiGenerateImageRequest;
      setInput(inputs, entry, 'width', request.width, 1024);
      setInput(inputs, entry, 'height', request.height, 1024);
    } else {
      if (!options.readSourceImage) throw new Error('Edit workflow source image is unavailable.');
      const source = await options.readSourceImage();
      if (!options.isAuthorityCurrent()) throw new Error('Project session is stale or unknown.');
      temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noveltea-comfyui-edit-'));
      const extension =
        source.mimeType === 'image/jpeg'
          ? '.jpg'
          : source.mimeType === 'image/webp'
            ? '.webp'
            : source.mimeType === 'image/gif'
              ? '.gif'
              : '.png';
      const sourcePath = path.join(temporaryRoot, `source${extension}`);
      await fs.writeFile(sourcePath, source.bytes);
      setInput(inputs, entry, 'sourceImage', sourcePath);
    }

    const prepared = await prepareComfyUiWorkflow(
      entry,
      inputs,
      path.dirname(options.projectFilePath),
    );
    const projectRoot = path.dirname(options.projectFilePath);
    const filesystemRoutes = new Map<string, string>();
    for (const [outputId, output] of Object.entries(entry.definition.contract.outputs))
      filesystemRoutes.set(
        outputId,
        generatedPath(projectRoot, entry.id, outputId, output.cardinality === 'many'),
      );
    const plan = await preflightComfyUiRun({
      entry,
      filesystemRoutes,
      projectAvailable: true,
      force: false,
      config: options.config,
      imageInputs: prepared.imageInputs,
    });
    if (!options.isAuthorityCurrent()) throw new Error('Project session is stale or unknown.');

    const progressDetails = {
      projectSessionId: options.projectSessionId,
      workflowId: entry.id,
      workflowLabel: entry.label,
      classification: options.classification,
      prompt: options.request.prompt,
      createdAt,
    };
    const remote = await runComfyUiWorkflow({
      entry,
      workflow: prepared.workflow,
      imageInputs: prepared.imageInputs,
      config: options.config,
      signal: controller.signal,
      promptId: promptIdentity,
      onProgress: (stage, message, details) => {
        if (!options.isAuthorityCurrent()) {
          controller.abort();
          return;
        }
        if (stage === 'completed') return;
        emitProgress(options.owner, progressDetails, {
          promptId: details.promptId,
          state: stage,
          message: stage === 'queued' ? 'Queued generation' : message,
        });
      },
    });
    if (!options.isAuthorityCurrent()) {
      controller.abort();
      throw new Error('Project session is stale or unknown.');
    }

    const workspace = createNodeProjectWorkspaceService();
    const fileSystem = createNodeProjectWorkspaceFileSystem();
    const published = await publishComfyUiOutputs({
      projectRoot,
      workspace,
      fileSystem,
      workflow: entry,
      promptId: remote.promptId,
      plan,
      outputs: remote.outputs,
      force: false,
    });
    if (!options.isAuthorityCurrent()) throw new Error('Project session is stale or unknown.');

    const assets: ComfyUiGeneratedAsset[] = [];
    for (const values of Object.values(published)) {
      for (const value of values) {
        if (value.target !== 'filesystem') continue;
        const bytes = await fs.readFile(value.path);
        const asset = importedMetadata(projectRoot, value.path, value, entry.id, remote.promptId);
        assets.push({
          asset,
          previewUrl: `data:${value.mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
          absolutePath: value.path,
          projectRelativePath: asset.projectRelativePath,
          promptId: remote.promptId,
          workflowId: entry.id,
          seed,
          prompt: options.request.prompt,
          createdAt: new Date().toISOString(),
        });
      }
    }
    emitProgress(options.owner, progressDetails, {
      promptId: remote.promptId,
      state: 'completed',
      message: `Generated ${assets.length} image${assets.length === 1 ? '' : 's'}`,
    });
    return { ok: true, success: true, promptId: remote.promptId, assets, diagnostics: [] };
  } catch (error) {
    const stale = !options.isAuthorityCurrent();
    const message = stale
      ? 'Project session is stale or unknown.'
      : error instanceof Error
        ? error.message
        : 'ComfyUI image job failed.';
    if (!stale)
      emitProgress(
        options.owner,
        {
          projectSessionId: options.projectSessionId,
          workflowId: options.request.workflowId ?? 'unknown',
          workflowLabel: options.request.workflowId ?? 'ComfyUI workflow',
          classification: options.classification,
          prompt: options.request.prompt,
          createdAt,
        },
        { promptId: promptIdentity, state: 'error', message },
      );
    return {
      ok: false,
      success: false,
      promptId: promptIdentity,
      assets: [],
      diagnostics: [{ severity: 'error', category: 'comfyui', path: '/', message }],
      error: message,
      ...(stale ? { failureCode: PROJECT_TRUST_FAILURE.STALE_PROJECT_SESSION } : {}),
    };
  } finally {
    if (options.projectSessionId && activeRuns.get(options.projectSessionId) === controller)
      activeRuns.delete(options.projectSessionId);
    if (temporaryRoot)
      await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function generateComfyUiImageThroughSharedCore(options: {
  owner: ComfyUiProgressOwner | null;
  config: ComfyUiConfig;
  request: ComfyUiGenerateImageRequest;
  isAuthorityCurrent: () => boolean;
  projectSessionId?: string;
}) {
  return executeEditorImageRun({
    ...options,
    projectFilePath: options.request.projectFilePath,
    classification: 'image.generate',
  });
}

export function editComfyUiImageThroughSharedCore(options: {
  owner: ComfyUiProgressOwner | null;
  config: ComfyUiConfig;
  request: ComfyUiEditImageRequest;
  projectFilePath: string;
  isAuthorityCurrent: () => boolean;
  projectSessionId: string;
  readSourceImage: () => Promise<SourceImage>;
}) {
  return executeEditorImageRun({ ...options, classification: 'image.edit' });
}

export async function cancelEditorComfyUiRun(
  projectSessionId: string,
): Promise<{ ok: boolean; success: boolean; error?: string }> {
  const controller = activeRuns.get(projectSessionId);
  if (!controller) return { ok: false, success: false, error: 'No active ComfyUI job.' };
  controller.abort();
  return { ok: true, success: true };
}
