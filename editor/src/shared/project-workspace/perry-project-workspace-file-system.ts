import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  ProjectWorkspaceFileSystemAdapter,
  type ProjectWorkspaceFileSystemOperations,
} from './project-workspace-file-system-adapter';

const perryProjectWorkspaceFileSystemOperations: ProjectWorkspaceFileSystemOperations = {
  joinPath(values) {
    // Perry 0.5.1220 does not correctly lower a spread call into node:path.
    if (values.length === 0) return '.';
    let joined = values[0]!;
    for (let index = 1; index < values.length; index += 1) {
      joined = path.join(joined, values[index]!);
    }
    return joined;
  },
  inspect(value) {
    // Perry's fs.promises.stat wrapper loses the Stats predicate methods.
    const info = statSync(value);
    return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'missing';
  },
  readText(value) {
    return readFileSync(value, 'utf8');
  },
  readBytes(value) {
    return new Uint8Array(readFileSync(value));
  },
  listDirectory(value) {
    return readdirSync(value);
  },
  createDirectory(value, exclusive) {
    mkdirSync(value, exclusive ? undefined : { recursive: true });
  },
  writeBytes(value, bytes) {
    writeFileSync(value, bytes);
  },
  rename(from, to) {
    renameSync(from, to);
  },
  removeFile(value) {
    unlinkSync(value);
  },
  removeDirectory(value) {
    rmSync(value, { recursive: true, force: true });
  },
  realpath(value) {
    return realpath(value);
  },
};

export class PerryProjectWorkspaceFileSystem extends ProjectWorkspaceFileSystemAdapter {
  constructor() {
    super(perryProjectWorkspaceFileSystemOperations);
  }
}

export function createPerryProjectWorkspaceFileSystem(): PerryProjectWorkspaceFileSystem {
  return new PerryProjectWorkspaceFileSystem();
}
