import type { ToolDiagnostic } from './editor-tooling';

export type ComfyUiConnectionState = 'disabled' | 'checking' | 'ready' | 'error';

export interface ComfyUiConfig {
  enabled: boolean;
  serverUrl: string;
  defaultWorkflowId: string;
  outputSubfolder: string;
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
    defaultWorkflowId: 'basic-text-to-image',
    outputSubfolder: 'assets/images/generated',
    requestTimeoutMs: 15000,
    connectionCheckIntervalMs: 10000,
  };
}

export function normalizeComfyUiServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, '');
}
