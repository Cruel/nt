import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectWorkspacePathMetadata } from './project-workspace-file-system';
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

export type ProjectWorkspacePathMetadataReader = (
  path: string,
) => Promise<ProjectWorkspacePathMetadata>;

async function readNodePathMetadata(value: string): Promise<ProjectWorkspacePathMetadata> {
  try {
    const info = await fs.lstat(value, { bigint: true });
    const byteSize = Number(info.size);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) return { kind: 'other' };
    const metadata = {
      sourceIdentity: `posix:${info.dev.toString()}:${info.ino.toString()}`,
      byteSize,
      mtimeNanoseconds: info.mtimeNs.toString(),
    };
    if (info.isSymbolicLink()) return { kind: 'symlink', ...metadata };
    if (info.isFile()) return { kind: 'file', ...metadata };
    if (info.isDirectory()) return { kind: 'directory', ...metadata };
    return { kind: 'other', ...metadata };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    throw error;
  }
}

export class NodeProjectWorkspaceFileSystem extends ProjectWorkspaceFileSystemAdapter {
  constructor(
    private readonly pathMetadataReader: ProjectWorkspacePathMetadataReader = readNodePathMetadata,
  ) {
    super(nodeProjectWorkspaceFileSystemOperations);
  }

  readPathMetadata(value: string): Promise<ProjectWorkspacePathMetadata> {
    return this.pathMetadataReader(value);
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

export function createNodeProjectWorkspaceFileSystem(
  pathMetadataReader?: ProjectWorkspacePathMetadataReader,
): NodeProjectWorkspaceFileSystem {
  return new NodeProjectWorkspaceFileSystem(pathMetadataReader);
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
