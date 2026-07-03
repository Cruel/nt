import type { ImportedAssetMetadata } from './asset-import';
import type { ToolDiagnostic } from './editor-tooling';
import type { ComfyUiWorkflowId } from './comfyui-workflows';

export interface ComfyUiGenerateImageRequest {
  projectFilePath: string;
  workflowId: ComfyUiWorkflowId;
  prompt: string;
  clientJobId?: string;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
}

export interface ComfyUiEditImageRequest {
  projectFilePath: string;
  workflowId: ComfyUiWorkflowId;
  sourceAssetId?: string;
  sourceProjectRelativePath: string;
  prompt: string;
  clientJobId?: string;
  seed?: number;
  steps?: number;
}

export interface ComfyUiGeneratedAsset {
  asset: ImportedAssetMetadata;
  previewUrl: string;
  absolutePath: string;
  projectRelativePath: string;
  promptId: string;
  workflowId: ComfyUiWorkflowId;
  seed?: number;
  prompt: string;
  createdAt: string;
}

export interface ComfyUiImageJobResponse {
  ok: boolean;
  success: boolean;
  promptId?: string;
  assets: ComfyUiGeneratedAsset[];
  diagnostics: ToolDiagnostic[];
  error?: string;
}

export interface ComfyUiCancelJobResponse {
  ok: boolean;
  success: boolean;
  error?: string;
}
