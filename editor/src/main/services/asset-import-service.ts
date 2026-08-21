import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import sharp from 'sharp';
import type {
  AssetImportOptions,
  AssetImportResponse,
  AssetReimportResponse,
  ImportedAssetMetadata,
} from '../../shared/asset-import';
import {
  assetFolderForKind,
  defaultAssetIdFromFilename,
  inferAssetKindFromExtension,
} from '../../shared/project-schema/authoring-assets';
import {
  PROJECT_WORKSPACE_ABSENT_REVISION,
  type ProjectWorkspaceExpectedRevision,
} from '../../shared/project-workspace/project-workspace-transaction';
import {
  readProjectAssetFileRevision,
  writeProjectAssetFileTransaction,
} from './project-asset-file-transaction';

function projectRootFromFile(projectFilePath: string): string {
  return path.dirname(path.resolve(projectFilePath));
}

export function sanitizeAssetFilename(filename: string): string {
  const parsed = path.parse(filename);
  const stem = defaultAssetIdFromFilename(parsed.name || filename);
  const extension = parsed.ext.toLowerCase();
  return `${stem}${extension}`;
}

function slashPath(value: string): string {
  return value.split(path.sep).join('/');
}

async function uniqueDestination(directory: string, filename: string): Promise<string> {
  const parsed = path.parse(filename);
  let candidate = path.join(directory, filename);
  let index = 2;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(directory, `${parsed.name}-${index}${parsed.ext}`);
      index += 1;
    } catch {
      return candidate;
    }
  }
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

async function copyAssetIntoProject(
  projectFilePath: string,
  sourcePath: string,
  replacement?: Readonly<{
    path: string;
    expectedRevision: ProjectWorkspaceExpectedRevision;
  }>,
  assertAuthority?: () => void,
): Promise<ImportedAssetMetadata> {
  const projectRoot = projectRootFromFile(projectFilePath);
  const sourceAbsolute = path.resolve(sourcePath);
  const sourceStat = await fs.stat(sourceAbsolute);
  if (!sourceStat.isFile()) throw new Error('Asset import source is not a file.');
  const extension = path.extname(sourceAbsolute).toLowerCase();
  const kind = inferAssetKindFromExtension(extension);
  const targetRelativeDirectory = replacement
    ? path.dirname(replacement.path)
    : assetFolderForKind(kind);
  const targetDirectory = path.resolve(projectRoot, targetRelativeDirectory);
  if (!targetDirectory.startsWith(projectRoot))
    throw new Error('Asset target path escapes the project directory.');
  const targetFilename = replacement
    ? path.basename(replacement.path)
    : sanitizeAssetFilename(path.basename(sourceAbsolute));
  const destination = replacement
    ? path.join(targetDirectory, targetFilename)
    : await uniqueDestination(targetDirectory, targetFilename);
  const bytes = await fs.readFile(sourceAbsolute);
  assertAuthority?.();
  await writeProjectAssetFileTransaction(
    projectRoot,
    slashPath(path.relative(projectRoot, destination)),
    bytes,
    replacement ? 'asset reimport' : 'asset import',
    replacement?.expectedRevision ?? PROJECT_WORKSPACE_ABSENT_REVISION,
  );
  const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const common = {
    originalPath: sourceAbsolute,
    originalName: path.basename(sourceAbsolute),
    projectRelativePath: slashPath(path.relative(projectRoot, destination)),
    extension,
    mimeType: mimeForExtension(extension),
    byteSize: bytes.byteLength,
    contentHash,
    importedAt: new Date().toISOString(),
  };
  if (kind !== 'image') return { ...common, kind, imageMetadata: null };
  const imageMetadata = await sharp(bytes, { failOn: 'error' })
    .metadata()
    .then((metadata) => {
      if (!metadata.width || !metadata.height)
        throw new Error('Image dimensions could not be determined.');
      if (metadata.width > 65535 || metadata.height > 65535)
        throw new Error('Image dimensions must not exceed 65535 pixels.');
      return {
        width: metadata.width,
        height: metadata.height,
        hasAlpha: metadata.hasAlpha,
        orientation: (metadata.orientation ?? 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
      };
    });
  return { ...common, kind, imageMetadata };
}

export async function importAssets(
  owner: BrowserWindow | null,
  projectFilePath: string,
  options: AssetImportOptions = {},
  assertAuthority?: () => void,
): Promise<AssetImportResponse> {
  if (!owner)
    return {
      ok: false,
      success: false,
      assets: [],
      diagnostics: [],
      error: 'No editor window is available.',
    };
  if (!projectFilePath)
    return {
      ok: false,
      success: false,
      assets: [],
      diagnostics: [],
      error: 'Asset import requires a saved project file.',
    };
  assertAuthority?.();
  const result = await dialog.showOpenDialog(owner, {
    title: 'Import NovelTea Assets',
    properties: options.allowMultiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return {
      ok: false,
      success: false,
      assets: [],
      diagnostics: [],
      error: 'Asset import canceled.',
    };
  }
  assertAuthority?.();
  const assets: ImportedAssetMetadata[] = [];
  const diagnostics: AssetImportResponse['diagnostics'] = [];
  for (const filePath of result.filePaths) {
    try {
      assertAuthority?.();
      assets.push(
        await copyAssetIntoProject(projectFilePath, filePath, undefined, assertAuthority),
      );
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        path: filePath,
        message: error instanceof Error ? error.message : 'Asset import failed.',
      });
    }
  }
  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    success: assets.length > 0,
    assets,
    diagnostics,
  };
}

export async function reimportAsset(
  owner: BrowserWindow | null,
  projectFilePath: string,
  projectRelativePath: string,
  assertAuthority?: () => void,
): Promise<AssetReimportResponse> {
  if (!owner)
    return { ok: false, success: false, diagnostics: [], error: 'No editor window is available.' };
  if (!projectFilePath)
    return {
      ok: false,
      success: false,
      diagnostics: [],
      error: 'Asset reimport requires a saved project file.',
    };
  assertAuthority?.();
  const projectRoot = projectRootFromFile(projectFilePath);
  let replacementExpectedRevision: ProjectWorkspaceExpectedRevision;
  try {
    replacementExpectedRevision = await readProjectAssetFileRevision(
      projectRoot,
      projectRelativePath,
    );
  } catch (error) {
    return {
      ok: false,
      success: false,
      diagnostics: [],
      error: error instanceof Error ? error.message : 'Asset reimport precondition failed.',
    };
  }
  assertAuthority?.();
  const result = await dialog.showOpenDialog(owner, {
    title: 'Reimport Asset',
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) {
    return { ok: false, success: false, diagnostics: [], error: 'Asset reimport canceled.' };
  }
  try {
    assertAuthority?.();
    const asset = await copyAssetIntoProject(
      projectFilePath,
      result.filePaths[0],
      {
        path: projectRelativePath,
        expectedRevision: replacementExpectedRevision,
      },
      assertAuthority,
    );
    return { ok: true, success: true, asset, diagnostics: [] };
  } catch (error) {
    return {
      ok: false,
      success: false,
      diagnostics: [],
      error: error instanceof Error ? error.message : 'Asset reimport failed.',
    };
  }
}
