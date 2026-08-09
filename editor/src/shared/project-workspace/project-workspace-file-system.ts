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
  readText(path: string): Promise<string>;
  writeTextAtomic(path: string, text: string): Promise<void>;
  realpath(path: string): Promise<string>;
}
