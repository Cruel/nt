import { useProjectStore } from '../project/project-store';
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

function currentProjectSessionId(required = false): string | null {
  const projectSessionId = useProjectStore.getState().projectSessionId;
  if (required && !projectSessionId)
    throw new Error('ComfyUI operation requires an active Project session.');
  return projectSessionId;
}

export async function listComfyUiWorkflowLibrary(
  request: ComfyUiWorkflowLibraryListRequest = {},
): Promise<ComfyUiWorkflowLibraryListResponse> {
  const { projectFilePath, ...ipcRequest } = request;
  return window.noveltea.listComfyUiWorkflowLibrary(
    projectFilePath ? currentProjectSessionId() : null,
    ipcRequest,
  );
}

export async function copyComfyUiWorkflow(
  request: ComfyUiWorkflowCopyRequest,
): Promise<ComfyUiWorkflowCopyResponse> {
  const { projectFilePath, ...ipcRequest } = request;
  const requiresProject =
    Boolean(projectFilePath) ||
    request.targetSource === 'project' ||
    request.workflowKey.startsWith('project:');
  return window.noveltea.copyComfyUiWorkflow(
    requiresProject ? currentProjectSessionId(true) : null,
    ipcRequest,
  );
}

export async function deleteComfyUiWorkflow(
  request: ComfyUiWorkflowDeleteRequest,
): Promise<ComfyUiWorkflowDeleteResponse> {
  const { projectFilePath, ...ipcRequest } = request;
  const requiresProject = Boolean(projectFilePath) || request.workflowKey.startsWith('project:');
  return window.noveltea.deleteComfyUiWorkflow(
    requiresProject ? currentProjectSessionId(true) : null,
    ipcRequest,
  );
}

export async function renameComfyUiWorkflow(
  request: import('../../shared/comfyui-workflows').ComfyUiWorkflowRenameRequest,
): Promise<import('../../shared/comfyui-workflows').ComfyUiWorkflowRenameResponse> {
  const { projectFilePath, ...ipcRequest } = request;
  const requiresProject = Boolean(projectFilePath) || request.workflowKey.startsWith('project:');
  return window.noveltea.renameComfyUiWorkflow(
    requiresProject ? currentProjectSessionId(true) : null,
    ipcRequest,
  );
}

export async function importComfyUiWorkflowToLibrary(
  request: ComfyUiImportWorkflowToLibraryRequest,
): Promise<ComfyUiImportWorkflowToLibraryResponse> {
  return window.noveltea.importComfyUiWorkflowToLibrary(request);
}

export async function repairComfyUiWorkflowInLibrary(
  request: ComfyUiRepairWorkflowInLibraryRequest,
): Promise<ComfyUiRepairWorkflowInLibraryResponse> {
  const { projectFilePath, ...ipcRequest } = request;
  const requiresProject = Boolean(projectFilePath) || request.workflowKey.startsWith('project:');
  return window.noveltea.repairComfyUiWorkflowInLibrary(
    requiresProject ? currentProjectSessionId(true) : null,
    ipcRequest,
  );
}

export async function revealComfyUiWorkflow(
  workflowKey: ComfyUiWorkflowKey,
  projectFilePath?: string | null,
): Promise<boolean> {
  const requiresProject = Boolean(projectFilePath) || workflowKey.startsWith('project:');
  return window.noveltea.revealComfyUiWorkflow(
    requiresProject ? currentProjectSessionId(true) : null,
    workflowKey,
  );
}

export async function verifyComfyUiWorkflowLibrary(
  request: ComfyUiVerifyWorkflowLibraryRequest,
): Promise<ComfyUiVerifyWorkflowLibraryResponse> {
  const { projectFilePath, ...ipcRequest } = request;
  return window.noveltea.verifyComfyUiWorkflowLibrary(
    projectFilePath ? currentProjectSessionId() : null,
    ipcRequest,
  );
}

export async function analyzeComfyUiWorkflowImport(
  request: ComfyUiAnalyzeWorkflowImportRequest,
): Promise<ComfyUiAnalyzeWorkflowImportResponse> {
  const { projectFilePath, ...ipcRequest } = request;
  return window.noveltea.analyzeComfyUiWorkflowImport(
    projectFilePath ? currentProjectSessionId() : null,
    ipcRequest,
  );
}

export async function generateComfyUiImage(
  config: ComfyUiConfig,
  request: ComfyUiGenerateImageRequest,
): Promise<ComfyUiImageJobResponse> {
  const { projectFilePath: _projectFilePath, ...ipcRequest } = request;
  return window.noveltea.generateComfyUiImage(currentProjectSessionId(true)!, config, ipcRequest);
}

export async function editComfyUiImage(
  config: ComfyUiConfig,
  request: ComfyUiEditImageRequest,
): Promise<ComfyUiImageJobResponse> {
  const { projectFilePath: _projectFilePath, ...ipcRequest } = request;
  return window.noveltea.editComfyUiImage(currentProjectSessionId(true)!, config, ipcRequest);
}

export async function cancelComfyUiJob(config: ComfyUiConfig): Promise<ComfyUiCancelJobResponse> {
  return window.noveltea.cancelComfyUiJob(currentProjectSessionId(true)!, config);
}

export function subscribeComfyUiProgress(
  callback: (progress: ComfyUiQueueProgress) => void,
): () => void {
  return window.noveltea.onComfyUiProgress(callback);
}

export function bestComfyUiErrorMessage(response: {
  error?: string | null;
  diagnostics?: Array<{ message?: string | null }>;
}): string {
  return (
    response.diagnostics?.find((diagnostic) => diagnostic.message && diagnostic.message !== 'error')
      ?.message ??
    (response.error && response.error !== 'error' ? response.error : null) ??
    'ComfyUI operation failed.'
  );
}
