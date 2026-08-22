import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ComfyUiConfig, ComfyUiQueueProgress, ComfyUiStatus } from '../../shared/comfyui';
import { COMFYUI_IPC_LIMITS, normalizeComfyUiServerUrl } from '../../shared/comfyui';
import type {
  ComfyUiCancelJobResponse,
  ComfyUiEditImageRequest,
  ComfyUiGenerateImageRequest,
  ComfyUiImageJobResponse,
} from '../../shared/comfyui-generation';
import {
  BUILTIN_COMFYUI_WORKFLOW_MANIFESTS,
  parseComfyUiWorkflowDefinition,
  resolveComfyUiWorkflowBinding,
  resolvedComfyUiWorkflowOutputNodeIdList,
  validateComfyUiWorkflowDefinitionContract,
  type ComfyUiInstallStarterWorkflowsResponse,
  type ComfyUiWorkflowDefinition,
  type ComfyUiWorkflowDiagnostic,
  type ComfyUiWorkflowListEntry,
  type ComfyUiWorkflowListResponse,
} from '../../shared/comfyui-workflows';
import { projectOriginalAssetBoundaryCode } from '../../shared/project-original-asset';
import {
  PROJECT_TRUST_FAILURE,
  type ProjectTrustFailureCode,
} from '../../shared/project-trust-boundary';
import type { ActiveProjectSessionService } from './active-project-session-service';
import { resolveContainedOriginalAsset } from './project-original-asset-service';
import {
  cancelEditorComfyUiRun,
  editComfyUiImageThroughSharedCore,
  generateComfyUiImageThroughSharedCore,
} from './comfyui-editor-run-adapter';

interface WorkflowNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
}

interface ComfyUiProgressOwner {
  webContents: {
    send(channel: string, payload: unknown): void;
  };
}

type WorkflowGraph = Record<string, WorkflowNode>;

function checkedAt() {
  return new Date().toISOString();
}

function disabledStatus(config: ComfyUiConfig): ComfyUiStatus {
  return {
    state: 'disabled',
    serverUrl: normalizeComfyUiServerUrl(config.serverUrl),
    checkedAt: checkedAt(),
    message: 'ComfyUI disabled',
    queueRemaining: null,
  };
}

function errorStatus(config: ComfyUiConfig, message: string): ComfyUiStatus {
  return {
    state: 'error',
    serverUrl: config.serverUrl ? normalizeComfyUiServerUrl(config.serverUrl) : null,
    checkedAt: checkedAt(),
    message,
    queueRemaining: null,
  };
}

