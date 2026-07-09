import type { ToolDiagnostic } from './editor-tooling';
import type { ComfyUiWorkflowId, ComfyUiWorkflowRole } from './comfyui-workflows';

export type ComfyUiConnectionState = 'disabled' | 'unchecked' | 'checking' | 'ready' | 'error';

export interface ComfyUiConfig {
  enabled: boolean;
  serverUrl: string;
  defaultWorkflowId: string;
  defaultWorkflows: Partial<Record<ComfyUiWorkflowRole, ComfyUiWorkflowId>>;
  requestTimeoutMs: number;
  connectionCheckIntervalMs: number;
}

export interface ComfyUiStatus {
  state: ComfyUiConnectionState;
  serverUrl: string | null;
  checkedAt: string | null;
  message: string | null;
  queueRemaining: number | null;
  systemStats?: unknown;
}

export interface ComfyUiQueueProgress {
  promptId: string | null;
  workflowId: string | null;
  state: 'idle' | 'queued' | 'running' | 'completed' | 'error' | 'interrupted';
  queueRemaining: number | null;
  currentNode: string | null;
  progressValue: number | null;
  progressMax: number | null;
  message: string | null;
  projectFilePath?: string;
  workflowLabel?: string;
  role?: ComfyUiWorkflowRole;
  mode?: 'generate' | 'edit';
  promptSummary?: string;
  queueNumber?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ComfyUiGenerateImageRequest {
  workflowId: string;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
  cfg?: number;
  outputName?: string;
}

export interface ComfyUiGenerateImageResponse {
  ok: boolean;
  success: boolean;
  promptId?: string;
  assets: unknown[];
  diagnostics: ToolDiagnostic[];
  error?: string;
}

export function defaultComfyUiConfig(): ComfyUiConfig {
  return {
    enabled: false,
    serverUrl: 'http://127.0.0.1:8000',
    defaultWorkflowId: 'flux2-klein-text-to-image',
    defaultWorkflows: {
      'image.generate': 'flux2-klein-text-to-image',
      'image.edit': 'flux2-klein-image-edit',
    },
    requestTimeoutMs: 15000,
    connectionCheckIntervalMs: 10000,
  };
}

export function normalizeComfyUiConfig(config: Partial<ComfyUiConfig> = {}): ComfyUiConfig {
  const defaults = defaultComfyUiConfig();
  const defaultWorkflowId = config.defaultWorkflowId ?? defaults.defaultWorkflowId;
  return {
    ...defaults,
    ...config,
    serverUrl: normalizeComfyUiServerUrl(config.serverUrl ?? defaults.serverUrl),
    defaultWorkflowId,
    defaultWorkflows: {
      ...defaults.defaultWorkflows,
      ...config.defaultWorkflows,
      'image.generate': config.defaultWorkflows?.['image.generate'] ?? defaultWorkflowId,
    },
  };
}

export function normalizeComfyUiServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, '');
}
