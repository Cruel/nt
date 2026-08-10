import path from 'node:path';
import type { ProjectWorkspaceFileSystem } from './project-workspace-file-system';

export type ProjectWorkspaceFileSystemOperationResult<T> = T | Promise<T>;

export interface ProjectWorkspaceFileSystemOperations {
  joinPath(values: readonly string[]): string;
  inspect(
    value: string,
  ): ProjectWorkspaceFileSystemOperationResult<'missing' | 'file' | 'directory'>;
  readText(value: string): ProjectWorkspaceFileSystemOperationResult<string>;
  readBytes(value: string): ProjectWorkspaceFileSystemOperationResult<Uint8Array>;
  listDirectory(value: string): ProjectWorkspaceFileSystemOperationResult<readonly string[]>;
  createDirectory(
    value: string,
    exclusive: boolean,
  ): ProjectWorkspaceFileSystemOperationResult<void>;
  writeBytes(value: string, bytes: Uint8Array): ProjectWorkspaceFileSystemOperationResult<void>;
  rename(from: string, to: string): ProjectWorkspaceFileSystemOperationResult<void>;
  removeFile(value: string): ProjectWorkspaceFileSystemOperationResult<void>;
  removeDirectory(value: string): ProjectWorkspaceFileSystemOperationResult<void>;
  realpath(value: string): ProjectWorkspaceFileSystemOperationResult<string>;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

export class ProjectWorkspaceFileSystemAdapter implements ProjectWorkspaceFileSystem {
  constructor(private readonly operations: ProjectWorkspaceFileSystemOperations) {}

  resolvePath(value: string): string {
    return path.resolve(value);
  }

  joinPath(...values: string[]): string {
    return this.operations.joinPath(values);
  }

  dirname(value: string): string {
    return path.dirname(value);
  }

  relativePath(from: string, to: string): string {
    return path.relative(from, to).replaceAll(path.sep, '/');
  }

  async inspect(value: string): Promise<'missing' | 'file' | 'directory'> {
    try {
      return await this.operations.inspect(value);
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) return 'missing';
      throw error;
    }
  }

  async readText(value: string): Promise<string> {
    return await this.operations.readText(value);
  }

  async readBytes(value: string): Promise<Uint8Array> {
    return await this.operations.readBytes(value);
  }

  async listDirectory(value: string): Promise<readonly string[]> {
    try {
      return await this.operations.listDirectory(value);
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) return [];
      throw error;
    }
  }

  async writeTextAtomic(value: string, text: string): Promise<void> {
    await this.writeBytesAtomic(value, new TextEncoder().encode(text));
  }

  async writeBytesAtomic(value: string, bytes: Uint8Array): Promise<void> {
    const absolute = path.resolve(value);
    const directory = path.dirname(absolute);
    const temporary = this.operations.joinPath([
      directory,
      `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`,
    ]);
    await this.operations.createDirectory(directory, false);
    await this.operations.writeBytes(temporary, bytes);
    await this.operations.rename(temporary, absolute);
  }

  async movePathAtomic(from: string, to: string): Promise<void> {
    await this.operations.rename(from, to);
  }

  async removeFile(value: string): Promise<void> {
    try {
      await this.operations.removeFile(value);
    } catch (error) {
      if (!isFileSystemError(error, 'ENOENT')) throw error;
    }
  }

  async createDirectory(value: string): Promise<void> {
    await this.operations.createDirectory(value, false);
  }

  async createDirectoryExclusive(value: string): Promise<boolean> {
    try {
      await this.operations.createDirectory(value, true);
      return true;
    } catch (error) {
      if (isFileSystemError(error, 'EEXIST')) return false;
      throw error;
    }
  }

  async removeDirectory(value: string): Promise<void> {
    await this.operations.removeDirectory(value);
  }

  async realpath(value: string): Promise<string> {
    return await this.operations.realpath(value);
  }
}
