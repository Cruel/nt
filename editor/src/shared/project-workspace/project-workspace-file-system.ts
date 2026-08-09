/**
 * Narrow filesystem port for project workspace discovery and monolithic
 * persistence. Workspace algorithms only depend on this boundary so they can
 * run in Node, tests, and the future headless CLI without Electron.
 */
export interface ProjectWorkspaceFileSystem {
  resolvePath(path: string): string;
  joinPath(...paths: string[]): string;
  dirname(path: string): string;
  relativePath(from: string, to: string): string;
  inspect(path: string): Promise<'missing' | 'file' | 'directory'>;
  listDirectory(path: string): Promise<readonly string[]>;
  readText(path: string): Promise<string>;
  /** Exact on-disk bytes; revisions must never be derived from decoded text. */
  readBytes(path: string): Promise<Uint8Array>;
  writeTextAtomic(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
}

/** Resolve the nearest existing parent before comparing real paths so new files
 * cannot be created through a symlinked directory inside a workspace. */
export async function assertProjectWorkspacePathContained(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
  candidate: string,
): Promise<void> {
  const realRoot = await fileSystem.realpath(root);
  let nearest = candidate;
  let realCandidate: string | null = null;
  while (true) {
    try {
      realCandidate = await fileSystem.realpath(nearest);
      break;
    } catch {
      const parent = fileSystem.dirname(nearest);
      if (parent === nearest) break;
      nearest = parent;
    }
  }
  if (!realCandidate) throw new Error('Workspace path has no existing contained parent.');
  const relation = fileSystem.relativePath(realRoot, realCandidate).replaceAll('\\', '/');
  if (relation === '..' || relation.startsWith('../'))
    throw new Error('Workspace path escapes the project root.');
}