function normalizeUrl(config: ComfyUiConfig, urlPath: string): URL | string {
  try {
    const base = normalizeComfyUiServerUrl(config.serverUrl);
    const url = new URL(base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return 'ComfyUI server URL must use http or https.';
    const normalizedPath = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
    return new URL(
      normalizedPath,
      `${url.origin}${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}`,
    );
  } catch {
    return 'ComfyUI server URL is invalid.';
  }
}

function stringifyComfyUiError(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return value.toString();
  if (typeof value === 'symbol')
    return value.description ?? 'ComfyUI returned an anonymous symbol.';
  if (typeof value === 'undefined') return null;
  const record = value as Record<string, unknown>;
  const directMessage = record.message ?? record.error ?? record.exception_message;
  if (typeof directMessage === 'string' && directMessage.trim()) return directMessage;
  const details = [
    record.type,
    record.node_id,
    record.class_type,
    record.exception_type,
    record.exception_message,
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (details.length) return details.join(' • ');
  try {
    return JSON.stringify(value) ?? 'ComfyUI returned an empty error object.';
  } catch {
    return 'ComfyUI returned an unreadable error object.';
  }
}

async function fetchJson(
  config: ComfyUiConfig,
  urlPath: string,
  init?: RequestInit,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const url = normalizeUrl(config, urlPath);
  if (typeof url === 'string') return { ok: false, error: url };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let value: unknown = null;
    if (text.trim()) {
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
    if (!response.ok) {
      const detail = stringifyComfyUiError(value);
      return {
        ok: false,
        error: detail
          ? `ComfyUI returned HTTP ${response.status} for ${urlPath}: ${detail}`
          : `ComfyUI returned HTTP ${response.status} for ${urlPath}.`,
      };
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      return { ok: false, error: 'ComfyUI connection timed out.' };
    return { ok: false, error: error instanceof Error ? error.message : 'ComfyUI request failed.' };
  } finally {
    clearTimeout(timeout);
  }
}

function queueRemainingFromValue(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const queue = value as { queue_running?: unknown; queue_pending?: unknown };
  const running = Array.isArray(queue.queue_running) ? queue.queue_running.length : 0;
  const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending.length : 0;
  return running + pending;
}

function findComfyUiVersion(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['comfyui_version', 'comfyuiVersion', 'version']) {
    const next = record[key];
    if (typeof next === 'string' && next.trim()) return next.trim();
  }
  for (const next of Object.values(record)) {
    const found = findComfyUiVersion(next);
    if (found) return found;
  }
  return null;
}

export async function checkComfyUiConnection(config: ComfyUiConfig): Promise<ComfyUiStatus> {
  if (!config.enabled) return disabledStatus(config);
  const stats = await fetchJson(config, '/system_stats');
  if (!stats.ok) return errorStatus(config, stats.error);
  const queue = await fetchJson(config, '/queue');
  const comfyUiVersion = findComfyUiVersion(stats.value) ?? 'unknown';
  return {
    state: 'ready',
    serverUrl: normalizeComfyUiServerUrl(config.serverUrl),
    checkedAt: checkedAt(),
    message: 'ComfyUI ready',
    queueRemaining: queue.ok ? queueRemainingFromValue(queue.value) : null,
    systemStats: stats.value,
    comfyUiVersion,
  };
}

export async function getComfyUiQueue(config: ComfyUiConfig): Promise<ComfyUiQueueProgress> {
  if (!config.enabled)
    return {
      promptId: null,
      workflowId: null,
      state: 'idle',
      queueRemaining: null,
      currentNode: null,
      progressValue: null,
      progressMax: null,
      message: 'ComfyUI disabled',
    };
  const queue = await fetchJson(config, '/queue');
  if (!queue.ok)
    return {
      promptId: null,
      workflowId: null,
      state: 'error',
      queueRemaining: null,
      currentNode: null,
      progressValue: null,
      progressMax: null,
      message: queue.error,
    };
  const queueRemaining = queueRemainingFromValue(queue.value);
  return {
    promptId: null,
    workflowId: null,
    state: queueRemaining && queueRemaining > 0 ? 'queued' : 'idle',
    queueRemaining,
    currentNode: null,
    progressValue: null,
    progressMax: null,
    message:
      queueRemaining && queueRemaining > 0
        ? `${queueRemaining} queued/running`
        : 'ComfyUI queue idle',
  };
}

function bundledWorkflowsRoot() {
  return path.resolve(process.cwd(), 'assets', 'comfyui', 'workflows');
}

function projectRootFromFile(projectFilePath: string) {
  return path.dirname(path.resolve(projectFilePath));
}

function projectWorkflowsRoot(projectFilePath: string) {
  return path.join(projectRootFromFile(projectFilePath), 'workflows');
}

function diagnostic(
  pathValue: string,
  message: string,
  severity: ComfyUiWorkflowDiagnostic['severity'] = 'error',
): ComfyUiWorkflowDiagnostic {
  return { severity, category: 'comfyui-workflows', path: pathValue, message };
}

function entryStatus(diagnostics: ComfyUiWorkflowDiagnostic[]): ComfyUiWorkflowListEntry['status'] {
  if (diagnostics.some((item) => item.severity === 'error')) return 'invalid';
  if (diagnostics.some((item) => item.severity === 'warning' || item.severity === 'info'))
    return 'warning';
  return 'valid';
}

async function copyStarterFile(source: string, destination: string): Promise<'copied' | 'skipped'> {
  try {
    await fs.access(destination);
    return 'skipped';
  } catch {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    return 'copied';
  }
}

export async function installProjectComfyUiStarterWorkflows(
  projectFilePath: string,
): Promise<ComfyUiInstallStarterWorkflowsResponse> {
  if (!projectFilePath)
    return {
      ok: false,
      success: false,
      copied: [],
      skipped: [],
      diagnostics: [
        diagnostic('/workflows', 'Save the project before installing starter workflows.'),
      ],
      error: 'Project file path is required.',
    };
  const diagnostics: ComfyUiWorkflowDiagnostic[] = [];
  const copied: string[] = [];
  const skipped: string[] = [];
  const projectRoot = projectWorkflowsRoot(projectFilePath);
  const bundledRoot = bundledWorkflowsRoot();
  await fs.mkdir(projectRoot, { recursive: true });
  for (const manifestFile of BUILTIN_COMFYUI_WORKFLOW_MANIFESTS) {
    try {
      const manifestSource = path.join(bundledRoot, manifestFile);
      const manifestText = await fs.readFile(manifestSource, 'utf8');
      const definition = parseComfyUiWorkflowDefinition(JSON.parse(manifestText), manifestFile);
      const manifestResult = await copyStarterFile(
        manifestSource,
        path.join(projectRoot, manifestFile),
      );
      (manifestResult === 'copied' ? copied : skipped).push(manifestFile);
      const workflowResult = await copyStarterFile(
        path.join(bundledRoot, definition.workflowFile),
        path.join(projectRoot, definition.workflowFile),
      );
      (workflowResult === 'copied' ? copied : skipped).push(definition.workflowFile);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          `/workflows/${manifestFile}`,
          error instanceof Error ? error.message : 'Failed to install starter workflow.',
        ),
      );
    }
  }
  return {
    ok: !diagnostics.some((item) => item.severity === 'error'),
    success: true,
    copied,
    skipped,
    diagnostics,
  };
}

