import type { ProjectWorkspaceFileSystem } from './project-workspace-file-system';

export const NOVELTEA_AGENT_BOOTSTRAP_START = '<!-- noveltea:managed-agent-bootstrap:start -->';
export const NOVELTEA_AGENT_BOOTSTRAP_END = '<!-- noveltea:managed-agent-bootstrap:end -->';

const bootstrapBody = `<!-- DO NOT EDIT THIS BLOCK. -->
Before editing NovelTea project content:

1. Run \`noveltea agent sync\`.
2. Read \`.noveltea/agent/GUIDE.md\` and follow its routing to the focused generated docs for the task.

\`.noveltea/agent/GUIDE.md\` is the authoritative entrypoint for NovelTea authoring guidance.
\`.noveltea/\` is generated, ignored local state. Do not edit it as project source.`;

export const NOVELTEA_PROJECT_AGENTS_MANAGED_BLOCK = `${NOVELTEA_AGENT_BOOTSTRAP_START}
${bootstrapBody}
${NOVELTEA_AGENT_BOOTSTRAP_END}`;

export const NOVELTEA_PROJECT_AGENTS_BOOTSTRAP = `# NovelTea Project

${NOVELTEA_PROJECT_AGENTS_MANAGED_BLOCK}
`;

export const NOVELTEA_LOCAL_STATE_GITIGNORE_RULE = '/.noveltea/';

export type NovelTeaAgentBootstrapStatus = 'missing' | 'current' | 'outdated' | 'malformed';

export interface NovelTeaAgentBootstrapInspection {
  readonly status: NovelTeaAgentBootstrapStatus;
  readonly text: string | null;
}

function occurrences(text: string, marker: string): number[] {
  const values: number[] = [];
  let offset = 0;
  while (offset <= text.length) {
    const index = text.indexOf(marker, offset);
    if (index < 0) break;
    values.push(index);
    offset = index + marker.length;
  }
  return values;
}

export function inspectNovelTeaAgentBootstrapText(
  text: string | null,
): NovelTeaAgentBootstrapInspection {
  if (text === null) return { status: 'missing', text };
  const starts = occurrences(text, NOVELTEA_AGENT_BOOTSTRAP_START);
  const ends = occurrences(text, NOVELTEA_AGENT_BOOTSTRAP_END);
  if (starts.length === 0 && ends.length === 0) return { status: 'missing', text };
  if (starts.length !== 1 || ends.length !== 1 || starts[0]! >= ends[0]!)
    return { status: 'malformed', text };
  const actual = text.slice(starts[0], ends[0]! + NOVELTEA_AGENT_BOOTSTRAP_END.length);
  return {
    status:
      actual.replaceAll('\r\n', '\n') === NOVELTEA_PROJECT_AGENTS_MANAGED_BLOCK
        ? 'current'
        : 'outdated',
    text,
  };
}

function lineEnding(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function withLineEnding(text: string, ending: '\r\n' | '\n'): string {
  return ending === '\n' ? text : text.replaceAll('\n', '\r\n');
}

function insertManagedBlock(text: string): string {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const content = bom ? text.slice(1) : text;
  if (content.trim().length === 0) return `${bom}${NOVELTEA_PROJECT_AGENTS_BOOTSTRAP}`;
  const ending = lineEnding(content);
  const block = withLineEnding(NOVELTEA_PROJECT_AGENTS_MANAGED_BLOCK, ending);
  const firstNonblank = /^(?:[ \t]*(?:\r?\n))*# [^\r\n]*(?:\r?\n|$)/.exec(content);
  if (firstNonblank) {
    const insertAt = firstNonblank[0].length;
    const separator = firstNonblank[0].endsWith(ending) ? ending : `${ending}${ending}`;
    return `${bom}${content.slice(0, insertAt)}${separator}${block}${ending}${content.slice(insertAt)}`;
  }
  return `${bom}${block}${ending}${ending}${content}`;
}

export function repairNovelTeaAgentBootstrapText(
  inspection: NovelTeaAgentBootstrapInspection,
): string {
  if (inspection.status === 'malformed')
    throw new Error('NovelTea managed AGENTS.md markers require manual repair.');
  if (inspection.status === 'current') return inspection.text!;
  if (inspection.status === 'missing') return insertManagedBlock(inspection.text ?? '');
  const text = inspection.text!;
  const start = text.indexOf(NOVELTEA_AGENT_BOOTSTRAP_START);
  const end = text.indexOf(NOVELTEA_AGENT_BOOTSTRAP_END) + NOVELTEA_AGENT_BOOTSTRAP_END.length;
  return `${text.slice(0, start)}${withLineEnding(
    NOVELTEA_PROJECT_AGENTS_MANAGED_BLOCK,
    lineEnding(text),
  )}${text.slice(end)}`;
}

export async function inspectNovelTeaAgentBootstrap(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
): Promise<NovelTeaAgentBootstrapInspection> {
  const target = fileSystem.joinPath(projectRoot, 'AGENTS.md');
  const kind = await fileSystem.inspect(target);
  if (kind === 'directory') throw new Error('AGENTS.md must be a regular file.');
  return inspectNovelTeaAgentBootstrapText(
    kind === 'file' ? await fileSystem.readText(target) : null,
  );
}

export async function repairNovelTeaAgentBootstrap(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  inspection?: NovelTeaAgentBootstrapInspection,
): Promise<boolean> {
  const current = inspection ?? (await inspectNovelTeaAgentBootstrap(fileSystem, projectRoot));
  const repaired = repairNovelTeaAgentBootstrapText(current);
  if (repaired === current.text) return false;
  await fileSystem.writeTextAtomic(fileSystem.joinPath(projectRoot, 'AGENTS.md'), repaired);
  return true;
}

export type NovelTeaGitignoreStatus = 'present' | 'missing-rule' | 'created';

export async function ensureNovelTeaLocalStateIgnored(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
): Promise<NovelTeaGitignoreStatus> {
  const target = fileSystem.joinPath(projectRoot, '.gitignore');
  const kind = await fileSystem.inspect(target);
  if (kind === 'directory') throw new Error('.gitignore must be a regular file.');
  if (kind === 'missing') {
    await fileSystem.writeTextAtomic(target, `${NOVELTEA_LOCAL_STATE_GITIGNORE_RULE}\n`);
    return 'created';
  }
  return (await fileSystem.readText(target)).includes('.noveltea') ? 'present' : 'missing-rule';
}
