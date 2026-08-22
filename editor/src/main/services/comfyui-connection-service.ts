import type { ComfyUiConfig, ComfyUiStatus } from '../../shared/comfyui';
import { normalizeComfyUiServerUrl } from '../../shared/comfyui';

const MAX_STATUS_RESPONSE_BYTES = 1024 * 1024;

function checkedAt() {
  return new Date().toISOString();
}

function endpoint(config: ComfyUiConfig, pathname: string) {
  const base = new URL(normalizeComfyUiServerUrl(config.serverUrl));
  return new URL(
    pathname,
    `${base.origin}${base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`}`,
  );
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_STATUS_RESPONSE_BYTES)
    throw new Error('ComfyUI response exceeded the status limit.');
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_STATUS_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('ComfyUI response exceeded the status limit.');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!bytes.byteLength) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function fetchJson(config: ComfyUiConfig, pathname: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(endpoint(config, pathname), { signal: controller.signal });
    if (!response.ok) throw new Error(`ComfyUI returned HTTP ${response.status}.`);
    return await readBoundedJson(response);
  } finally {
    clearTimeout(timeout);
  }
}

function findComfyUiVersion(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['comfyui_version', 'comfyuiVersion', 'version']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const candidate of Object.values(record)) {
    const found = findComfyUiVersion(candidate);
    if (found) return found;
  }
  return null;
}

function queueRemaining(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { queue_running?: unknown; queue_pending?: unknown };
  const running = Array.isArray(record.queue_running) ? record.queue_running.length : 0;
  const pending = Array.isArray(record.queue_pending) ? record.queue_pending.length : 0;
  return running + pending;
}

export async function checkHeadlessComfyUiConnection(
  config: ComfyUiConfig,
): Promise<ComfyUiStatus> {
  const serverUrl = normalizeComfyUiServerUrl(config.serverUrl);
  try {
    const stats = await fetchJson(config, '/system_stats');
    let queue: unknown = null;
    try {
      queue = await fetchJson(config, '/queue');
    } catch {
      // Queue state is supplementary to a successful server status check.
    }
    return {
      state: 'ready',
      serverUrl,
      checkedAt: checkedAt(),
      message: 'ComfyUI ready',
      queueRemaining: queueRemaining(queue),
      comfyUiVersion: findComfyUiVersion(stats) ?? 'unknown',
    };
  } catch (error) {
    return {
      state: 'error',
      serverUrl,
      checkedAt: checkedAt(),
      message:
        error instanceof Error && error.name === 'AbortError'
          ? 'ComfyUI connection timed out.'
          : 'ComfyUI connection check failed.',
      queueRemaining: null,
    };
  }
}
