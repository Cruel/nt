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
  ComfyUiImportWorkflowToLibraryRequest,
  ComfyUiImportWorkflowToLibraryResponse,
  ComfyUiRepairWorkflowInLibraryRequest,
  ComfyUiRepairWorkflowInLibraryResponse,
  ComfyUiVerifyWorkflowLibraryRequest,
  ComfyUiVerifyWorkflowLibraryResponse,
  ComfyUiWorkflowCopyRequest,
  ComfyUiWorkflowCopyResponse,
  ComfyUiWorkflowDeleteRequest,
  ComfyUiWorkflowDeleteResponse,
  ComfyUiWorkflowKey,
  ComfyUiWorkflowLibraryListRequest,
  ComfyUiWorkflowLibraryListResponse,
} from '../../shared/comfyui-workflows';

export async function checkComfyUiConnection(config: ComfyUiConfig): Promise<ComfyUiStatus> {
  return window.noveltea.checkComfyUiConnection(config);
}

export async function getComfyUiQueue(config: ComfyUiConfig): Promise<ComfyUiQueueProgress> {
  return window.noveltea.getComfyUiQueue(config);
}


export async function listComfyUiWorkflowLibrary(request: ComfyUiWorkflowLibraryListRequest = {}): Promise<ComfyUiWorkflowLibraryListResponse> {
  return window.noveltea.listComfyUiWorkflowLibrary(request);
}

export async function copyComfyUiWorkflow(request: ComfyUiWorkflowCopyRequest): Promise<ComfyUiWorkflowCopyResponse> {
  return window.noveltea.copyComfyUiWorkflow(request);
}

export async function deleteComfyUiWorkflow(request: ComfyUiWorkflowDeleteRequest): Promise<ComfyUiWorkflowDeleteResponse> {
  return window.noveltea.deleteComfyUiWorkflow(request);
}

export async function importComfyUiWorkflowToLibrary(request: ComfyUiImportWorkflowToLibraryRequest): Promise<ComfyUiImportWorkflowToLibraryResponse> {
  return window.noveltea.importComfyUiWorkflowToLibrary(request);
}

export async function repairComfyUiWorkflowInLibrary(request: ComfyUiRepairWorkflowInLibraryRequest): Promise<ComfyUiRepairWorkflowInLibraryResponse> {
  return window.noveltea.repairComfyUiWorkflowInLibrary(request);
}

export async function revealComfyUiWorkflow(workflowKey: ComfyUiWorkflowKey, projectFilePath?: string | null): Promise<boolean> {
  return window.noveltea.revealComfyUiWorkflow(workflowKey, projectFilePath);
}

export async function verifyComfyUiWorkflowLibrary(request: ComfyUiVerifyWorkflowLibraryRequest): Promise<ComfyUiVerifyWorkflowLibraryResponse> {
  return window.noveltea.verifyComfyUiWorkflowLibrary(request);
}


export async function analyzeComfyUiWorkflowImport(request: ComfyUiAnalyzeWorkflowImportRequest): Promise<ComfyUiAnalyzeWorkflowImportResponse> {
  return window.noveltea.analyzeComfyUiWorkflowImport(request);
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
