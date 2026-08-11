import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import { readPerryEmbeddedAgentKit, type NovelTeaAgentKitPayload } from './agent-kit-embedded';

export interface NovelTeaAgentSyncOptions {
  readonly beforeActivate?: () => Promise<void> | void;
}

export interface NovelTeaAgentSyncResult {
  readonly changed: boolean;
  readonly agentRoot: string;
  readonly guidePath: string;
  readonly manifestPath: string;
}

function relativeJoin(fileSystem: ProjectWorkspaceFileSystem, root: string, relativePath: string) {
  return relativePath
    .split('/')
    .reduce((current, segment) => fileSystem.joinPath(current, segment), root);
}

async function listFilesRecursively(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
  relative = '',
): Promise<string[]> {
  const directory = relative ? relativeJoin(fileSystem, root, relative) : root;
  const files: string[] = [];
  for (const name of await fileSystem.listDirectory(directory)) {
    const childRelative = relative ? `${relative}/${name}` : name;
    const child = fileSystem.joinPath(directory, name);
    const kind = await fileSystem.inspect(child);
    if (kind === 'directory')
      files.push(...(await listFilesRecursively(fileSystem, root, childRelative)));
    else if (kind === 'file') files.push(childRelative);
  }
  return files.sort();
}

async function kitMatches(
  fileSystem: ProjectWorkspaceFileSystem,
  agentRoot: string,
  manifestText: string,
  files: Readonly<Record<string, string>>,
): Promise<boolean> {
  if ((await fileSystem.inspect(agentRoot)) !== 'directory') return false;
  const manifestPath = fileSystem.joinPath(agentRoot, 'manifest.json');
  if ((await fileSystem.inspect(manifestPath)) !== 'file') return false;
  if ((await fileSystem.readText(manifestPath)) !== manifestText) return false;
  const expectedPaths = ['manifest.json', ...Object.keys(files)].sort();
  const actualPaths = await listFilesRecursively(fileSystem, agentRoot);
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((value, index) => value !== expectedPaths[index])
  )
    return false;
  for (const [relativePath, expectedText] of Object.entries(files)) {
    const target = relativeJoin(fileSystem, agentRoot, relativePath);
    if ((await fileSystem.inspect(target)) !== 'file') return false;
    if ((await fileSystem.readText(target)) !== expectedText) return false;
  }
  return true;
}

async function writeAndValidateCandidate(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
  manifestText: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await fileSystem.createDirectory(root);
  for (const [relativePath, text] of Object.entries(files))
    await fileSystem.writeTextAtomic(relativeJoin(fileSystem, root, relativePath), text);
  await fileSystem.writeTextAtomic(fileSystem.joinPath(root, 'manifest.json'), manifestText);
  if (!(await kitMatches(fileSystem, root, manifestText, files)))
    throw new Error('Generated NovelTea agent kit failed its embedded hash validation.');
}

let stagingSequence = 0;

async function loadNovelTeaAgentKitPayload(): Promise<NovelTeaAgentKitPayload> {
  if ('perry' in process.versions) return readPerryEmbeddedAgentKit();
  return (await import('./agent-kit')).createNovelTeaAgentKitPayload();
}

export function syncNovelTeaAgentKit(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  options: NovelTeaAgentSyncOptions = {},
): Promise<NovelTeaAgentSyncResult> {
  return new Promise<NovelTeaAgentSyncResult>((resolve, reject) => {
    void (async () => {
      let stagingRoot: string | null = null;
      let backupRoot: string | null = null;
      let movedPrevious = false;
      let activated = false;
      let succeeded = false;
      try {
        const payload = await loadNovelTeaAgentKitPayload();
        const localRoot = fileSystem.joinPath(projectRoot, '.noveltea');
        const agentRoot = fileSystem.joinPath(localRoot, 'agent');
        const guidePath = fileSystem.joinPath(agentRoot, 'GUIDE.md');
        const manifestPath = fileSystem.joinPath(agentRoot, 'manifest.json');
        if (await kitMatches(fileSystem, agentRoot, payload.manifestText, payload.files)) {
          resolve({ changed: false, agentRoot, guidePath, manifestPath });
          return;
        }

        stagingSequence += 1;
        const suffix = `${process.pid}-${stagingSequence}`;
        stagingRoot = fileSystem.joinPath(localRoot, `.agent-staging-${suffix}`);
        backupRoot = fileSystem.joinPath(localRoot, `.agent-backup-${suffix}`);
        await fileSystem.removeDirectory(stagingRoot);
        await fileSystem.removeDirectory(backupRoot);

        try {
          await writeAndValidateCandidate(
            fileSystem,
            stagingRoot,
            payload.manifestText,
            payload.files,
          );
          await options.beforeActivate?.();
          if ((await fileSystem.inspect(agentRoot)) !== 'missing') {
            await fileSystem.movePathAtomic(agentRoot, backupRoot);
            movedPrevious = true;
          }
          await fileSystem.movePathAtomic(stagingRoot, agentRoot);
          activated = true;
          if (!(await kitMatches(fileSystem, agentRoot, payload.manifestText, payload.files)))
            throw new Error('Activated NovelTea agent kit failed validation.');
          await fileSystem.removeDirectory(backupRoot);
          succeeded = true;
        } catch (error) {
          if (activated) await fileSystem.removeDirectory(agentRoot);
          if (movedPrevious && (await fileSystem.inspect(backupRoot)) === 'directory')
            await fileSystem.movePathAtomic(backupRoot, agentRoot);
          throw error;
        } finally {
          await fileSystem.removeDirectory(stagingRoot);
          if (succeeded) await fileSystem.removeDirectory(backupRoot);
        }

        resolve({ changed: true, agentRoot, guidePath, manifestPath });
      } catch (error) {
        reject(error);
      }
    })();
  });
}
