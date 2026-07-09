import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { ImportedAssetMetadata } from '../../shared/asset-import';
import type { ComfyUiConfig, ComfyUiQueueProgress, ComfyUiStatus } from '../../shared/comfyui';
import { normalizeComfyUiServerUrl } from '../../shared/comfyui';
import type { ComfyUiCancelJobResponse, ComfyUiEditImageRequest, ComfyUiGenerateImageRequest, ComfyUiImageJobResponse } from '../../shared/comfyui-generation';
import { BUILTIN_COMFYUI_WORKFLOW_MANIFESTS, parseComfyUiWorkflowDefinition, resolveComfyUiWorkflowBinding, resolvedComfyUiWorkflowOutputNodeIdList, validateComfyUiWorkflowDefinitionContract, type ComfyUiInstallStarterWorkflowsResponse, type ComfyUiWorkflowBinding, type ComfyUiWorkflowDefinition, type ComfyUiWorkflowDiagnostic, type ComfyUiWorkflowListEntry, type ComfyUiWorkflowListResponse } from '../../shared/comfyui-workflows';
import { listComfyUiWorkflowLibrary } from './comfyui-workflow-library-service';
import { isSafeProjectAssetPath } from '../../shared/project-schema/authoring-assets';
import { IPC_CHANNELS } from '../../shared/ipc-channels';

interface WorkflowNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
}

type WorkflowGraph = Record<string, WorkflowNode>;

interface ComfyImageDescriptor {
  filename: string;
  subfolder?: string;
  type?: string;
}

interface PromptResponse {
  prompt_id?: string;
  number?: number;
  error?: unknown;
  node_errors?: unknown;
}

function checkedAt() {
  return new Date().toISOString();
}

function disabledStatus(config: ComfyUiConfig): ComfyUiStatus {
  return { state: 'disabled', serverUrl: normalizeComfyUiServerUrl(config.serverUrl), checkedAt: checkedAt(), message: 'ComfyUI disabled', queueRemaining: null };
}

function errorStatus(config: ComfyUiConfig, message: string): ComfyUiStatus {
  return { state: 'error', serverUrl: config.serverUrl ? normalizeComfyUiServerUrl(config.serverUrl) : null, checkedAt: checkedAt(), message, queueRemaining: null };
}