async function readManifestFiles(projectFilePath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(projectWorkflowsRoot(projectFilePath));
    return entries.filter((entry) => entry.endsWith('.manifest.json')).sort();
  } catch {
    return [];
  }
}

export async function loadComfyUiWorkflowTemplate(
  projectFilePath: string,
  definition: ComfyUiWorkflowDefinition,
): Promise<WorkflowGraph> {
  const text = await fs.readFile(
    path.join(projectWorkflowsRoot(projectFilePath), definition.workflowFile),
    'utf8',
  );
  return JSON.parse(text) as WorkflowGraph;
}

function validateWorkflowBindings(
  workflow: WorkflowGraph,
  definition: ComfyUiWorkflowDefinition,
): ComfyUiWorkflowDiagnostic[] {
  const diagnostics: ComfyUiWorkflowDiagnostic[] = [
    ...validateComfyUiWorkflowDefinitionContract(definition),
  ];
  for (const [publicInputId, bindings] of Object.entries(definition.bindings)) {
    for (const [index, binding] of bindings.entries()) {
      const resolution = resolveComfyUiWorkflowBinding(workflow, binding);
      if (!resolution.ok) {
        diagnostics.push(
          diagnostic(
            `/workflows/${definition.manifestFile ?? definition.id}/bindings/${publicInputId}/${index}`,
            resolution.message ?? `Workflow '${definition.label}' has an unresolved binding.`,
          ),
        );
        continue;
      }
      if (resolution.rebased && binding.nodeId && resolution.nodeId) {
        diagnostics.push(
          diagnostic(
            `/workflows/${definition.manifestFile ?? definition.id}/bindings/${publicInputId}/${index}`,
            `Rebased stale node id ${binding.nodeId} to node ${resolution.nodeId} using selector metadata.`,
            'info',
          ),
        );
      }
    }
  }
  for (const outputId of Object.keys(definition.contract.outputs)) {
    try {
      resolvedComfyUiWorkflowOutputNodeIdList(workflow, definition, outputId);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          `/workflows/${definition.manifestFile ?? definition.id}/outputBindings/${outputId}`,
          error instanceof Error
            ? error.message
            : 'Workflow output bindings could not be resolved.',
        ),
      );
    }
  }
  return diagnostics;
}

