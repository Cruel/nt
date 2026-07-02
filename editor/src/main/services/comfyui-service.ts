import type { ComfyUiConfig, ComfyUiQueueProgress, ComfyUiStatus } from '../../shared/comfyui';
import { normalizeComfyUiServerUrl } from '../../shared/comfyui';

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

function normalizeUrl(config: ComfyUiConfig, path: string): URL | string {
  try {
    const base = normalizeComfyUiServerUrl(config.serverUrl);
    const url = new URL(base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'ComfyUI server URL must use http or https.';
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return new URL(normalizedPath, `${url.origin}${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}`);
  } catch {
    return 'ComfyUI server URL is invalid.';
  }
}

async function fetchJson(config: ComfyUiConfig, path: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const url = normalizeUrl(config, path);
  if (typeof url === 'string') return { ok: false, error: url };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, error: `ComfyUI returned HTTP ${response.status} for ${path}.` };
    return { ok: true, value: await response.json() };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { ok: false, error: 'ComfyUI connection timed out.' };
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

export async function checkComfyUiConnection(config: ComfyUiConfig): Promise<ComfyUiStatus> {
  if (!config.enabled) return disabledStatus(config);
  const stats = await fetchJson(config, '/system_stats');
  if (!stats.ok) return errorStatus(config, stats.error);
  const queue = await fetchJson(config, '/queue');
  return {
    state: 'ready',
    serverUrl: normalizeComfyUiServerUrl(config.serverUrl),
    checkedAt: checkedAt(),
    message: 'ComfyUI ready',
    queueRemaining: queue.ok ? queueRemainingFromValue(queue.value) : null,
    systemStats: stats.value,
  };
}

export async function getComfyUiQueue(config: ComfyUiConfig): Promise<ComfyUiQueueProgress> {
  if (!config.enabled) {
    return { promptId: null, workflowId: null, state: 'idle', queueRemaining: null, currentNode: null, progressValue: null, progressMax: null, message: 'ComfyUI disabled' };
  }
  const queue = await fetchJson(config, '/queue');
  if (!queue.ok) {
    return { promptId: null, workflowId: null, state: 'error', queueRemaining: null, currentNode: null, progressValue: null, progressMax: null, message: queue.error };
  }
  const queueRemaining = queueRemainingFromValue(queue.value);
  return {
    promptId: null,
    workflowId: null,
    state: queueRemaining && queueRemaining > 0 ? 'queued' : 'idle',
    queueRemaining,
    currentNode: null,
    progressValue: null,
    progressMax: null,
    message: queueRemaining && queueRemaining > 0 ? `${queueRemaining} queued/running` : 'ComfyUI queue idle',
  };
}
