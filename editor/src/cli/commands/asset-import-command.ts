import path from 'node:path';
import { inspectImage } from '../../main/services/image-inspection-service';
import type { ImportedAssetMetadata } from '../../shared/asset-import';
import {
  assetDataFromImportMetadata,
  assetFolderForKind,
  defaultAssetIdFromFilename,
  inferAssetKindFromExtension,
  parseAssetData,
  sanitizeAssetFilename,
  type AssetKind,
  type ImageAssetMetadata,
} from '../../shared/project-schema/authoring-assets';
import type { AssetAuthoringRecord } from '../../shared/project-schema/authoring-records';
import { PROJECT_WORKSPACE_ABSENT_REVISION } from '../../shared/project-workspace';
import { sha256PrefixedBytes } from '../../shared/web-crypto';
import { cliDiagnostic } from '../contracts';
import type { CliSemanticResult } from '../semantic-project';
import type { CliCommandContext, CliCommandDefinition } from './types';
import { CliCommandUsageError, parseCommandFlags } from './types';

function slashPath(value: string): string {
  return value.split(path.sep).join('/');
}

function isContained(root: string, candidate: string): boolean {
  const relation = path.relative(root, candidate);
  return relation === '' || (!relation.startsWith('..') && !path.isAbsolute(relation));
}

function mimeForExtension(extension: string): string | undefined {
  switch (extension.toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.ttf':
      return 'font/ttf';
    case '.otf':
      return 'font/otf';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
      return 'audio/ogg';
    case '.wav':
      return 'audio/wav';
    case '.lua':
      return 'text/x-lua';
    case '.json':
      return 'application/json';
    case '.txt':
      return 'text/plain';
    default:
      return undefined;
  }
}

function uniqueAssetId(
  project: CliCommandContext['snapshot']['project'],
  filename: string,
): string {
  const base = defaultAssetIdFromFilename(filename);
  if (!project.assets[base]) return base;
  let index = 2;
  while (project.assets[`${base}-${index}`]) index += 1;
  return `${base}-${index}`;
}

function existingAssetForPath(
  project: CliCommandContext['snapshot']['project'],
  projectRelativePath: string,
): Readonly<{ assetId: string; record: AssetAuthoringRecord }> | null {
  for (const [assetId, record] of Object.entries(project.assets)) {
    const data = parseAssetData(record.data);
    if (data?.source.type === 'project-file' && data.source.path === projectRelativePath)
      return { assetId, record };
  }
  return null;
}

function outputForRecord(
  assetId: string,
  record: AssetAuthoringRecord,
  alreadyImported: boolean,
): Readonly<Record<string, unknown>> {
  const data = parseAssetData(record.data)!;
  return {
    assetId,
    projectRelativePath: data.source.path,
    kind: data.kind,
    contentHash: data.contentHash,
    ...(data.kind === 'image' && data.imageMetadata
      ? {
          width: data.imageMetadata.width,
          height: data.imageMetadata.height,
          hasAlpha: data.imageMetadata.hasAlpha,
          orientation: data.imageMetadata.orientation,
        }
      : {}),
    alreadyImported,
  };
}

function imageOrientation(value: unknown): ImageAssetMetadata['orientation'] {
  return value === 2 ||
    value === 3 ||
    value === 4 ||
    value === 5 ||
    value === 6 ||
    value === 7 ||
    value === 8
    ? value
    : 1;
}

async function metadataForSource(
  sourceAbsolute: string,
  originalName: string,
  projectRelativePath: string,
  kind: AssetKind,
  bytes: Uint8Array,
): Promise<ImportedAssetMetadata> {
  const extension = path.extname(originalName).toLowerCase();
  const common = {
    originalPath: sourceAbsolute,
    originalName,
    projectRelativePath,
    extension,
    mimeType: mimeForExtension(extension),
    byteSize: bytes.byteLength,
    contentHash: await sha256PrefixedBytes(bytes),
    importedAt: new Date().toISOString(),
  };
  if (kind !== 'image') return { ...common, kind, imageMetadata: null };
  const inspection = inspectImage(sourceAbsolute);
  if (!inspection) throw new Error('Image inspection is unavailable in this CLI host.');
  const image = await inspection;
  if (!Number.isSafeInteger(image.width) || image.width <= 0 || image.width > 65535)
    throw new Error('Image width must be between 1 and 65535 pixels.');
  if (!Number.isSafeInteger(image.height) || image.height <= 0 || image.height > 65535)
    throw new Error('Image height must be between 1 and 65535 pixels.');
  return {
    ...common,
    kind,
    imageMetadata: {
      width: image.width,
      height: image.height,
      hasAlpha: image.hasAlpha,
      orientation: imageOrientation(image.orientation),
    },
  };
}

