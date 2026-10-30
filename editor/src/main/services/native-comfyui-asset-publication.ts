import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultAssetIdFromFilename } from '../../shared/project-schema/authoring-assets';
import type {
  ComfyUiPublishedAssetOutput,
  ComfyUiPublishedFilesystemOutput,
  ComfyUiPublishedOutput,
  ComfyUiStagedAssetPublicationRequest,
} from './comfyui-publication-contracts';
import { ComfyUiRunError } from './comfyui-run-errors';

type NativeProjectCommandCall = (
  request: Readonly<Record<string, unknown>>,
) =>
  | Readonly<{ ok: boolean; error?: string; diagnostics?: unknown; fields?: unknown }>
  | Promise<Readonly<{ ok: boolean; error?: string; diagnostics?: unknown; fields?: unknown }>>;
import type {
  ComfyUiGeneratedImage,
  ComfyUiRunPlan,
  ComfyUiRunnableWorkflowEntry,
} from './comfyui-run-service';
import {
  prepareOutputPublicationTransaction,
  recoverOutputPublicationTransaction,
} from './output-publication-transaction';

/** Native-only ComfyUI publication. Never imports or instantiates a TS Project writer. */
export async function publishNativeStagedComfyUiAssets(
  request: ComfyUiStagedAssetPublicationRequest,
  native: NativeProjectCommandCall,
): Promise<Record<string, ComfyUiPublishedAssetOutput[]>> {
  if (request.assets.length === 0) return {};
  let committed;
  try {
    committed = await native({
      action: 'comfyui-assets',
      projectRoot: request.projectRoot,
      workflow: request.workflow,
      promptId: request.promptId,
      ...(request.expectedSourceGeneration
        ? { expectedSourceGeneration: request.expectedSourceGeneration }
        : {}),
      dryRun: false,
      generated: request.assets,
    });
  } catch (error) {
    throw new ComfyUiRunError('COMFYUI_ASSET_PUBLICATION_FAILED', '/outputs', String(error));
  }
  if (!committed.ok) {
    const diagnostic = (committed.diagnostics as Array<{ message?: string }> | undefined)?.[0];
    const message = diagnostic?.message ?? committed.error ?? 'Native Asset publication failed.';
    throw new ComfyUiRunError(
      /changed|revision|conflict|transaction|lock|busy/iu.test(message)
        ? 'COMFYUI_ASSET_PUBLICATION_CONFLICT'
        : 'COMFYUI_ASSET_PUBLICATION_FAILED',
      '/outputs',
      message,
    );
  }
  const fields = committed.fields as
    | {
        assets?: Array<{
          outputId: string;
          assetId: string;
          projectRelativePath: string;
          contentHash: string;
        }>;
      }
    | undefined;
  if (!Array.isArray(fields?.assets) || fields.assets.length !== request.assets.length)
    throw new ComfyUiRunError(
      'COMFYUI_ASSET_PUBLICATION_FAILED',
      '/outputs',
      'Native Asset publication returned incomplete Asset metadata.',
    );
  const published: Record<string, ComfyUiPublishedAssetOutput[]> = {};
  fields.assets.forEach((asset, index) => {
    const source = request.assets[index]!;
    if (
      asset.outputId !== source.outputId ||
      asset.contentHash !== source.output.contentHash ||
      typeof asset.assetId !== 'string' ||
      typeof asset.projectRelativePath !== 'string'
    )
      throw new ComfyUiRunError(
        'COMFYUI_ASSET_PUBLICATION_FAILED',
        '/outputs',
        'Native Asset publication metadata does not match the staged output.',
      );
    (published[source.outputId] ??= []).push({
      ...source.output,
      target: 'asset',
      assetId: asset.assetId,
      projectRelativePath: asset.projectRelativePath,
    });
  });
  return published;
}

