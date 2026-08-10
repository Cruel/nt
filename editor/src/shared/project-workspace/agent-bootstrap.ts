import type { ProjectWorkspaceFileSystem } from './project-workspace-file-system';

export const NOVELTEA_PROJECT_AGENTS_BOOTSTRAP = `# NovelTea Project

Before editing NovelTea project content:

1. Run \`noveltea agent sync\`.
2. Read \`.noveltea/agent/GUIDE.md\`.

\`.noveltea/\` is generated, ignored local state. Do not edit it as project source.
`;

export const NOVELTEA_LOCAL_STATE_GITIGNORE_RULE = '/.noveltea/';

export async function ensureNovelTeaLocalStateIgnored(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
): Promise<void> {
  const target = fileSystem.joinPath(projectRoot, '.gitignore');
  const existing =
    (await fileSystem.inspect(target)) === 'file' ? await fileSystem.readText(target) : '';
  const lines = existing.replaceAll('\r\n', '\n').split('\n');
  if (lines.includes(NOVELTEA_LOCAL_STATE_GITIGNORE_RULE)) return;
  const separator =
    existing.length > 0 && !existing.endsWith('\n') && !existing.endsWith('\r') ? '\n' : '';
  await fileSystem.writeTextAtomic(
    target,
    `${existing}${separator}${NOVELTEA_LOCAL_STATE_GITIGNORE_RULE}\n`,
  );
}
