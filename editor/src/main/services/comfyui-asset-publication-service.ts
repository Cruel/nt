import { randomUUID } from 'node:crypto';
import {
  PROJECT_WORKSPACE_ABSENT_REVISION,
  ProjectWorkspaceMutationError,
  type ProjectWorkspaceFileSystem,
  type ProjectWorkspaceService,
} from '../../shared/project-workspace';
import {
  assetDataFromImportMetadata,
  defaultAssetIdFromFilename,
} from '../../shared/project-schema/authoring-assets';
import type { AssetAuthoringRecord } from '../../shared/project-schema/authoring-records';
import { ComfyUiRunError } from './comfyui-run-errors';
import type { ComfyUiGeneratedImage, ComfyUiRunnableWorkflowEntry } from './comfyui-run-service';

export interface ComfyUiPublishedAssetOutput extends Omit<ComfyUiGeneratedImage, 'bytes'> {
  target: 'asset';
  assetId: string;
  projectRelativePath: string;
}

function extensionForFormat(format: ComfyUiGeneratedImage['format']): string {
  return format === 'jpeg' ? '.jpg' : `.${format}`;
}

function generatedAssetIdentity(workflowId: string) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  const stem = defaultAssetIdFromFilename(workflowId);
  return `${stem}-${timestamp}-${randomUUID().slice(0, 8)}`;
}

export async function preflightComfyUiAssetPublication(
  projectRoot: string,
  workspace: ProjectWorkspaceService,
): Promise<void> {
  const opened = await workspace.open(projectRoot);
  if (!opened.ok)
    throw new ComfyUiRunError(
      'COMFYUI_ASSET_PROJECT_INVALID',
      '/project',
      opened.diagnostics[0]?.message ?? 'Project is not valid for Asset publication.',
    );
}

export async function publishComfyUiGeneratedAsset(options: {
  projectRoot: string;
  workspace: ProjectWorkspaceService;
  fileSystem: ProjectWorkspaceFileSystem;
  workflow: ComfyUiRunnableWorkflowEntry;
  promptId: string;
  output: ComfyUiGeneratedImage;
}): Promise<ComfyUiPublishedAssetOutput> {
  const opened = await options.workspace.open(options.projectRoot);
  if (!opened.ok)
    throw new ComfyUiRunError(
      'COMFYUI_ASSET_PUBLICATION_PROJECT_INVALID',
      '/project',
      `ComfyUI generation succeeded, but the Project could not be reopened for Asset publication: ${opened.diagnostics[0]?.message ?? 'invalid Project'}`,
    );

  const assetId = generatedAssetIdentity(options.workflow.id);
  const extension = extensionForFormat(options.output.format);
  const filename = `${assetId}${extension}`;
  const projectRelativePath = `assets/generated/${filename}`;
  const recordPath = `records/assets/${assetId}.json`;
  if (opened.snapshot.project.assets[assetId])
    throw new ComfyUiRunError(
      'COMFYUI_ASSET_PUBLICATION_CONFLICT',
      `/assets/${assetId}`,
      `ComfyUI generation succeeded, but generated Asset '${assetId}' already exists.`,
    );
  if (
    (await options.fileSystem.inspect(
      options.fileSystem.joinPath(options.projectRoot, projectRelativePath),
    )) !== 'missing'
  )
    throw new ComfyUiRunError(
      'COMFYUI_ASSET_PUBLICATION_CONFLICT',
      `/assets/${assetId}`,
      `ComfyUI generation succeeded, but generated Asset path '${projectRelativePath}' already exists.`,
    );

  const importedAt = new Date().toISOString();
  const record: AssetAuthoringRecord = {
    id: assetId,
    label: `${options.workflow.label} ${options.output.outputId}`,
    data: assetDataFromImportMetadata({
      kind: 'image',
      originalPath: `comfyui:${options.workflow.id}:${options.promptId}`,
      originalName: filename,
      projectRelativePath,
      extension,
      mimeType: options.output.mimeType,
      byteSize: options.output.byteSize,
      contentHash: options.output.contentHash,
      importedAt,
      imageMetadata: {
        width: options.output.width,
        height: options.output.height,
        hasAlpha: options.output.hasAlpha,
        orientation: 1,
      },
    }),
  };
  const candidate = structuredClone(opened.snapshot.project);
  candidate.assets[assetId] = record;

  try {
    await options.workspace.write(
      options.projectRoot,
      opened.snapshot.workspaceRevision,
      candidate,
      candidate.editor,
      opened.snapshot.scriptSourcePaths,
      {
        operationLabel: `comfyui publish ${options.workflow.id}`,
        targetFiles: [recordPath],
        expectedFileRevisions: { [recordPath]: PROJECT_WORKSPACE_ABSENT_REVISION },
        extraTargets: [
          {
            path: projectRelativePath,
            operation: 'write',
            expectedRevision: PROJECT_WORKSPACE_ABSENT_REVISION,
            bytes: options.output.bytes,
          },
        ],
      },
    );
  } catch (error) {
    const conflict =
      error instanceof ProjectWorkspaceMutationError &&
      (error.code === 'WORKSPACE_BUSY' || error.code === 'WORKSPACE_REVISION_CONFLICT');
    throw new ComfyUiRunError(
      conflict ? 'COMFYUI_ASSET_PUBLICATION_CONFLICT' : 'COMFYUI_ASSET_PUBLICATION_FAILED',
      `/assets/${assetId}`,
      `ComfyUI generation succeeded, but Project Asset publication ${conflict ? 'conflicted' : 'failed'}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const { bytes: _bytes, ...published } = options.output;
  return { ...published, target: 'asset', assetId, projectRelativePath };
}