async function uniqueProjectAssetPath(
  context: CliCommandContext,
  kind: AssetKind,
  filename: string,
  plannedPaths: Set<string>,
): Promise<string> {
  const parsed = path.parse(sanitizeAssetFilename(filename));
  const directory = assetFolderForKind(kind);
  let index = 1;
  for (;;) {
    const candidateFilename =
      index === 1 ? `${parsed.name}${parsed.ext}` : `${parsed.name}-${index}${parsed.ext}`;
    const candidate = slashPath(path.posix.join(directory, candidateFilename));
    const absolute = context.fileSystem.joinPath(context.snapshot.projectRoot, candidate);
    if (!plannedPaths.has(candidate) && (await context.fileSystem.inspect(absolute)) === 'missing')
      return candidate;
    index += 1;
  }
}

async function importAssets(
  context: CliCommandContext,
  values: readonly string[],
  dryRun: boolean,
): Promise<CliSemanticResult> {
  const projectRoot = context.snapshot.projectRoot;
  const projectReal = await context.fileSystem.realpath(projectRoot);
  const assetsRoot = context.fileSystem.joinPath(projectRoot, 'assets');
  const assetsReal =
    (await context.fileSystem.inspect(assetsRoot)) === 'directory'
      ? await context.fileSystem.realpath(assetsRoot)
      : null;
  const usableAssetsReal = assetsReal && isContained(projectReal, assetsReal) ? assetsReal : null;
  const candidate = structuredClone(context.snapshot.project);
  const outputs: Readonly<Record<string, unknown>>[] = [];
  const diagnostics = [];
  const plannedPaths = new Set(
    Object.values(candidate.assets).flatMap((record) => {
      const data = parseAssetData(record.data);
      return data?.source.type === 'project-file' ? [data.source.path] : [];
    }),
  );
  const externalTargets: Array<{
    path: string;
    operation: 'write';
    expectedRevision: typeof PROJECT_WORKSPACE_ABSENT_REVISION;
    bytes: Uint8Array;
  }> = [];
  const resolvedSources = new Set<string>();
  let addedRecords = 0;

  for (const value of values) {
    const sourceAbsolute = path.resolve(context.cwd, value);
    try {
      if ((await context.fileSystem.inspect(sourceAbsolute)) !== 'file')
        throw new Error('Asset import source is not a file.');
      const sourceReal = await context.fileSystem.realpath(sourceAbsolute);
      if (resolvedSources.has(sourceReal)) continue;
      resolvedSources.add(sourceReal);

      const insideAssets = usableAssetsReal ? isContained(usableAssetsReal, sourceReal) : false;
      let projectRelativePath: string;
      let bytes: Uint8Array;
      const originalName = path.basename(sourceAbsolute);
      const kind = inferAssetKindFromExtension(originalName);

      if (insideAssets) {
        projectRelativePath = slashPath(path.relative(projectReal, sourceReal));
        const existing = existingAssetForPath(candidate, projectRelativePath);
        if (existing) {
          outputs.push(outputForRecord(existing.assetId, existing.record, true));
          continue;
        }
        bytes = await context.fileSystem.readBytes(sourceAbsolute);
      } else {
        projectRelativePath = await uniqueProjectAssetPath(
          context,
          kind,
          originalName,
          plannedPaths,
        );
        plannedPaths.add(projectRelativePath);
        bytes = await context.fileSystem.readBytes(sourceAbsolute);
        externalTargets.push({
          path: projectRelativePath,
          operation: 'write',
          expectedRevision: PROJECT_WORKSPACE_ABSENT_REVISION,
          bytes,
        });
      }

      const metadata = await metadataForSource(
        sourceAbsolute,
        originalName,
        projectRelativePath,
        kind,
        bytes,
      );
      const assetId = uniqueAssetId(candidate, originalName);
      const record: AssetAuthoringRecord = {
        id: assetId,
        label: originalName.replace(/\.[^.]*$/, ''),
        data: assetDataFromImportMetadata(metadata),
      };
      candidate.assets[assetId] = record;
      addedRecords += 1;
      outputs.push(outputForRecord(assetId, record, false));
    } catch (error) {
      diagnostics.push(
        cliDiagnostic(
          'asset.import.failed',
          sourceAbsolute,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  if (diagnostics.length > 0)
    return { ok: false, diagnostics, fields: { dryRun, assets: outputs } };

  if (!dryRun && addedRecords > 0) {
    await context.workspace.write(
      projectRoot,
      context.snapshot.workspaceRevision,
      candidate,
      candidate.editor,
      context.snapshot.scriptSourcePaths,
      {
        operationLabel: 'cli asset import',
        extraTargets: externalTargets,
      },
    );
  }

  return {
    ok: true,
    diagnostics: [],
    humanSuccess: `${dryRun ? 'Planned' : 'Resolved'} ${outputs.length} Asset${outputs.length === 1 ? '' : 's'}.`,
    fields: { dryRun, assets: outputs },
  };
}

export const assetImportCommand: CliCommandDefinition = {
  path: ['asset', 'import'],
  parse(arguments_) {
    const parsed = parseCommandFlags(arguments_, ['--dry-run']);
    if (parsed.positionals.length === 0)
      throw new CliCommandUsageError('Usage: noveltea asset import <path>... [--dry-run]');
    const dryRun = parsed.flags.has('--dry-run');
    return {
      dryRun,
      mutation: true,
      run: (context) => importAssets(context, parsed.positionals, dryRun),
    };
  },
};
