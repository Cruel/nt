import type { ComfyUiGeneratedImage } from './comfyui-run-service';

export interface ComfyUiPublishedAssetOutput extends Omit<ComfyUiGeneratedImage, 'bytes'> {
  target: 'asset';
  assetId: string;
  projectRelativePath: string;
}

export interface ComfyUiPublishedFilesystemOutput extends Omit<ComfyUiGeneratedImage, 'bytes'> {
  target: 'filesystem';
  path: string;
}

export type ComfyUiPublishedOutput = ComfyUiPublishedAssetOutput | ComfyUiPublishedFilesystemOutput;

export interface ComfyUiStagedAssetPublicationRequest {
  projectRoot: string;
  workflow: { id: string; label: string };
  promptId: string;
  expectedSourceGeneration?: string;
  publicationTransactionPath?: string;
  assets: Array<{
    outputId: string;
    stagedPath: string;
    output: Omit<ComfyUiGeneratedImage, 'bytes'>;
  }>;
}
