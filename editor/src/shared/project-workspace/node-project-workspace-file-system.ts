import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectWorkspaceFileSystem } from './project-workspace-file-system';

export class NodeProjectWorkspaceFileSystem implements ProjectWorkspaceFileSystem {
  resolvePath(value: string): string {
    return path.resolve(value);
  }

  joinPath(...values: string[]): string {
    return path.join(...values);
  }

  dirname(value: string): string {
    return path.dirname(value);
  }

  relativePath(from: string, to: string): string {
    return path.relative(from, to).replaceAll(path.sep, '/');
  }

  async inspect(value: string): Promise<'missing' | 'file' | 'directory'> {
    try {
      const stat = await fs.stat(value);
      return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'missing';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  readText(value: string): Promise<string> {
    return fs.readFile(value, 'utf8');
  }

  async readBytes(value: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(value));
  }

  async listDirectory(value: string): Promise<readonly string[]> {
    try {
      return await fs.readdir(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async writeTextAtomic(value: string, text: string): Promise<void> {
    await this.writeBytesAtomic(value, new TextEncoder().encode(text));
  }

  async writeBytesAtomic(value: string, bytes: Uint8Array): Promise<void> {
    const absolute = path.resolve(value);
    const directory = path.dirname(absolute);
    const temporary = path.join(
      directory,
      `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`,
    );
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, absolute);
  }

  async removeFile(value: string): Promise<void> {
    try {
      await fs.unlink(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async createDirectory(value: string): Promise<void> {
    await fs.mkdir(value, { recursive: true });
  }

  async createDirectoryExclusive(value: string): Promise<boolean> {
    try {
      await fs.mkdir(value);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  async removeDirectory(value: string): Promise<void> {
    await fs.rm(value, { recursive: true, force: true });
  }

  realpath(value: string): Promise<string> {
    return fs.realpath(value);
  }
}

export function createNodeProjectWorkspaceFileSystem(): ProjectWorkspaceFileSystem {
  return new NodeProjectWorkspaceFileSystem();
}

export class NodeProjectWorkspaceProcessLiveness {
  async isProcessAlive(pid: number): Promise<boolean | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      return null;
    }
  }
}