type StagedFile = {
  outputId: string;
  output: ComfyUiGeneratedImage;
  finalPath: string;
  temporaryPath: string;
  backupPath: string | null;
  committed: boolean;
};
function extensionForFormat(format: ComfyUiGeneratedImage['format']) {
  return format === 'jpeg' ? '.jpg' : `.${format}`;
}
function extensionMatches(outputPath: string, format: ComfyUiGeneratedImage['format']) {
  const ext = path.extname(outputPath).toLowerCase();
  return format === 'jpeg' ? ext === '.jpg' || ext === '.jpeg' : ext === `.${format}`;
}
function generatedManyFilename(outputId: string, index: number, output: ComfyUiGeneratedImage) {
  const stem = defaultAssetIdFromFilename(outputId);
  const hash = output.contentHash.slice('sha256:'.length, 'sha256:'.length + 8);
  return `${stem}-${String(index + 1).padStart(2, '0')}-${hash}${extensionForFormat(output.format)}`;
}

async function rollback(staged: StagedFile[]) {
  for (const item of [...staged].reverse()) {
    if (item.committed) await fs.rm(item.finalPath, { force: true }).catch(() => undefined);
    if (item.backupPath) await fs.rename(item.backupPath, item.finalPath).catch(() => undefined);
    await fs.rm(item.temporaryPath, { force: true }).catch(() => undefined);
  }
}
async function stage(options: {
  plan: ComfyUiRunPlan;
  outputs: Record<string, ComfyUiGeneratedImage[]>;
  force: boolean;
  register?: (path: string) => Promise<void>;
}): Promise<StagedFile[]> {
  const staged: StagedFile[] = [];
  const paths = new Set<string>();
  try {
    for (const [outputId, route] of Object.entries(options.plan.routes)) {
      if (route.target !== 'filesystem') continue;
      const values = options.outputs[outputId] ?? [];
      const destinations = values.map((output, index) =>
        route.cardinality === 'one'
          ? route.path!
          : path.join(route.path!, generatedManyFilename(outputId, index, output)),
      );
      for (let index = 0; index < values.length; index++) {
        const output = values[index]!;
        const finalPath = destinations[index]!;
        if (paths.has(finalPath))
          throw new ComfyUiRunError(
            'COMFYUI_OUTPUT_DESTINATION_CONFLICT',
            `/outputs/${outputId}`,
            `Two ComfyUI results resolve to the same filesystem destination: ${finalPath}`,
          );
        paths.add(finalPath);
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
        await options.register?.(temporaryPath);
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
    await rollback(staged);
    throw error;
  }
}
async function commit(staged: StagedFile[]) {
  for (const item of staged) {
    if (item.backupPath) await fs.rename(item.finalPath, item.backupPath);
    await fs.rename(item.temporaryPath, item.finalPath);
    item.committed = true;
  }
}
async function finalize(staged: StagedFile[]) {
  for (const item of staged)
    if (item.backupPath) await fs.rm(item.backupPath, { force: true }).catch(() => undefined);
}

export async function publishNativeComfyUiOutputs(options: {
  projectRoot: string | null;
  workflow: ComfyUiRunnableWorkflowEntry;
  promptId: string;
  plan: ComfyUiRunPlan;
  outputs: Record<string, ComfyUiGeneratedImage[]>;
  force: boolean;
  expectedSourceGeneration?: string;
  nativeProjectCommands: NativeProjectCommandCall;
  registerStagedOutput?: (path: string) => Promise<void>;
  commitStagedProjectAssets?: (
    request: ComfyUiStagedAssetPublicationRequest,
  ) => Promise<Record<string, ComfyUiPublishedAssetOutput[]>>;
}): Promise<Record<string, ComfyUiPublishedOutput[]>> {
  const hasAssets = Object.values(options.plan.routes).some((route) => route.target === 'asset');
  if (!options.projectRoot && hasAssets)
    throw new ComfyUiRunError(
      'COMFYUI_ASSET_PUBLICATION_PROJECT_INVALID',
      '/project',
      'ComfyUI generation succeeded, but Asset publication requires a Project.',
    );
  const staged = await stage({
    plan: options.plan,
    outputs: options.outputs,
    force: options.force,
    register: options.registerStagedOutput,
  });
  let assets: Record<string, ComfyUiPublishedAssetOutput[]> = {};
  const stagedAssets: string[] = [];
  let transactionPath: string | null = null;
  try {
    if (hasAssets && options.projectRoot) {
      if (options.commitStagedProjectAssets && !options.registerStagedOutput)
        throw new ComfyUiRunError(
          'COMFYUI_ASSET_PUBLICATION_FAILED',
          '/outputs',
          'ComfyUI Project Asset publication requires staged-output registration.',
        );
      const generated: ComfyUiStagedAssetPublicationRequest['assets'] = [];
      for (const [outputId, route] of Object.entries(options.plan.routes)) {
        if (route.target !== 'asset') continue;
        for (const output of options.outputs[outputId] ?? []) {
          const destination = path.join(
            os.tmpdir(),
            `noveltea-comfyui-${randomUUID()}${extensionForFormat(output.format)}`,
          );
          await options.registerStagedOutput?.(destination);
          await fs.writeFile(destination, output.bytes, { flag: 'wx' });
          stagedAssets.push(destination);
          const { bytes: _bytes, ...metadata } = output;
          generated.push({ outputId, stagedPath: destination, output: metadata });
        }
      }
      if (staged.length && options.commitStagedProjectAssets) {
        transactionPath = path.join(
          os.tmpdir(),
          `noveltea-comfyui-${randomUUID()}.noveltea-publication-transaction.json`,
        );
        await prepareOutputPublicationTransaction({
          transactionPath,
          entries: staged.map((item) => ({
            finalPath: item.finalPath,
            stagedPath: item.temporaryPath,
            backupPath:
              item.backupPath ??
              path.join(
                path.dirname(item.finalPath),
                `.${path.basename(item.finalPath)}.${randomUUID()}.noveltea-backup`,
              ),
            hadPrevious: item.backupPath !== null,
          })),
          registerRecoveryPath: options.registerStagedOutput,
        });
      }
      if (!options.commitStagedProjectAssets && staged.length) await commit(staged);
      const request: ComfyUiStagedAssetPublicationRequest = {
        projectRoot: options.projectRoot,
        workflow: { id: options.workflow.id, label: options.workflow.label },
        promptId: options.promptId,
        ...(options.expectedSourceGeneration
          ? { expectedSourceGeneration: options.expectedSourceGeneration }
          : {}),
        ...(transactionPath ? { publicationTransactionPath: transactionPath } : {}),
        assets: generated,
      };
      assets = options.commitStagedProjectAssets
        ? await options.commitStagedProjectAssets(request)
        : await publishNativeStagedComfyUiAssets(request, options.nativeProjectCommands);
    } else {
      await commit(staged);
    }
    if ((!options.commitStagedProjectAssets || !hasAssets) && !transactionPath)
      await finalize(staged);
  } catch (error) {
    if (transactionPath)
      await recoverOutputPublicationTransaction(transactionPath).catch(() => undefined);
    else await rollback(staged);
    throw error;
  } finally {
    for (const file of stagedAssets) await fs.rm(file, { force: true }).catch(() => undefined);
  }
  const published: Record<string, ComfyUiPublishedOutput[]> = {};
  for (const outputId of Object.keys(options.plan.routes)) published[outputId] = [];
  for (const item of staged) {
    const { bytes: _bytes, ...metadata } = item.output;
    const record: ComfyUiPublishedFilesystemOutput = {
      ...metadata,
      target: 'filesystem',
      path: item.finalPath,
    };
    published[item.outputId]!.push(record);
  }
  for (const [outputId, values] of Object.entries(assets)) published[outputId]!.push(...values);
  return published;
}