async function validateProjectWorkflowDefinition(
  projectFilePath: string,
  definition: ComfyUiWorkflowDefinition,
): Promise<ComfyUiWorkflowDiagnostic[]> {
  const diagnostics: ComfyUiWorkflowDiagnostic[] = [];
  const manifestPath = `/workflows/${definition.manifestFile ?? definition.id}`;
  try {
    const workflowPath = path.join(projectWorkflowsRoot(projectFilePath), definition.workflowFile);
    const relative = path.relative(projectWorkflowsRoot(projectFilePath), workflowPath);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Workflow file escapes the workflows directory.');
    const workflow = await loadComfyUiWorkflowTemplate(projectFilePath, definition);
    diagnostics.push(...validateWorkflowBindings(workflow, definition));
  } catch (error) {
    diagnostics.push(
      diagnostic(
        manifestPath,
        error instanceof Error ? error.message : 'Workflow template is invalid.',
      ),
    );
  }
  return diagnostics;
}

export async function listComfyUiWorkflows(
  projectFilePath: string,
): Promise<ComfyUiWorkflowListResponse> {
  if (!projectFilePath)
    return {
      ok: false,
      success: false,
      workflows: [],
      entries: [],
      diagnostics: [diagnostic('/workflows', 'Save the project before using ComfyUI workflows.')],
      error: 'Project file path is required.',
    };
  const diagnostics: ComfyUiWorkflowDiagnostic[] = [];
  const workflows: ComfyUiWorkflowDefinition[] = [];
  const entries: ComfyUiWorkflowListEntry[] = [];
  for (const manifestFile of await readManifestFiles(projectFilePath)) {
    const manifestPath = path.join(projectWorkflowsRoot(projectFilePath), manifestFile);
    let manifestJsonText: string | undefined;
    try {
      manifestJsonText = await fs.readFile(manifestPath, 'utf8');
      const definition = parseComfyUiWorkflowDefinition(JSON.parse(manifestJsonText), manifestFile);
      let workflowJsonText: string | undefined;
      try {
        workflowJsonText = await fs.readFile(
          path.join(projectWorkflowsRoot(projectFilePath), definition.workflowFile),
          'utf8',
        );
      } catch {
        // Missing workflow files are represented by validation diagnostics below.
      }
      const definitionDiagnostics = await validateProjectWorkflowDefinition(
        projectFilePath,
        definition,
      );
      const status = entryStatus(definitionDiagnostics);
      entries.push({
        manifestFile,
        workflowFile: definition.workflowFile,
        definition,
        id: definition.id,
        label: definition.label,
        classification: definition.classification,
        status,
        repairable: Boolean(workflowJsonText),
        diagnostics: definitionDiagnostics,
        manifestJsonText,
        workflowJsonText,
      });
      diagnostics.push(...definitionDiagnostics);
      if (status !== 'invalid') workflows.push(definition);
    } catch (error) {
      const entryDiagnostics = [
        diagnostic(
          `/workflows/${manifestFile}`,
          error instanceof Error ? error.message : 'Workflow manifest is invalid.',
        ),
      ];
      entries.push({
        manifestFile,
        status: 'invalid',
        repairable: false,
        diagnostics: entryDiagnostics,
        manifestJsonText,
      });
      diagnostics.push(...entryDiagnostics);
    }
  }
  return {
    ok: !diagnostics.some((item) => item.severity === 'error'),
    success: true,
    workflows,
    entries,
    diagnostics,
  };
}

