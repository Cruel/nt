import { z } from 'zod';
import type { ToolDiagnostic } from './editor-tooling';
import type { ComfyUiWorkflowId, ComfyUiWorkflowRole } from './comfyui-workflows';

export type ComfyUiConnectionState = 'disabled' | 'unchecked' | 'checking' | 'ready' | 'error';

export const COMFYUI_IPC_LIMITS = {
  serverUrlBytes: 2 * 1024,
  workflowIdBytes: 256,
  workflowLabelBytes: 1024,
  promptBytes: 64 * 1024,
  workflowManifestBytes: 1024 * 1024,
  sourceUploadBytes: 32 * 1024 * 1024,
  requestTimeoutMs: 300_000,
  connectionCheckIntervalMs: 3_600_000,
  defaultWorkflowEntries: 16,
  workflowJsonLength: 8 * 1024 * 1024,
} as const;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function utf8BoundedStringSchema(maxBytes: number, minimumLength = 0) {
  return z
    .string()
    .min(minimumLength)
    .max(maxBytes)
    .refine((value) => utf8ByteLength(value) <= maxBytes);
}

export const comfyUiWorkflowIdSchema = utf8BoundedStringSchema(
  COMFYUI_IPC_LIMITS.workflowIdBytes,
  1,
);
export const comfyUiWorkflowLabelSchema = utf8BoundedStringSchema(
  COMFYUI_IPC_LIMITS.workflowLabelBytes,
  1,
);
export const comfyUiPromptSchema = utf8BoundedStringSchema(COMFYUI_IPC_LIMITS.promptBytes);
export const comfyUiServerUrlSchema = utf8BoundedStringSchema(COMFYUI_IPC_LIMITS.serverUrlBytes, 1)
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  });

const boundedWorkflowIdSchema = comfyUiWorkflowIdSchema;
export const comfyUiConfigSchema = z
  .object({
    enabled: z.boolean(),
    serverUrl: comfyUiServerUrlSchema,
    defaultWorkflowId: boundedWorkflowIdSchema,
    defaultWorkflows: z
      .partialRecord(z.enum(['image.generate', 'image.edit']), boundedWorkflowIdSchema)
      .refine((value) => Object.keys(value).length <= COMFYUI_IPC_LIMITS.defaultWorkflowEntries),
    requestTimeoutMs: z.number().int().positive().max(COMFYUI_IPC_LIMITS.requestTimeoutMs),
    connectionCheckIntervalMs: z
      .number()
      .int()
      .positive()
      .max(COMFYUI_IPC_LIMITS.connectionCheckIntervalMs),
  })
  .strict();

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
  comfyUiVersion?: string;
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
  projectSessionId?: string;
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
