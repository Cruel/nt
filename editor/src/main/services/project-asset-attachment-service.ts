import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog, shell, type BrowserWindow } from 'electron';
import type {
  ProjectAttachmentFileInfo,
  ProjectAttachmentImportRequest,
  ProjectAttachmentImportResponse,
  ProjectAttachmentInspection,
} from '../../shared/project-asset-attachments';
import {
  isSafeProjectAttachmentPath,
  type AssetAttachmentPurpose,
} from '../../shared/project-schema/authoring-assets';
import { writeProjectAssetFilesTransaction } from './project-asset-file-transaction';

const DEFAULT_DIRECTORIES: Record<AssetAttachmentPurpose, string> = {
  'distribution-notice': 'support/licenses',
  'authoring-source': 'support/sources',
  reference: 'support/references',
  other: 'support/other',
};
const MAX_LISTED_FILES = 10000;
const MAX_FILE_SIZE = 512 * 1024 * 1024;
const MAX_TEXT_PREVIEW = 128 * 1024;
const MAX_NOTICE_SIZE = 1024 * 1024;

function distributionNoticeError(relative: string, bytes: Uint8Array): string | undefined {
  if (!/\.(?:txt|md)$/i.test(relative)) return 'Distribution Notices must be .txt or .md files.';
  if (bytes.length === 0 || bytes.length > MAX_NOTICE_SIZE)
    return 'Distribution Notices must contain between 1 byte and 1 MiB of text.';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 'Distribution Notice content must be valid UTF-8.';
  }
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159))
      return 'Distribution Notice text contains prohibited control characters.';
  }
  return undefined;
}

async function projectFile(root: string, relative: string, mustExist: boolean) {
  if (!isSafeProjectAttachmentPath(relative)) throw new Error('Unsafe attachment path.');
  const canonicalRoot = await fs.realpath(root);
  const absolute = path.join(canonicalRoot, ...relative.split('/'));
  let current = canonicalRoot;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink())
        throw new Error('Attachment paths cannot traverse symbolic links.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (mustExist) throw error;
    }
  }
  if (mustExist && !(await fs.stat(absolute)).isFile())
    throw new Error('Attachment is not a regular file.');
  return absolute;
}

export async function listProjectAttachmentFiles(
  root: string,
): Promise<ProjectAttachmentFileInfo[]> {
  const files: ProjectAttachmentFileInfo[] = [];
  const visit = async (relative: string): Promise<void> => {
    const directory = relative ? path.join(root, relative) : root;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) throw new Error('Too many Project files to list.');
      const candidate = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isSafeProjectAttachmentPath(candidate)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(candidate);
      } else if (entry.isFile() && candidate !== 'project.json') {
        const absolute = await projectFile(root, candidate, true);
        files.push({ path: candidate, byteSize: (await fs.stat(absolute)).size });
      }
    }
  };
  await visit('');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function inspectProjectAttachmentFile(
  root: string,
  relative: string,
): Promise<ProjectAttachmentInspection> {
  try {
    const absolute = await projectFile(root, relative, true);
    const stat = await fs.stat(absolute);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(absolute)) hash.update(chunk);
    const result: ProjectAttachmentInspection = {
      path: relative,
      exists: true,
      byteSize: stat.size,
      contentHash: `sha256:${hash.digest('hex')}`,
    };
    if (/\.(?:txt|md)$/i.test(relative)) {
      if (stat.size === 0 || stat.size > MAX_NOTICE_SIZE)
        result.noticeError = 'Distribution Notices must contain between 1 byte and 1 MiB of text.';
      else result.noticeError = distributionNoticeError(relative, await fs.readFile(absolute));
    } else result.noticeError = 'Distribution Notices must be .txt or .md files.';
    if (/\.(txt|md|json|csv|toml|yaml|yml|rml|rcss|css|lua)$/i.test(relative)) {
      const handle = await fs.open(absolute, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_TEXT_PREVIEW));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        result.preview = new TextDecoder('utf-8', { fatal: true }).decode(
          buffer.subarray(0, bytesRead),
        );
        result.previewLimited = stat.size > MAX_TEXT_PREVIEW;
      } catch {
        result.preview = undefined;
      } finally {
        await handle.close();
      }
    }
    return result;
  } catch (error) {
    return {
      path: relative,
      exists: false,
      error: error instanceof Error ? error.message : 'File unavailable.',
    };
  }
}

