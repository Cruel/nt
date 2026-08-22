import { z } from 'zod';
import {
  isComfyUiWorkflowClassification,
  type ComfyUiWorkflowClassification,
  type ComfyUiWorkflowId,
} from './comfyui-workflows';

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
const workflowClassificationSchema = z
  .string()
  .min(3)
  .max(256)
  .refine(isComfyUiWorkflowClassification);
const defaultWorkflowsSchema = z
  .record(workflowClassificationSchema, boundedWorkflowIdSchema)
  .refine((value) => Object.keys(value).length <= COMFYUI_IPC_LIMITS.defaultWorkflowEntries);

export const comfyUiConfigSchema = z
  .object({
    enabled: z.boolean(),
    serverUrl: comfyUiServerUrlSchema,
    defaultWorkflows: defaultWorkflowsSchema,
    requestTimeoutMs: z.number().int().positive().max(COMFYUI_IPC_LIMITS.requestTimeoutMs),
    connectionCheckIntervalMs: z
      .number()
      .int()
      .positive()
      .max(COMFYUI_IPC_LIMITS.connectionCheckIntervalMs),
  })
  .strict();

export const COMFYUI_USER_CONFIG_FORMAT = 'noveltea.comfyui-user-config' as const;
export const COMFYUI_USER_CONFIG_FORMAT_VERSION = 1 as const;

export interface ComfyUiSharedUserConfig {
  format: typeof COMFYUI_USER_CONFIG_FORMAT;
  formatVersion: typeof COMFYUI_USER_CONFIG_FORMAT_VERSION;
  serverUrl: string;
  requestTimeoutMs: number;
  defaultWorkflows: Partial<Record<ComfyUiWorkflowClassification, ComfyUiWorkflowId>>;
}

export interface ComfyUiConfig {
  enabled: boolean;
  serverUrl: string;
  defaultWorkflows: Partial<Record<ComfyUiWorkflowClassification, ComfyUiWorkflowId>>;
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
  classification?: ComfyUiWorkflowClassification;
  mode?: 'generate' | 'edit';
  promptSummary?: string;
  queueNumber?: number;
  createdAt?: string;
  updatedAt?: string;
}

export function defaultComfyUiSharedUserConfig(): ComfyUiSharedUserConfig {
  return {
    format: COMFYUI_USER_CONFIG_FORMAT,
    formatVersion: COMFYUI_USER_CONFIG_FORMAT_VERSION,
    serverUrl: 'http://127.0.0.1:8000',
    defaultWorkflows: {
      'image.generate': 'flux2-klein-text-to-image',
      'image.edit': 'flux2-klein-image-edit',
    },
    requestTimeoutMs: 15000,
  };
}

export const comfyUiSharedUserConfigSchema = z
  .object({
    format: z.literal(COMFYUI_USER_CONFIG_FORMAT),
    formatVersion: z.literal(COMFYUI_USER_CONFIG_FORMAT_VERSION),
    serverUrl: comfyUiServerUrlSchema,
    defaultWorkflows: defaultWorkflowsSchema,
    requestTimeoutMs: z.number().int().positive().max(COMFYUI_IPC_LIMITS.requestTimeoutMs),
  })
  .strict();

export function normalizeComfyUiSharedUserConfig(
  config: Partial<ComfyUiSharedUserConfig> = {},
): ComfyUiSharedUserConfig {
  const defaults = defaultComfyUiSharedUserConfig();
  return comfyUiSharedUserConfigSchema.parse({
    ...defaults,
    ...config,
    serverUrl: normalizeComfyUiServerUrl(config.serverUrl ?? defaults.serverUrl),
    defaultWorkflows: {
      ...defaults.defaultWorkflows,
      ...config.defaultWorkflows,
    },
  });
}

export function comfyUiSharedUserConfigFromRuntime(config: ComfyUiConfig): ComfyUiSharedUserConfig {
  return normalizeComfyUiSharedUserConfig({
    format: COMFYUI_USER_CONFIG_FORMAT,
    formatVersion: COMFYUI_USER_CONFIG_FORMAT_VERSION,
    serverUrl: config.serverUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    defaultWorkflows: config.defaultWorkflows,
  });
}

export function defaultComfyUiConfig(): ComfyUiConfig {
  const shared = defaultComfyUiSharedUserConfig();
  return {
    enabled: false,
    serverUrl: shared.serverUrl,
    defaultWorkflows: shared.defaultWorkflows,
    requestTimeoutMs: shared.requestTimeoutMs,
    connectionCheckIntervalMs: 10000,
  };
}

export function normalizeComfyUiConfig(config: Partial<ComfyUiConfig> = {}): ComfyUiConfig {
  const defaults = defaultComfyUiConfig();
  return {
    ...defaults,
    ...config,
    serverUrl: normalizeComfyUiServerUrl(config.serverUrl ?? defaults.serverUrl),
    defaultWorkflows: {
      ...defaults.defaultWorkflows,
      ...config.defaultWorkflows,
    },
  };
}

export function normalizeComfyUiServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, '');
}

export function comfyUiServerIdentity(serverUrl: string): string {
  const url = new URL(normalizeComfyUiServerUrl(serverUrl));
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
}
