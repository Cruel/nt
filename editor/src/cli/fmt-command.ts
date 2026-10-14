import path from 'node:path';
import { parseRestrictedYamlDocument } from '../shared/project-workspace/restricted-yaml-source';
import { NodeProjectWorkspaceProcessLiveness } from '../shared/project-workspace/node-project-workspace-file-system';
import {
  ProjectWorkspaceTransactionService,
  ProjectWorkspaceMutationError,
} from '../shared/project-workspace/project-workspace-transaction';
import { sha256PrefixedBytes } from '../shared/web-crypto';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import { assertProjectWorkspacePathContained } from '../shared/project-workspace/project-workspace-file-system';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliExitCode,
} from './contracts';
import { novelTeaCliUsageFailure, type ParsedGlobalArguments } from './bootstrap';

function isTrackedYaml(file: string): boolean {
  return (
    ['project.yaml', 'editor.yaml', 'traits.yaml', 'i18n/project.yaml'].includes(file) ||
    /^records\/[a-z-]+\/[^/]+\.yaml$/u.test(file) ||
    /^records\/layouts\/[^/]+\/layout\.yaml$/u.test(file) ||
    /^i18n\/[a-zA-Z0-9_-]+\.yaml$/u.test(file) ||
    /^i18n\/[a-zA-Z0-9_-]+\/[^/]+\.yaml$/u.test(file) ||
    /^layouts\/[^/]+\/layout\.yaml$/u.test(file)
  );
}

async function collect(fileSystem: ProjectWorkspaceFileSystem, root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    const absolute = fileSystem.joinPath(root, relative);
    await assertProjectWorkspacePathContained(fileSystem, root, absolute);
    for (const name of await fileSystem.listDirectory(absolute)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const child = relative ? `${relative}/${name}` : name;
      if (!['records', 'i18n', 'layouts'].includes(child.split('/')[0]!)) continue;
      const kind = await fileSystem.inspect(fileSystem.joinPath(root, child));
      if (kind === 'directory') await visit(child);
      else if (kind === 'file' && isTrackedYaml(child)) {
        await assertProjectWorkspacePathContained(
          fileSystem,
          root,
          fileSystem.joinPath(root, child),
        );
        files.push(child);
      }
    }
  };
  for (const name of ['project.yaml', 'editor.yaml', 'traits.yaml'])
    if ((await fileSystem.inspect(fileSystem.joinPath(root, name))) === 'file') {
      await assertProjectWorkspacePathContained(fileSystem, root, fileSystem.joinPath(root, name));
      files.push(name);
    }
  for (const dir of ['records', 'i18n', 'layouts'])
    if ((await fileSystem.inspect(fileSystem.joinPath(root, dir))) === 'directory')
      await visit(dir);
  return files.sort();
}

