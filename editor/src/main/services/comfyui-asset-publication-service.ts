import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
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
import type {
  ComfyUiGeneratedImage,
  ComfyUiRunPlan,
  ComfyUiRunnableWorkflowEntry,
} from './comfyui-run-service';

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

function extensionForFormat(format: ComfyUiGeneratedImage['format']): string {
  return format === 'jpeg' ? '.jpg' : `.${format}`;
}

function extensionMatches(outputPath: string, format: ComfyUiGeneratedImage['format']) {
  const extension = path.extname(outputPath).toLowerCase();
  if (format === 'jpeg') return extension === '.jpg' || extension === '.jpeg';
  return extension === `.${format}`;
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

function generatedManyFilename(outputId: string, index: number, output: ComfyUiGeneratedImage) {
  const stem = defaultAssetIdFromFilename(outputId);
  const digest = output.contentHash.slice('sha256:'.length, 'sha256:'.length + 8);
  return `${stem}-${String(index + 1).padStart(2, '0')}-${digest}${extensionForFormat(output.format)}`;
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

interface PlannedAsset {
  outputId: string;
  output: ComfyUiGeneratedImage;
  assetId: string;
  projectRelativePath: string;
  recordPath: string;
  record: AssetAuthoringRecord;
}

interface StagedFile {
  outputId: string;
  output: ComfyUiGeneratedImage;
  finalPath: string;
  temporaryPath: string;
  backupPath: string | null;
  committed: boolean;
}

async function rollbackFilesystem(staged: StagedFile[]) {
  for (const item of [...staged].reverse()) {
    if (item.committed) await fs.rm(item.finalPath, { force: true }).catch(() => undefined);
    if (item.backupPath) await fs.rename(item.backupPath, item.finalPath).catch(() => undefined);
    await fs.rm(item.temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function stageFilesystemOutputs(options: {
  plan: ComfyUiRunPlan;
  outputs: Record<string, ComfyUiGeneratedImage[]>;
  force: boolean;
}): Promise<StagedFile[]> {
  const staged: StagedFile[] = [];
  const finalPaths = new Set<string>();
  try {
    for (const [outputId, route] of Object.entries(options.plan.routes)) {
      if (route.target !== 'filesystem') continue;
      const values = options.outputs[outputId] ?? [];
      const destinations = values.map((output, index) =>
        route.cardinality === 'one'
          ? route.path!
          : path.join(route.path!, generatedManyFilename(outputId, index, output)),
      );
      for (let index = 0; index < values.length; index += 1) {
        const output = values[index]!;
        const finalPath = destinations[index]!;
        if (finalPaths.has(finalPath))
          throw new ComfyUiRunError(
            'COMFYUI_OUTPUT_DESTINATION_CONFLICT',
            `/outputs/${outputId}`,
            `Two ComfyUI results resolve to the same filesystem destination: ${finalPath}`,
          );
        finalPaths.add(finalPath);
        if (!extensionMatches(finalPath, output.format))
          throw new ComfyUiRunError(
            'COMFYUI_OUTPUT_EXTENSION',
            `/outputs/${outputId}`,
            `Destination '${finalPath}' does not match returned ${output.format} image format.`,
          );
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        let exists = false;
        try {
          const stat = await fs.lstat(finalPath);
          exists = true;
          if (stat.isDirectory())
            throw new ComfyUiRunError(
              'COMFYUI_OUTPUT_DESTINATION_INVALID',
              `/outputs/${outputId}`,
              `Output destination is a directory: ${finalPath}`,
            );
        } catch (error) {
          if (error instanceof ComfyUiRunError) throw error;
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (exists && !options.force)
          throw new ComfyUiRunError(
            'COMFYUI_OUTPUT_EXISTS',
            `/outputs/${outputId}`,
            `Output destination already exists: ${finalPath}`,
          );
        const temporaryPath = path.join(
          path.dirname(finalPath),
          `.${path.basename(finalPath)}.${randomUUID()}.noveltea-stage`,
        );
        await fs.writeFile(temporaryPath, output.bytes, { flag: 'wx' });
        staged.push({
          outputId,
          output,
          finalPath,
          temporaryPath,
          backupPath: exists
            ? path.join(
                path.dirname(finalPath),
                `.${path.basename(finalPath)}.${randomUUID()}.noveltea-backup`,
              )
            : null,
          committed: false,
        });
      }
    }
    return staged;
  } catch (error) {
    await rollbackFilesystem(staged);
    throw error;
  }
}

async function commitFilesystem(staged: StagedFile[]) {
  for (const item of staged) {
    if (item.backupPath) await fs.rename(item.finalPath, item.backupPath);
    await fs.rename(item.temporaryPath, item.finalPath);
    item.committed = true;
  }
}

async function finalizeFilesystem(staged: StagedFile[]) {
  for (const item of staged)
    if (item.backupPath) await fs.rm(item.backupPath, { force: true }).catch(() => undefined);
}

async function planAssets(options: {
  projectRoot: string;
  workspace: ProjectWorkspaceService;
  fileSystem: ProjectWorkspaceFileSystem;
  workflow: ComfyUiRunnableWorkflowEntry;
  promptId: string;
  plan: ComfyUiRunPlan;
  outputs: Record<string, ComfyUiGeneratedImage[]>;
}) {
  const hasAssets = Object.values(options.plan.routes).some((route) => route.target === 'asset');
  if (!hasAssets) return null;
  const opened = await options.workspace.open(options.projectRoot);
  if (!opened.ok)
    throw new ComfyUiRunError(
      'COMFYUI_ASSET_PUBLICATION_PROJECT_INVALID',
      '/project',
      `ComfyUI generation succeeded, but the Project could not be reopened for Asset publication: ${opened.diagnostics[0]?.message ?? 'invalid Project'}`,
    );

  const candidate = structuredClone(opened.snapshot.project);
  const planned: PlannedAsset[] = [];
  const importedAt = new Date().toISOString();
  for (const [outputId, route] of Object.entries(options.plan.routes)) {
    if (route.target !== 'asset') continue;
    for (const output of options.outputs[outputId] ?? []) {
      let assetId: string;
      do assetId = generatedAssetIdentity(options.workflow.id);
      while (candidate.assets[assetId]);
      const extension = extensionForFormat(output.format);
      const filename = `${assetId}${extension}`;
      const projectRelativePath = `assets/generated/${filename}`;
      const recordPath = `records/assets/${assetId}.json`;
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
      const record: AssetAuthoringRecord = {
        id: assetId,
        label: `${options.workflow.label} ${outputId}`,
        data: assetDataFromImportMetadata({
          kind: 'image',
          originalPath: `comfyui:${options.workflow.id}:${options.promptId}`,
          originalName: filename,
          projectRelativePath,
          extension,
          mimeType: output.mimeType,
          byteSize: output.byteSize,
          contentHash: output.contentHash,
          importedAt,
          imageMetadata: {
            width: output.width,
            height: output.height,
            hasAlpha: output.hasAlpha,
            orientation: 1,
          },
        }),
      };
      candidate.assets[assetId] = record;
      planned.push({ outputId, output, assetId, projectRelativePath, recordPath, record });
    }
  }
  return { opened, candidate, planned };
}

async function assetPlanWasCommitted(
  projectRoot: string,
  workspace: ProjectWorkspaceService,
  planned: PlannedAsset[],
): Promise<boolean> {
  const reopened = await workspace.open(projectRoot).catch(() => null);
  if (!reopened?.ok) return false;
  return planned.every((asset) => {
    const current = reopened.snapshot.project.assets[asset.assetId];
    return (
      current?.data.contentHash === asset.output.contentHash &&
      current.data.source.type === 'project-file' &&
      current.data.source.path === asset.projectRelativePath
    );
  });
}

export async function publishComfyUiOutputs(options: {
  projectRoot: string | null;
  workspace: ProjectWorkspaceService;
  fileSystem: ProjectWorkspaceFileSystem;
  workflow: ComfyUiRunnableWorkflowEntry;
  promptId: string;
  plan: ComfyUiRunPlan;
  outputs: Record<string, ComfyUiGeneratedImage[]>;
  force: boolean;
}): Promise<Record<string, ComfyUiPublishedOutput[]>> {
  const hasAssetRoutes = Object.values(options.plan.routes).some(
    (route) => route.target === 'asset',
  );
  const assetPlan =
    options.projectRoot && hasAssetRoutes
      ? await planAssets({
          projectRoot: options.projectRoot,
          workspace: options.workspace,
          fileSystem: options.fileSystem,
          workflow: options.workflow,
          promptId: options.promptId,
          plan: options.plan,
          outputs: options.outputs,
        })
      : null;
  if (
    !options.projectRoot &&
    Object.values(options.plan.routes).some((route) => route.target === 'asset')
  )
    throw new ComfyUiRunError(
      'COMFYUI_ASSET_PUBLICATION_PROJECT_INVALID',
      '/project',
      'ComfyUI generation succeeded, but Asset publication requires a Project.',
    );

  const staged = await stageFilesystemOutputs({
    plan: options.plan,
    outputs: options.outputs,
    force: options.force,
  });
  try {
    await commitFilesystem(staged);
    if (assetPlan && options.projectRoot) {
      const expectedFileRevisions = Object.fromEntries(
        assetPlan.planned.map((asset) => [asset.recordPath, PROJECT_WORKSPACE_ABSENT_REVISION]),
      );
      try {
        await options.workspace.write(
          options.projectRoot,
          assetPlan.opened.snapshot.workspaceRevision,
          assetPlan.candidate,
          assetPlan.candidate.editor,
          assetPlan.opened.snapshot.scriptSourcePaths,
          {
            operationLabel: `comfyui publish ${options.workflow.id}`,
            targetFiles: assetPlan.planned.map((asset) => asset.recordPath),
            expectedFileRevisions,
            extraTargets: assetPlan.planned.map((asset) => ({
              path: asset.projectRelativePath,
              operation: 'write' as const,
              expectedRevision: PROJECT_WORKSPACE_ABSENT_REVISION,
              bytes: asset.output.bytes,
            })),
          },
        );
      } catch (error) {
        if (
          !(await assetPlanWasCommitted(options.projectRoot, options.workspace, assetPlan.planned))
        ) {
          const conflict =
            error instanceof ProjectWorkspaceMutationError &&
            (error.code === 'WORKSPACE_BUSY' || error.code === 'WORKSPACE_REVISION_CONFLICT');
          throw new ComfyUiRunError(
            conflict ? 'COMFYUI_ASSET_PUBLICATION_CONFLICT' : 'COMFYUI_ASSET_PUBLICATION_FAILED',
            '/outputs',
            `ComfyUI generation succeeded, but Project Asset publication ${conflict ? 'conflicted' : 'failed'}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    await finalizeFilesystem(staged);
  } catch (error) {
    await rollbackFilesystem(staged);
    throw error;
  }

  const published: Record<string, ComfyUiPublishedOutput[]> = {};
  for (const outputId of Object.keys(options.plan.routes)) published[outputId] = [];
  for (const item of staged) {
    const { bytes: _bytes, ...metadata } = item.output;
    published[item.outputId]!.push({ ...metadata, target: 'filesystem', path: item.finalPath });
  }
  for (const asset of assetPlan?.planned ?? []) {
    const { bytes: _bytes, ...metadata } = asset.output;
    published[asset.outputId]!.push({
      ...metadata,
      target: 'asset',
      assetId: asset.assetId,
      projectRelativePath: asset.projectRelativePath,
    });
  }
  return published;
}