export async function openProjectAttachmentFile(
  root: string,
  relative: string,
  action: 'open' | 'reveal',
): Promise<void> {
  const absolute = await projectFile(root, relative, true);
  if (action === 'reveal') shell.showItemInFolder(absolute);
  else {
    const message = await shell.openPath(absolute);
    if (message) throw new Error(message);
  }
}

function sha(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function importProjectAttachmentFiles(
  owner: BrowserWindow | null,
  root: string,
  request: Omit<ProjectAttachmentImportRequest, 'projectSessionId'>,
  assertAuthority?: () => void,
): Promise<ProjectAttachmentImportResponse> {
  if (!owner) return { paths: [], reused: [], error: 'Editor window unavailable.' };
  const directory = request.destinationDirectory || DEFAULT_DIRECTORIES[request.purpose];
  if (!isSafeProjectAttachmentPath(directory))
    return { paths: [], reused: [], error: 'Destination must be inside the Project.' };
  const picked = await dialog.showOpenDialog(owner, {
    title: 'Import Asset Attachments',
    properties: ['openFile', 'multiSelections'],
  });
  if (picked.canceled || picked.filePaths.length === 0)
    return { paths: [], reused: [], canceled: true };
  try {
    const planned = new Map<string, Uint8Array>();
    const paths: string[] = [];
    const reused: string[] = [];
    for (const source of picked.filePaths) {
      assertAuthority?.();
      const stat = await fs.stat(source);
      if (!stat.isFile() || stat.size > MAX_FILE_SIZE)
        throw new Error('Attachments must be regular files of at most 512 MiB.');
      if (
        request.purpose === 'distribution-notice' &&
        (!/\.(?:txt|md)$/i.test(source) || stat.size === 0 || stat.size > MAX_NOTICE_SIZE)
      )
        throw new Error(
          `${path.basename(source)}: Distribution Notices require a .txt or .md file of 1 byte to 1 MiB.`,
        );
      const bytes = await fs.readFile(source);
      if (request.purpose === 'distribution-notice') {
        const error = distributionNoticeError(path.basename(source), bytes);
        if (error) throw new Error(`${path.basename(source)}: ${error}`);
      }
      const parsed = path.parse(source);
      const basename = parsed.base;
      if (!basename || basename === '.' || basename === '..' || basename.includes('\\'))
        throw new Error('Invalid attachment filename.');
      for (let suffix = 1; suffix <= 10000; suffix++) {
        const name = suffix === 1 ? basename : `${parsed.name}-${suffix}${parsed.ext}`;
        const candidate = `${directory}/${name}`;
        if (!isSafeProjectAttachmentPath(candidate))
          throw new Error('Unsafe attachment destination.');
        const pending = planned.get(candidate);
        if (pending) {
          if (sha(pending) === sha(bytes)) {
            paths.push(candidate);
            reused.push(candidate);
            break;
          }
          continue;
        }
        const destination = await projectFile(root, candidate, false);
        try {
          const existing = await fs.readFile(destination);
          if (sha(existing) === sha(bytes)) {
            paths.push(candidate);
            reused.push(candidate);
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          planned.set(candidate, bytes);
          paths.push(candidate);
          break;
        }
      }
      if (paths.length < picked.filePaths.indexOf(source) + 1)
        throw new Error('No available filename for attachment.');
    }
    assertAuthority?.();
    if (planned.size)
      await writeProjectAssetFilesTransaction(
        root,
        [...planned].map(([filePath, bytes]) => ({ path: filePath, bytes })),
        'import Project attachments',
      );
    return { paths, reused };
  } catch (error) {
    return {
      paths: [],
      reused: [],
      error: error instanceof Error ? error.message : 'Attachment import failed.',
    };
  }
}