export async function runNovelTeaFmtCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  fs: ProjectWorkspaceFileSystem,
) {
  const args = globals.command.slice(1);
  const check = args.includes('--check');
  const stripDefaults = args.includes('--strip-defaults');
  const paths = args.filter((item) => item !== '--check' && item !== '--strip-defaults');
  if (
    paths.length > 1 ||
    args.filter((item) => item === '--check').length > 1 ||
    args.filter((item) => item === '--strip-defaults').length > 1 ||
    paths.some((item) => item.startsWith('--'))
  )
    return novelTeaCliUsageFailure(
      'Usage: noveltea fmt [<tracked-yaml-path>] [--check] [--strip-defaults]',
      globals.json,
    );

  let root = path.resolve(cwd, globals.project ?? '.');
  if (!globals.project) {
    while ((await fs.inspect(fs.joinPath(root, 'project.yaml'))) !== 'file') {
      const parent = fs.dirname(root);
      if (parent === root) break;
      root = parent;
    }
  }
  const error = (code: string, file: string, message: string, exitCode: NovelTeaCliExitCode) =>
    formatCliResult(
      {
        success: false,
        exitCode,
        projectRoot: root,
        diagnostics: [cliDiagnostic(code, `/${file}`, message)],
      },
      globals.json,
      { failure: message },
    );
  if ((await fs.inspect(fs.joinPath(root, 'project.yaml'))) !== 'file')
    return error(
      'WORKSPACE_UNAVAILABLE',
      'project.yaml',
      'No project.yaml found.',
      NOVELTEA_CLI_EXIT_CODES.workspace,
    );

  const tracked = await collect(fs, root);
  let selected = tracked;
  if (paths.length) {
    // Tracked source paths are project-relative even when --project points elsewhere.
    const target = path.resolve(root, paths[0]!);
    const relative = path.relative(root, target).split(path.sep).join('/');
    if (!isTrackedYaml(relative) || !tracked.includes(relative))
      return error(
        'FMT_PATH',
        relative,
        'Path is not an existing tracked YAML Project source.',
        NOVELTEA_CLI_EXIT_CODES.usage,
      );
    selected = [relative];
  }
  const changes: { file: string; formatted: string; revision: `sha256:${string}` }[] = [];
  for (const file of selected) {
    const absolute = fs.joinPath(root, file);
    try {
      const bytes = await fs.readBytes(absolute);
      const original = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      let candidate = original;
      if (stripDefaults) {
        const record = /^records\/([^/]+)\/([^/]+)\.yaml$/u.exec(file);
        if (/^records\/layouts\/[^/]+\/layout\.yaml$/u.test(file)) {
          const { stripLayoutYamlDefaults } =
            await import('../shared/project-workspace/layout-yaml-source');
          candidate = stripLayoutYamlDefaults(candidate);
        } else if (record) {
          if (record[1] === 'variables') {
            const { stripVariableYamlDefaults } =
              await import('../shared/project-workspace/variable-yaml-source');
            candidate = stripVariableYamlDefaults(candidate);
          } else {
            const { isAuthoringCollectionKey } =
              await import('../shared/project-schema/authoring-collections');
            if (
              isAuthoringCollectionKey(record[1]!) &&
              record[1] !== 'layouts' &&
              record[1] !== 'variables'
            ) {
              const { stripSparseRecordYamlDefaults } =
                await import('../shared/project-workspace/sparse-record-yaml-source');
              candidate = stripSparseRecordYamlDefaults(record[1]!, candidate);
            }
          }
        }
      }
      const doc = parseRestrictedYamlDocument(candidate);
      const before = doc.toJS();
      const formatted = doc.toString({ indent: 2, lineWidth: 0 });
      if (stripDefaults && !file.startsWith('records/')) {
        const { validateYamlCompactionSource } =
          await import('../shared/project-workspace/project-workspace-service');
        const effectiveBefore = validateYamlCompactionSource(file, original);
        const effectiveAfter = validateYamlCompactionSource(file, formatted);
        if (JSON.stringify(effectiveBefore) !== JSON.stringify(effectiveAfter))
          throw new Error('Default compaction changed normalized source data.');
      }
      if (JSON.stringify(before) !== JSON.stringify(parseRestrictedYamlDocument(formatted).toJS()))
        throw new Error('Formatting altered the YAML data.');
      if (original !== formatted)
        changes.push({ file, formatted, revision: await sha256PrefixedBytes(bytes) });
    } catch (cause) {
      return error(
        'FMT_INVALID_YAML',
        file,
        cause instanceof Error ? cause.message : String(cause),
        NOVELTEA_CLI_EXIT_CODES.workspace,
      );
    }
  }
  if (!check) {
    if (changes.length) {
      try {
        const transaction = new ProjectWorkspaceTransactionService(
          fs,
          new NodeProjectWorkspaceProcessLiveness(),
          process.pid,
        );
        await transaction.commit(root, {
          operationLabel: 'cli fmt',
          targets: changes.map(({ file, formatted, revision }) => ({
            path: file,
            operation: 'write' as const,
            expectedRevision: revision,
            bytes: new TextEncoder().encode(formatted),
          })),
        });
      } catch (cause) {
        if (cause instanceof ProjectWorkspaceMutationError)
          return error(
            cause.code,
            cause.targetPath ?? '/',
            cause.message,
            NOVELTEA_CLI_EXIT_CODES.mutation,
          );
        throw cause;
      }
    }
  }
  return formatCliResult(
    {
      success: !check || changes.length === 0,
      exitCode:
        check && changes.length
          ? NOVELTEA_CLI_EXIT_CODES.semantic
          : NOVELTEA_CLI_EXIT_CODES.success,
      projectRoot: root,
      diagnostics: changes.map((change) =>
        cliDiagnostic(
          'FMT_CHANGE',
          `/${change.file}`,
          check ? 'Source requires formatting.' : 'Source formatted.',
          'warning',
        ),
      ),
      checked: selected.length,
      changed: changes.length,
      files: changes.map((change) => change.file),
      check,
    },
    globals.json,
    {
      success: check
        ? 'All YAML Project sources are formatted.'
        : 'YAML Project sources formatted.',
      failure: `${changes.length} YAML Project source(s) require formatting.`,
    },
  );
}
