import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ProjectWorkspaceFileSystemAdapter,
  type ProjectWorkspaceFileSystemOperations,
} from './project-workspace-file-system-adapter';

const nodeProjectWorkspaceFileSystemOperations: ProjectWorkspaceFileSystemOperations = {
  joinPath(values) {
    return path.join(...values);
  },
  async inspect(value) {
    const info = await fs.stat(value);
    return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'missing';
  },
  readText(value) {
    return fs.readFile(value, 'utf8');
  },
  async readBytes(value) {
    return new Uint8Array(await fs.readFile(value));
  },
  listDirectory(value) {
    return fs.readdir(value);
  },
  async createDirectory(value, exclusive) {
    await fs.mkdir(value, exclusive ? undefined : { recursive: true });
  },
  async writeBytes(value, bytes) {
    await fs.writeFile(value, bytes);
  },
  async rename(from, to) {
    await fs.rename(from, to);
  },
  async removeFile(value) {
    await fs.unlink(value);
  },
  async removeDirectory(value) {
    await fs.rm(value, { recursive: true, force: true });
  },
  realpath(value) {
    return fs.realpath(value);
  },
};

export class NodeProjectWorkspaceFileSystem extends ProjectWorkspaceFileSystemAdapter {
  constructor() {
    super(nodeProjectWorkspaceFileSystemOperations);
  }

  async readPathMetadata(value: string) {
    try {
      const info = await fs.lstat(value, { bigint: true });
      const byteSize = Number(info.size);
      if (!Number.isSafeInteger(byteSize) || byteSize < 0) return { kind: 'other' as const };
      if (info.isSymbolicLink()) return { kind: 'symlink' as const };
      if (info.isFile())
        return {
          kind: 'file' as const,
          byteSize,
          mtimeNanoseconds: info.mtimeNs.toString(),
        };
      if (info.isDirectory())
        return {
          kind: 'directory' as const,
          byteSize,
          mtimeNanoseconds: info.mtimeNs.toString(),
        };
      return { kind: 'other' as const };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' as const };
      throw error;
    }
  }

  override async readFileRevision(
    value: string,
  ): Promise<Readonly<{ contentHash: `sha256:${string}`; byteSize: number }>> {
    const hash = createHash('sha256');
    let byteSize = 0;
    for await (const chunk of createReadStream(value)) {
      byteSize += chunk.length;
      hash.update(chunk);
    }
    return { contentHash: `sha256:${hash.digest('hex')}`, byteSize };
  }
}

export function createNodeProjectWorkspaceFileSystem(): NodeProjectWorkspaceFileSystem {
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