export async function validateProjectComfyUiWorkflows(
  projectFilePath: string,
): Promise<ComfyUiWorkflowDiagnostic[]> {
  return (await listComfyUiWorkflows(projectFilePath)).diagnostics;
}

class ComfyUiBoundaryFailure extends Error {
  constructor(
    readonly code: ProjectTrustFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'ComfyUiBoundaryFailure';
  }
}

export async function readBoundedComfyUiSourceImage(
  sessions: ActiveProjectSessionService,
  projectSessionId: string,
  sourceAssetId: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const resolved = await resolveContainedOriginalAsset(sessions, projectSessionId, sourceAssetId, {
    maxBytes: COMFYUI_IPC_LIMITS.sourceUploadBytes,
    requireKind: 'image',
  });
  if (typeof resolved === 'string') {
    const boundaryCode = projectOriginalAssetBoundaryCode(resolved);
    throw new ComfyUiBoundaryFailure(
      boundaryCode === 'invalid-request' ? PROJECT_TRUST_FAILURE.UNAUTHORIZED_ASSET : boundaryCode,
      `ComfyUI source image rejected: ${resolved}.`,
    );
  }
  const bytes = Buffer.allocUnsafe(resolved.size);
  const hash = createHash('sha256');
  let total = 0;
  try {
    while (total < resolved.size) {
      const read = await resolved.handle.read(bytes, total, resolved.size - total, total);
      if (read.bytesRead === 0) break;
      hash.update(bytes.subarray(total, total + read.bytesRead));
      total += read.bytesRead;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    const extra = await resolved.handle.read(growthProbe, 0, 1, resolved.size);
    if (total !== resolved.size || extra.bytesRead !== 0)
      throw new ComfyUiBoundaryFailure(
        PROJECT_TRUST_FAILURE.SOURCE_REVISION_MISMATCH,
        'ComfyUI source image changed while buffering.',
      );
    if (`sha256:${hash.digest('hex')}` !== resolved.contentHash)
      throw new ComfyUiBoundaryFailure(
        PROJECT_TRUST_FAILURE.SOURCE_REVISION_MISMATCH,
        'ComfyUI source image revision changed while buffering.',
      );
    if (!sessions.isCurrent(projectSessionId))
      throw new ComfyUiBoundaryFailure(
        PROJECT_TRUST_FAILURE.STALE_PROJECT_SESSION,
        'Project session is stale or unknown.',
      );
    return { bytes, mimeType: resolved.mimeType };
  } finally {
    await resolved.handle.close().catch(() => undefined);
  }
}

export async function generateComfyUiImage(
  owner: ComfyUiProgressOwner | null,
  config: ComfyUiConfig,
  request: ComfyUiGenerateImageRequest,
  isAuthorityCurrent: () => boolean = () => true,
  projectSessionId?: string,
): Promise<ComfyUiImageJobResponse> {
  return generateComfyUiImageThroughSharedCore({
    owner,
    config,
    request,
    isAuthorityCurrent,
    projectSessionId,
  });
}

export async function editComfyUiImage(
  owner: ComfyUiProgressOwner | null,
  sessions: ActiveProjectSessionService,
  projectSessionId: string,
  projectFilePath: string,
  config: ComfyUiConfig,
  request: ComfyUiEditImageRequest,
  isAuthorityCurrent: () => boolean = () => true,
): Promise<ComfyUiImageJobResponse> {
  return editComfyUiImageThroughSharedCore({
    owner,
    config,
    request,
    projectFilePath,
    isAuthorityCurrent,
    projectSessionId,
    readSourceImage: () =>
      readBoundedComfyUiSourceImage(sessions, projectSessionId, request.sourceAssetId),
  });
}

export async function cancelComfyUiJob(
  _config: ComfyUiConfig,
  projectSessionId?: string,
): Promise<ComfyUiCancelJobResponse> {
  if (!projectSessionId)
    return {
      ok: false,
      success: false,
      error: 'No active Project session for ComfyUI cancellation.',
    };
  return cancelEditorComfyUiRun(projectSessionId);
}