function normalizeUrl(config: ComfyUiConfig, urlPath: string): URL | string {
  try {
    const base = normalizeComfyUiServerUrl(config.serverUrl);
    const url = new URL(base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'ComfyUI server URL must use http or https.';
    const normalizedPath = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
    return new URL(normalizedPath, `${url.origin}${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}`);
  } catch {
    return 'ComfyUI server URL is invalid.';
  }
}

function websocketUrl(config: ComfyUiConfig, clientId: string): string | null {
  const url = normalizeUrl(config, `/ws?clientId=${encodeURIComponent(clientId)}`);
  if (typeof url === 'string') return null;
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function stringifyComfyUiError(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  const directMessage = record.message ?? record.error ?? record.exception_message;
  if (typeof directMessage === 'string' && directMessage.trim()) return directMessage;
  const details = [record.type, record.node_id, record.class_type, record.exception_type, record.exception_message]
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (details.length) return details.join(' • ');
  try { return JSON.stringify(value); } catch { return 'ComfyUI returned an unreadable error object.'; }
}

async function fetchJson(config: ComfyUiConfig, urlPath: string, init?: RequestInit): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const url = normalizeUrl(config, urlPath);
  if (typeof url === 'string') return { ok: false, error: url };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let value: unknown = null;
    if (text.trim()) {
      try { value = JSON.parse(text); } catch { value = text; }
    }
    if (!response.ok) {
      const detail = stringifyComfyUiError(value);
      return { ok: false, error: detail ? `ComfyUI returned HTTP ${response.status} for ${urlPath}: ${detail}` : `ComfyUI returned HTTP ${response.status} for ${urlPath}.` };
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { ok: false, error: 'ComfyUI connection timed out.' };
    return { ok: false, error: error instanceof Error ? error.message : 'ComfyUI request failed.' };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBytes(config: ComfyUiConfig, urlPath: string): Promise<Buffer> {
  const url = normalizeUrl(config, urlPath);
  if (typeof url === 'string') throw new Error(url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ComfyUI returned HTTP ${response.status} for ${urlPath}.`);
  return Buffer.from(await response.arrayBuffer());
}

function queueRemainingFromValue(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const queue = value as { queue_running?: unknown; queue_pending?: unknown };
  const running = Array.isArray(queue.queue_running) ? queue.queue_running.length : 0;
  const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending.length : 0;
  return running + pending;
}

export async function checkComfyUiConnection(config: ComfyUiConfig): Promise<ComfyUiStatus> {
  if (!config.enabled) return disabledStatus(config);
  const stats = await fetchJson(config, '/system_stats');
  if (!stats.ok) return errorStatus(config, stats.error);
  const queue = await fetchJson(config, '/queue');
  return { state: 'ready', serverUrl: normalizeComfyUiServerUrl(config.serverUrl), checkedAt: checkedAt(), message: 'ComfyUI ready', queueRemaining: queue.ok ? queueRemainingFromValue(queue.value) : null, systemStats: stats.value };
}

export async function getComfyUiQueue(config: ComfyUiConfig): Promise<ComfyUiQueueProgress> {
  if (!config.enabled) return { promptId: null, workflowId: null, state: 'idle', queueRemaining: null, currentNode: null, progressValue: null, progressMax: null, message: 'ComfyUI disabled' };
  const queue = await fetchJson(config, '/queue');
  if (!queue.ok) return { promptId: null, workflowId: null, state: 'error', queueRemaining: null, currentNode: null, progressValue: null, progressMax: null, message: queue.error };
  const queueRemaining = queueRemainingFromValue(queue.value);
  return { promptId: null, workflowId: null, state: queueRemaining && queueRemaining > 0 ? 'queued' : 'idle', queueRemaining, currentNode: null, progressValue: null, progressMax: null, message: queueRemaining && queueRemaining > 0 ? `${queueRemaining} queued/running` : 'ComfyUI queue idle' };
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

function diagnostic(pathValue: string, message: string, severity: ComfyUiWorkflowDiagnostic['severity'] = 'error'): ComfyUiWorkflowDiagnostic {
  return { severity, category: 'comfyui-workflows', path: pathValue, message };
}

function entryStatus(diagnostics: ComfyUiWorkflowDiagnostic[]): ComfyUiWorkflowListEntry['status'] {
  if (diagnostics.some((item) => item.severity === 'error')) return 'invalid';
  if (diagnostics.some((item) => item.severity === 'warning' || item.severity === 'info')) return 'warning';
  return 'valid';
}

function slashPath(value: string) {
  return value.split(path.sep).join('/');
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

export async function installProjectComfyUiStarterWorkflows(projectFilePath: string): Promise<ComfyUiInstallStarterWorkflowsResponse> {
  if (!projectFilePath) return { ok: false, success: false, copied: [], skipped: [], diagnostics: [diagnostic('/workflows', 'Save the project before installing starter workflows.')], error: 'Project file path is required.' };
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
      const manifestResult = await copyStarterFile(manifestSource, path.join(projectRoot, manifestFile));
      (manifestResult === 'copied' ? copied : skipped).push(manifestFile);
      const workflowResult = await copyStarterFile(path.join(bundledRoot, definition.workflowFile), path.join(projectRoot, definition.workflowFile));
      (workflowResult === 'copied' ? copied : skipped).push(definition.workflowFile);
    } catch (error) {
      diagnostics.push(diagnostic(`/workflows/${manifestFile}`, error instanceof Error ? error.message : 'Failed to install starter workflow.'));
    }
  }
  return { ok: !diagnostics.some((item) => item.severity === 'error'), success: true, copied, skipped, diagnostics };
}

async function readManifestFiles(projectFilePath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(projectWorkflowsRoot(projectFilePath));
    return entries.filter((entry) => entry.endsWith('.manifest.json')).sort();
  } catch {
    return [];
  }
}

export async function loadComfyUiWorkflowTemplate(projectFilePath: string, definition: ComfyUiWorkflowDefinition): Promise<WorkflowGraph> {
  const text = await fs.readFile(path.join(projectWorkflowsRoot(projectFilePath), definition.workflowFile), 'utf8');
  return JSON.parse(text) as WorkflowGraph;
}

function validateWorkflowBindings(workflow: WorkflowGraph, definition: ComfyUiWorkflowDefinition): ComfyUiWorkflowDiagnostic[] {
  const diagnostics: ComfyUiWorkflowDiagnostic[] = [...validateComfyUiWorkflowDefinitionContract(definition)];
  for (const [semanticKey, binding] of Object.entries(definition.bindings)) {
    if (!binding) continue;
    const resolution = resolveComfyUiWorkflowBinding(workflow, binding);
    if (!resolution.ok) {
      diagnostics.push(diagnostic(`/workflows/${definition.manifestFile ?? definition.id}/bindings/${semanticKey}`, resolution.message ?? `Workflow '${definition.label}' has an unresolved binding.`));
      continue;
    }
    if (resolution.rebased && binding.nodeId && resolution.nodeId) {
      diagnostics.push(diagnostic(`/workflows/${definition.manifestFile ?? definition.id}/bindings/${semanticKey}`, `Rebased stale node id ${binding.nodeId} to node ${resolution.nodeId} using selector metadata.`, 'info'));
    }
  }
  try {
    resolvedComfyUiWorkflowOutputNodeIdList(workflow, definition);
  } catch (error) {
    diagnostics.push(diagnostic(`/workflows/${definition.manifestFile ?? definition.id}/outputBindings/images`, error instanceof Error ? error.message : 'Workflow output bindings could not be resolved.'));
  }
  return diagnostics;
}

function assertWorkflowBindingsValid(workflow: WorkflowGraph, definition: ComfyUiWorkflowDefinition) {
  const diagnostics = validateWorkflowBindings(workflow, definition);
  const firstError = diagnostics.find((item) => item.severity === 'error');
  if (firstError) throw new Error(firstError.message);
  return diagnostics;
}

async function validateProjectWorkflowDefinition(projectFilePath: string, definition: ComfyUiWorkflowDefinition): Promise<ComfyUiWorkflowDiagnostic[]> {
  const diagnostics: ComfyUiWorkflowDiagnostic[] = [];
  const manifestPath = `/workflows/${definition.manifestFile ?? definition.id}`;
  try {
    const workflowPath = path.join(projectWorkflowsRoot(projectFilePath), definition.workflowFile);
    const relative = path.relative(projectWorkflowsRoot(projectFilePath), workflowPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Workflow file escapes the workflows directory.');
    const workflow = await loadComfyUiWorkflowTemplate(projectFilePath, definition);
    diagnostics.push(...validateWorkflowBindings(workflow, definition));
    if (!definition.outputBindings.images?.length) diagnostics.push(diagnostic(`${manifestPath}/outputBindings/images`, `Workflow '${definition.label}' uses legacy outputNodeIds; repair or reimport it to add explicit output bindings.`, 'warning'));
  } catch (error) {
    diagnostics.push(diagnostic(manifestPath, error instanceof Error ? error.message : 'Workflow template is invalid.'));
  }
  return diagnostics;
}

export async function listComfyUiWorkflows(projectFilePath: string): Promise<ComfyUiWorkflowListResponse> {
  if (!projectFilePath) return { ok: false, success: false, workflows: [], entries: [], diagnostics: [diagnostic('/workflows', 'Save the project before using ComfyUI workflows.')], error: 'Project file path is required.' };
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
        workflowJsonText = await fs.readFile(path.join(projectWorkflowsRoot(projectFilePath), definition.workflowFile), 'utf8');
      } catch {
        // Missing workflow files are represented by validation diagnostics below.
      }
      const definitionDiagnostics = await validateProjectWorkflowDefinition(projectFilePath, definition);
      const status = entryStatus(definitionDiagnostics);
      entries.push({
        manifestFile,
        workflowFile: definition.workflowFile,
        definition,
        id: definition.id,
        label: definition.label,
        role: definition.role,
        status,
        repairable: Boolean(workflowJsonText),
        diagnostics: definitionDiagnostics,
        manifestJsonText,
        workflowJsonText,
      });
      diagnostics.push(...definitionDiagnostics);
      if (status !== 'invalid') workflows.push(definition);
    } catch (error) {
      const entryDiagnostics = [diagnostic(`/workflows/${manifestFile}`, error instanceof Error ? error.message : 'Workflow manifest is invalid.')];
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
  return { ok: !diagnostics.some((item) => item.severity === 'error'), success: true, workflows, entries, diagnostics };
}

export async function validateProjectComfyUiWorkflows(projectFilePath: string): Promise<ComfyUiWorkflowDiagnostic[]> {
  return (await listComfyUiWorkflows(projectFilePath)).diagnostics;
}

async function resolveComfyUiWorkflowPackage(
  projectFilePath: string,
  request: Pick<ComfyUiGenerateImageRequest | ComfyUiEditImageRequest, 'workflowId' | 'workflowKey'>,
): Promise<{ definition: ComfyUiWorkflowDefinition; workflow: WorkflowGraph }> {
  const response = await listComfyUiWorkflowLibrary({ projectFilePath, includeOverridden: true });
  const entry = request.workflowKey
    ? response.entries.find((item) => item.workflowKey === request.workflowKey)
    : response.entries.find((item) => item.active && item.id === request.workflowId);
  if (!entry?.definition || !entry.workflowPath) {
    const requested = request.workflowKey ?? request.workflowId ?? '(none)';
    const detail = response.diagnostics.length ? ` Diagnostics: ${response.diagnostics.map((item) => item.message).join('; ')}` : '';
    throw new Error(`Unknown or invalid ComfyUI workflow '${requested}'.${detail}`);
  }
  if (entry.offlineStatus === 'invalid') {
    const detail = entry.diagnostics.length ? ` Diagnostics: ${entry.diagnostics.map((item) => item.message).join('; ')}` : '';
    throw new Error(`Invalid ComfyUI workflow '${entry.definition.id}'.${detail}`);
  }
  if (entry.overridden) {
    throw new Error(`ComfyUI workflow '${entry.definition.id}' is overridden by '${entry.overriddenBy}'.`);
  }
  const text = await fs.readFile(entry.workflowPath, 'utf8');
  return { definition: entry.definition, workflow: JSON.parse(text) as WorkflowGraph };
}

function cloneWorkflow(workflow: WorkflowGraph): WorkflowGraph {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowGraph;
}

function coerceBindingValue(binding: ComfyUiWorkflowBinding, value: unknown) {
  const bindingLabel = `${binding.nodeId ?? binding.nodeTitle ?? 'unresolved'}.${binding.inputName}`;
  if (binding.valueType === 'integer') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Input '${bindingLabel}' must be a number.`);
    return Math.trunc(number);
  }
  if (binding.valueType === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Input '${bindingLabel}' must be a number.`);
    return number;
  }
  return String(value);
}

function setWorkflowInput(workflow: WorkflowGraph, binding: ComfyUiWorkflowBinding | undefined, value: unknown) {
  if (!binding) return;
  const resolution = resolveComfyUiWorkflowBinding(workflow, binding);
  if (!resolution.ok || !resolution.nodeId) throw new Error(resolution.message ?? `Workflow binding '${binding.nodeTitle ?? binding.inputName}' cannot be resolved.`);
  const inputName = binding.selector?.inputName ?? binding.inputName;
  const node = workflow[resolution.nodeId];
  if (!node || !node.inputs) throw new Error(`Workflow node '${resolution.nodeId}' is missing.`);
  if (!(inputName in node.inputs)) throw new Error(`Workflow input '${resolution.nodeId}.${inputName}' is missing.`);
  node.inputs[inputName] = coerceBindingValue(binding, value);
}

function setOptionalWorkflowInput(workflow: WorkflowGraph, binding: ComfyUiWorkflowBinding | undefined, value: unknown) {
  if (value === undefined || value === null) return;
  setWorkflowInput(workflow, binding, value);
}

function generatedSeed(seed: number | undefined) {
  if (seed !== undefined && seed >= 0 && Number.isFinite(seed)) return Math.trunc(seed);
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

function safeGeneratedName(prefix: 'generated' | 'edit') {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `${prefix}-${timestamp}-${randomUUID().slice(0, 8)}.png`;
}

function mimeForFilename(filename: string) {
  switch (path.extname(filename).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.png':
    default: return 'image/png';
  }
}

async function writeGeneratedAsset(projectFilePath: string, bytes: Buffer, prefix: 'generated' | 'edit'): Promise<{ metadata: ImportedAssetMetadata; absolutePath: string; previewUrl: string; projectRelativePath: string }> {
  const projectRoot = projectRootFromFile(projectFilePath);
  const generatedDir = path.join(projectRoot, 'assets', 'generated');
  await fs.mkdir(generatedDir, { recursive: true });
  let absolutePath = path.join(generatedDir, safeGeneratedName(prefix));
  while (true) {
    try {
      await fs.access(absolutePath);
      absolutePath = path.join(generatedDir, safeGeneratedName(prefix));
    } catch {
      break;
    }
  }
  await fs.writeFile(absolutePath, bytes);
  const projectRelativePath = slashPath(path.relative(projectRoot, absolutePath));
  const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const originalName = path.basename(absolutePath);
  const mimeType = mimeForFilename(originalName);
  return {
    absolutePath,
    projectRelativePath,
    previewUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
    metadata: { originalPath: `comfyui:${originalName}`, originalName, projectRelativePath, kind: 'image', extension: path.extname(originalName).toLowerCase(), mimeType, byteSize: bytes.byteLength, contentHash, importedAt: new Date().toISOString() },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function objectInfoInputNames(nodeInfo: unknown): Set<string> | null {
  if (!isRecord(nodeInfo) || !isRecord(nodeInfo.input)) return null;
  const names = new Set<string>();
  for (const section of ['required', 'optional', 'hidden'] as const) {
    const inputs = nodeInfo.input[section];
    if (!isRecord(inputs)) continue;
    for (const inputName of Object.keys(inputs)) names.add(inputName);
  }
  return names.size ? names : null;
}

function workflowRequirementInputErrors(definition: ComfyUiWorkflowDefinition, objectInfo: Record<string, unknown>) {
  const errors: string[] = [];
  for (const [semanticKey, binding] of Object.entries(definition.bindings)) {
    if (!binding) continue;
    const classType = binding.selector?.classType ?? binding.classType;
    const inputName = binding.selector?.inputName ?? binding.inputName;
    if (!classType || !(classType in objectInfo)) continue;
    const inputNames = objectInfoInputNames(objectInfo[classType]);
    if (inputNames && !inputNames.has(inputName)) errors.push(`${semanticKey}: ${classType}.${inputName}`);
  }
  return errors;
}

async function validateWorkflowRequirements(config: ComfyUiConfig, definition: ComfyUiWorkflowDefinition) {
  const info = await fetchJson(config, '/object_info');
  if (!info.ok) throw new Error(info.error);
  const available = info.value && typeof info.value === 'object' ? info.value as Record<string, unknown> : {};
  const missing = definition.requiredNodeClasses.filter((nodeClass) => !(nodeClass in available));
  if (missing.length) throw new Error(`ComfyUI is missing required node classes for ${definition.label}: ${missing.join(', ')}`);
  const inputErrors = workflowRequirementInputErrors(definition, available);
  if (inputErrors.length) throw new Error(`ComfyUI node metadata does not expose mapped workflow inputs for ${definition.label}: ${inputErrors.join(', ')}`);
}

async function submitPrompt(config: ComfyUiConfig, workflow: WorkflowGraph, promptId: string, clientId: string): Promise<PromptResponse> {
  const result = await fetchJson(config, '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow, prompt_id: promptId, client_id: clientId }) });
  if (!result.ok) throw new Error(result.error);
  const response = result.value as PromptResponse;
  if (!response.prompt_id) {
    const detail = stringifyComfyUiError(response.error) ?? stringifyComfyUiError(response.node_errors);
    throw new Error(detail ? `ComfyUI rejected the prompt: ${detail}` : 'ComfyUI did not return a prompt id.');
  }
  return response;
}

function progressFromMessage(message: unknown, workflowId: string, promptId: string): ComfyUiQueueProgress | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as { type?: string; data?: Record<string, unknown> };
  const data = record.data ?? {};
  if (data.prompt_id && data.prompt_id !== promptId) return null;
  if (record.type === 'status') {
    const status = data.status as { exec_info?: { queue_remaining?: unknown } } | undefined;
    const remaining = Number(status?.exec_info?.queue_remaining);
    return { promptId, workflowId, state: 'queued', queueRemaining: Number.isFinite(remaining) ? remaining : null, currentNode: null, progressValue: null, progressMax: null, message: 'Queued' };
  }
  if (record.type === 'execution_start') return { promptId, workflowId, state: 'running', queueRemaining: null, currentNode: null, progressValue: null, progressMax: null, message: 'Generation started' };
  if (record.type === 'executing') {
    const node = typeof data.node === 'string' ? data.node : null;
    if (node === null) return { promptId, workflowId, state: 'completed', queueRemaining: 0, currentNode: null, progressValue: null, progressMax: null, message: 'Generation complete' };
    return { promptId, workflowId, state: 'running', queueRemaining: null, currentNode: node, progressValue: null, progressMax: null, message: `Running node ${node}` };
  }
  if (record.type === 'progress') {
    const value = Number(data.value);
    const max = Number(data.max);
    return { promptId, workflowId, state: 'running', queueRemaining: null, currentNode: typeof data.node === 'string' ? data.node : null, progressValue: Number.isFinite(value) ? value : null, progressMax: Number.isFinite(max) ? max : null, message: Number.isFinite(value) && Number.isFinite(max) ? `Progress ${value}/${max}` : 'Running' };
  }
  if (record.type === 'execution_error') {
    const nodeId = typeof data.node_id === 'string' ? data.node_id : null;
    const detail = stringifyComfyUiError(data.exception_message)
      ?? stringifyComfyUiError(data.exception_type)
      ?? stringifyComfyUiError(data);
    const message = detail ? `ComfyUI execution error${nodeId ? ` at node ${nodeId}` : ''}: ${detail}` : 'ComfyUI execution error.';
    return { promptId, workflowId, state: 'error', queueRemaining: null, currentNode: nodeId, progressValue: null, progressMax: null, message };
  }
  return null;
}

async function waitForPromptHistory(config: ComfyUiConfig, workflowId: string, promptId: string, emit: (progress: ComfyUiQueueProgress) => void, reason = 'Waiting for ComfyUI history') {
  emit({ promptId, workflowId, state: 'running', queueRemaining: null, currentNode: null, progressValue: null, progressMax: null, message: reason });
  for (let attempt = 0; attempt < 360; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const history = await fetchJson(config, `/history/${encodeURIComponent(promptId)}`);
    if (history.ok && history.value && typeof history.value === 'object' && promptId in history.value) return;
  }
  throw new Error('ComfyUI generation timed out waiting for history.');
}

async function waitForPrompt(config: ComfyUiConfig, workflowId: string, promptId: string, clientId: string, emit: (progress: ComfyUiQueueProgress) => void) {
  const url = websocketUrl(config, clientId);
  if (!url || typeof WebSocket === 'undefined') {
    await waitForPromptHistory(config, workflowId, promptId, emit);
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        try { ws.close(); } catch { /* noop */ }
        reject(new Error('ComfyUI generation timed out.'));
      }, Math.max(config.requestTimeoutMs, 1) * 120);
      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        try { ws.close(); } catch { /* noop */ }
        reject(new Error('ComfyUI WebSocket failed.'));
      });
      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const progress = progressFromMessage(JSON.parse(event.data), workflowId, promptId);
          if (!progress) return;
          emit(progress);
          if (progress.state === 'completed') {
            clearTimeout(timeout);
            ws.close();
            resolve();
          } else if (progress.state === 'error') {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(progress.message ?? 'ComfyUI execution failed.'));
          }
        } catch { /* Ignore malformed progress frames. */ }
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ComfyUI WebSocket failed.';
    if (message.includes('WebSocket')) {
      await waitForPromptHistory(config, workflowId, promptId, emit, 'ComfyUI WebSocket failed; polling history for completion.');
      return;
    }
    throw error;
  }
}

async function historyImageDescriptors(config: ComfyUiConfig, promptId: string, outputNodeIds: string[]): Promise<ComfyImageDescriptor[]> {
  const result = await fetchJson(config, `/history/${encodeURIComponent(promptId)}`);
  if (!result.ok) throw new Error(result.error);
  const root = result.value as Record<string, { outputs?: Record<string, { images?: ComfyImageDescriptor[] }> }>;
  const promptHistory = root[promptId];
  if (!promptHistory?.outputs) return [];
  const outputs = outputNodeIds.length
    ? outputNodeIds.map((nodeId) => promptHistory.outputs?.[nodeId]).filter((output): output is { images?: ComfyImageDescriptor[] } => Boolean(output))
    : Object.values(promptHistory.outputs);
  return outputs.flatMap((output) => Array.isArray(output.images) ? output.images : []);
}

function descriptorViewPath(image: ComfyImageDescriptor) {
  const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
  return `/view?${params.toString()}`;
}

async function uploadImage(config: ComfyUiConfig, projectFilePath: string, sourceProjectRelativePath: string): Promise<string> {
  if (!isSafeProjectAssetPath(sourceProjectRelativePath)) throw new Error('Source image path is not a safe project asset path.');
  const projectRoot = projectRootFromFile(projectFilePath);
  const absolute = path.resolve(projectRoot, sourceProjectRelativePath);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Source image path escapes the project.');
  const bytes = await fs.readFile(absolute);
  const form = new FormData();
  const name = path.basename(sourceProjectRelativePath);
  form.append('image', new Blob([bytes]), name);
  form.append('overwrite', 'true');
  const result = await fetchJson(config, '/upload/image', { method: 'POST', body: form });
  if (!result.ok) throw new Error(result.error);
  const value = result.value as { name?: string; subfolder?: string; type?: string };
  if (!value.name) return name;
  return value.subfolder ? `${value.subfolder}/${value.name}` : value.name;
}

async function runImageJob(config: ComfyUiConfig, definition: ComfyUiWorkflowDefinition, workflow: WorkflowGraph, projectFilePath: string, prompt: string, seed: number, mode: 'generated' | 'edit', owner: BrowserWindow | null, clientJobId?: string): Promise<ComfyUiImageJobResponse> {
  const clientId = randomUUID();
  const promptId = clientJobId ?? randomUUID();
  const createdAt = new Date().toISOString();
  const queueMode = mode === 'generated' ? 'generate' : 'edit';
  const progressMetadata = {
    projectFilePath,
    workflowLabel: definition.label,
    role: definition.role,
    mode: queueMode,
    promptSummary: prompt.trim().slice(0, 120) || '(empty prompt)',
    createdAt,
  } satisfies Partial<ComfyUiQueueProgress>;
  try {
    await validateWorkflowRequirements(config, definition);
    const submitted = await submitPrompt(config, workflow, promptId, clientId);
    const actualPromptId = submitted.prompt_id ?? promptId;
    const outputNodeIds = resolvedComfyUiWorkflowOutputNodeIdList(workflow, definition);
    const emit = (progress: ComfyUiQueueProgress) => owner?.webContents.send(IPC_CHANNELS.COMFYUI_PROGRESS_EVENT, { ...progressMetadata, ...progress, updatedAt: new Date().toISOString() });
    emit({ promptId: actualPromptId, workflowId: definition.id, state: 'queued', queueRemaining: typeof submitted.number === 'number' ? submitted.number : null, currentNode: null, progressValue: null, progressMax: null, message: 'Queued generation', queueNumber: typeof submitted.number === 'number' ? submitted.number : undefined });
    await waitForPrompt(config, definition.id, actualPromptId, clientId, emit);
    const descriptors = await historyImageDescriptors(config, actualPromptId, outputNodeIds);
    if (!descriptors.length) {
      const outputDetail = outputNodeIds.length ? ` from selected output node${outputNodeIds.length === 1 ? '' : 's'} ${outputNodeIds.join(', ')}` : '';
      throw new Error(`ComfyUI completed without image outputs${outputDetail}.`);
    }
    const assets = [];
    for (const descriptor of descriptors) {
      const bytes = await fetchBytes(config, descriptorViewPath(descriptor));
      const written = await writeGeneratedAsset(projectFilePath, bytes, mode);
      assets.push({ asset: written.metadata, previewUrl: written.previewUrl, absolutePath: written.absolutePath, projectRelativePath: written.projectRelativePath, promptId: actualPromptId, workflowId: definition.id, seed, prompt, createdAt: new Date().toISOString() });
    }
    emit({ promptId: actualPromptId, workflowId: definition.id, state: 'completed', queueRemaining: 0, currentNode: null, progressValue: null, progressMax: null, message: `Generated ${assets.length} image${assets.length === 1 ? '' : 's'}` });
    return { ok: true, success: true, promptId: actualPromptId, assets, diagnostics: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ComfyUI image job failed.';
    owner?.webContents.send(IPC_CHANNELS.COMFYUI_PROGRESS_EVENT, { ...progressMetadata, promptId, workflowId: definition.id, state: 'error', queueRemaining: null, currentNode: null, progressValue: null, progressMax: null, message, updatedAt: new Date().toISOString() });
    return { ok: false, success: false, promptId, assets: [], diagnostics: [{ severity: 'error', category: 'comfyui', path: '/', message }], error: message };
  }
}

export async function generateComfyUiImage(owner: BrowserWindow | null, config: ComfyUiConfig, request: ComfyUiGenerateImageRequest): Promise<ComfyUiImageJobResponse> {
  if (!config.enabled) return { ok: false, success: false, assets: [], diagnostics: [], error: 'ComfyUI is disabled.' };
  if (!request.projectFilePath) return { ok: false, success: false, assets: [], diagnostics: [], error: 'Save the project before generating images.' };
  const { definition, workflow: template } = await resolveComfyUiWorkflowPackage(request.projectFilePath, request);
  if (definition.role !== 'image.generate') return { ok: false, success: false, assets: [], diagnostics: [], error: `Workflow '${definition.id}' is not an image.generate workflow.` };
  const workflow = cloneWorkflow(template);
  assertWorkflowBindingsValid(workflow, definition);
  const seed = generatedSeed(request.seed);
  setWorkflowInput(workflow, definition.bindings.prompt, request.prompt);
  setWorkflowInput(workflow, definition.bindings.negativePrompt, request.negativePrompt ?? definition.defaults.negativePrompt ?? '');
  setWorkflowInput(workflow, definition.bindings.width, request.width ?? definition.defaults.width ?? 1024);
  setWorkflowInput(workflow, definition.bindings.height, request.height ?? definition.defaults.height ?? 1024);
  setWorkflowInput(workflow, definition.bindings.steps, request.steps ?? definition.defaults.steps ?? 20);
  setOptionalWorkflowInput(workflow, definition.bindings.cfg, request.cfg ?? definition.defaults.cfg);
  setWorkflowInput(workflow, definition.bindings.seed, seed);
  setWorkflowInput(workflow, definition.bindings.filenamePrefix, definition.defaults.filenamePrefix);
  return runImageJob(config, definition, workflow, request.projectFilePath, request.prompt, seed, 'generated', owner, request.clientJobId);
}

export async function editComfyUiImage(owner: BrowserWindow | null, config: ComfyUiConfig, request: ComfyUiEditImageRequest): Promise<ComfyUiImageJobResponse> {
  if (!config.enabled) return { ok: false, success: false, assets: [], diagnostics: [], error: 'ComfyUI is disabled.' };
  if (!request.projectFilePath) return { ok: false, success: false, assets: [], diagnostics: [], error: 'Save the project before editing images.' };
  const { definition, workflow: template } = await resolveComfyUiWorkflowPackage(request.projectFilePath, request);
  if (definition.role !== 'image.edit') return { ok: false, success: false, assets: [], diagnostics: [], error: `Workflow '${definition.id}' is not an image.edit workflow.` };
  const workflow = cloneWorkflow(template);
  assertWorkflowBindingsValid(workflow, definition);
  const uploadReference = await uploadImage(config, request.projectFilePath, request.sourceProjectRelativePath);
  const seed = generatedSeed(request.seed);
  setWorkflowInput(workflow, definition.bindings.sourceImage, uploadReference);
  setWorkflowInput(workflow, definition.bindings.prompt, request.prompt);
  setWorkflowInput(workflow, definition.bindings.negativePrompt, request.negativePrompt ?? definition.defaults.negativePrompt ?? '');
  setWorkflowInput(workflow, definition.bindings.steps, request.steps ?? definition.defaults.steps ?? 4);
  setOptionalWorkflowInput(workflow, definition.bindings.cfg, request.cfg ?? definition.defaults.cfg);
  setWorkflowInput(workflow, definition.bindings.seed, seed);
  setWorkflowInput(workflow, definition.bindings.filenamePrefix, definition.defaults.filenamePrefix);
  return runImageJob(config, definition, workflow, request.projectFilePath, request.prompt, seed, 'edit', owner, request.clientJobId);
}

export async function cancelComfyUiJob(config: ComfyUiConfig): Promise<ComfyUiCancelJobResponse> {
  const result = await fetchJson(config, '/interrupt', { method: 'POST' });
  if (!result.ok) return { ok: false, success: false, error: result.error };
  return { ok: true, success: true };
}
