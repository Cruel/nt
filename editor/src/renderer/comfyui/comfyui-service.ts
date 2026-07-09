import type { ComfyUiConfig, ComfyUiQueueProgress, ComfyUiStatus } from '../../shared/comfyui';
import type {
  ComfyUiCancelJobResponse,
  ComfyUiEditImageRequest,
  ComfyUiGenerateImageRequest,
  ComfyUiImageJobResponse,
} from '../../shared/comfyui-generation';
import type {
  ComfyUiAnalyzeWorkflowImportRequest,
  ComfyUiAnalyzeWorkflowImportResponse,
  ComfyUiInstallStarterWorkflowsResponse,
  ComfyUiSaveImportedWorkflowRequest,
  ComfyUiSaveImportedWorkflowResponse,
  ComfyUiWorkflowListResponse,
} from '../../shared/comfyui-workflows';

export async function checkComfyUiConnection(config: ComfyUiConfig): Promise<ComfyUiStatus> {
  return window.noveltea.checkComfyUiConnection(config);
}

export async function getComfyUiQueue(config: ComfyUiConfig): Promise<ComfyUiQueueProgress> {
  return window.noveltea.getComfyUiQueue(config);
}

export async function listComfyUiWorkflows(projectFilePath: string): Promise<ComfyUiWorkflowListResponse> {
  return window.noveltea.listComfyUiWorkflows(projectFilePath);
}

export async function installComfyUiStarterWorkflows(projectFilePath: string): Promise<ComfyUiInstallStarterWorkflowsResponse> {
  return window.noveltea.installComfyUiStarterWorkflows(projectFilePath);
}

export async function analyzeComfyUiWorkflowImport(request: ComfyUiAnalyzeWorkflowImportRequest): Promise<ComfyUiAnalyzeWorkflowImportResponse> {
  return window.noveltea.analyzeComfyUiWorkflowImport(request);
}

export async function saveImportedComfyUiWorkflow(request: ComfyUiSaveImportedWorkflowRequest): Promise<ComfyUiSaveImportedWorkflowResponse> {
  return window.noveltea.saveImportedComfyUiWorkflow(request);
}

export async function generateComfyUiImage(
  config: ComfyUiConfig,
  request: ComfyUiGenerateImageRequest,
): Promise<ComfyUiImageJobResponse> {
  return window.noveltea.generateComfyUiImage(config, request);
}

export async function editComfyUiImage(
  config: ComfyUiConfig,
  request: ComfyUiEditImageRequest,
): Promise<ComfyUiImageJobResponse> {
  return window.noveltea.editComfyUiImage(config, request);
}

export async function cancelComfyUiJob(config: ComfyUiConfig): Promise<ComfyUiCancelJobResponse> {
  return window.noveltea.cancelComfyUiJob(config);
}

export function subscribeComfyUiProgress(callback: (progress: ComfyUiQueueProgress) => void): () => void {
  return window.noveltea.onComfyUiProgress(callback);
}

export function bestComfyUiErrorMessage(response: {
  error?: string | null;
  diagnostics?: Array<{ message?: string | null }>;
}): string {
  return response.diagnostics?.find((diagnostic) => diagnostic.message && diagnostic.message !== 'error')?.message
    ?? (response.error && response.error !== 'error' ? response.error : null)
    ?? 'ComfyUI operation failed.';
}
