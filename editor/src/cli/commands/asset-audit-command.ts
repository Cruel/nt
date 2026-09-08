import path from 'node:path';
import {
  inferAssetKindFromExtension,
  parseAssetData,
} from '../../shared/project-schema/authoring-assets';
import type { CliSemanticResult } from '../semantic-project';
import type { CliCommandContext, CliCommandDefinition } from './types';
import { CliCommandUsageError } from './types';

function slashPath(value: string): string {
  return value.split(path.sep).join('/');
}

function isContained(root: string, candidate: string): boolean {
  const relation = path.relative(root, candidate);
  return relation === '' || (!relation.startsWith('..') && !path.isAbsolute(relation));
}

function isIgnoredAssetPath(value: string): boolean {
  const base = path.basename(value);
  if (base === '.DS_Store' || base === 'Thumbs.db') return true;
  if (base.startsWith('.') || base.startsWith('~')) return true;
  const extension = path.extname(base).toLowerCase();
  return (
    extension === '.tmp' ||
    extension === '.part' ||
    extension === '.crdownload' ||
    extension === '.download'
  );
}

async function auditAssetDirectory(context: CliCommandContext): Promise<CliSemanticResult> {
  const projectRoot = context.snapshot.projectRoot;
  const assetsRoot = context.fileSystem.joinPath(projectRoot, 'assets');
  if ((await context.fileSystem.inspect(assetsRoot)) === 'missing')
    return {
      ok: true,
      diagnostics: [],
      humanSuccess: 'No untracked Asset files.',
      fields: { untrackedFiles: [] },
    };
  if ((await context.fileSystem.inspect(assetsRoot)) !== 'directory')
    return {
      ok: false,
      diagnostics: [
        {
          code: 'asset.audit.invalid_assets_directory',
          path: '/assets',
          message: 'Project assets path is not a directory.',
          severity: 'error',
        },
      ],
    };

  const assetsReal = await context.fileSystem.realpath(assetsRoot);
  const tracked = new Set(
    Object.values(context.snapshot.project.assets).flatMap((record) => {
      const data = parseAssetData(record.data);
      return data?.source.type === 'project-file' ? [data.source.path] : [];
    }),
  );
  const untrackedFiles: Array<Readonly<{ projectRelativePath: string; kind: string }>> = [];
  const diagnostics: Array<CliSemanticResult['diagnostics'][number]> = [];

  async function visit(directory: string): Promise<void> {
    const names = [...(await context.fileSystem.listDirectory(directory))].sort();
    for (const name of names) {
      const absolute = context.fileSystem.joinPath(directory, name);
      if (isIgnoredAssetPath(absolute)) continue;
      const kind = await context.fileSystem.inspect(absolute);
      if (kind === 'missing') continue;
      const real = await context.fileSystem.realpath(absolute);
      if (!isContained(assetsReal, real)) {
        diagnostics.push({
          code: 'asset.audit.path_escape',
          path: slashPath(path.relative(projectRoot, absolute)),
          message: 'Asset path resolves outside the project assets directory.',
          severity: 'error',
        });
        continue;
      }
      if (kind === 'directory') {
        await visit(absolute);
        continue;
      }
      if (kind !== 'file') continue;
      const projectRelativePath = slashPath(path.relative(projectRoot, absolute));
      if (tracked.has(projectRelativePath)) continue;
      untrackedFiles.push({
        projectRelativePath,
        kind: inferAssetKindFromExtension(projectRelativePath),
      });
    }
  }

  await visit(assetsRoot);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  untrackedFiles.sort((left, right) =>
    left.projectRelativePath.localeCompare(right.projectRelativePath),
  );
  return {
    ok: true,
    diagnostics: [],
    humanSuccess:
      untrackedFiles.length === 0
        ? 'No untracked Asset files.'
        : `Found ${untrackedFiles.length} untracked Asset file${untrackedFiles.length === 1 ? '' : 's'}.`,
    fields: { untrackedFiles },
  };
}

export const assetAuditCommand: CliCommandDefinition = {
  path: ['asset', 'audit'],
  parse(arguments_) {
    if (arguments_.length !== 0) throw new CliCommandUsageError('Usage: noveltea asset audit');
    return {
      dryRun: true,
      mutation: false,
      run: auditAssetDirectory,
    };
  },
};
