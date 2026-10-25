import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  ProjectWorkspaceFileSystem,
  ProjectWorkspacePathMetadata,
} from '../../shared/project-workspace/project-workspace-file-system';

/** Test-only byte filesystem for the retained native validation-stage cache.
 * It supplies bytes/revisions, not Project parsing or authoring authority. */
export class MemoryFileSystem implements ProjectWorkspaceFileSystem {
  private readonly files: Map<string, Uint8Array>;
  private readonly directories = new Set<string>(['/']);

  constructor(files: Record<string, string | Uint8Array> = {}) {
    this.files = new Map();
    for (const [name, value] of Object.entries(files)) {
      this.writeInitial(name, value);
    }
  }

  private writeInitial(name: string, value: string | Uint8Array) {
    const full = this.resolvePath(name);
    let parent = path.posix.dirname(full);
    while (!this.directories.has(parent)) {
      this.directories.add(parent);
      parent = path.posix.dirname(parent);
    }
    this.files.set(full, typeof value === 'string' ? Buffer.from(value) : Buffer.from(value));
  }

  resolvePath(name: string) {
    return path.posix.resolve(name);
  }
  joinPath(...names: string[]) {
    return path.posix.join(...names);
  }
  dirname(name: string) {
    return path.posix.dirname(name);
  }
  relativePath(from: string, to: string) {
    return path.posix.relative(from, to);
  }
  async inspect(name: string): Promise<'missing' | 'file' | 'directory'> {
    const full = this.resolvePath(name);
    if (this.files.has(full)) return 'file';
    return this.directories.has(full) ? 'directory' : 'missing';
  }
  async readPathMetadata(name: string): Promise<ProjectWorkspacePathMetadata> {
    const kind = await this.inspect(name);
    const bytes = this.files.get(this.resolvePath(name));
    return { kind, ...(bytes ? { byteSize: bytes.byteLength, sourceIdentity: name } : {}) };
  }
  async listDirectory(name: string) {
    const base = this.resolvePath(name);
    const all = [...this.files.keys(), ...this.directories];
    return [
      ...new Set(
        all
          .filter((f) => f !== base && path.posix.dirname(f) === base)
          .map((f) => path.posix.basename(f)),
      ),
    ];
  }
  async readText(name: string) {
    return Buffer.from(await this.readBytes(name)).toString('utf8');
  }
  async readTextFresh(name: string) {
    return this.readText(name);
  }
  async readBytes(name: string) {
    const bytes = this.files.get(this.resolvePath(name));
    if (!bytes) throw new Error(`ENOENT: ${name}`);
    return Buffer.from(bytes);
  }
  async readFileRevision(name: string) {
    const bytes = await this.readBytes(name);
    return {
      contentHash:
        `sha256:${createHash('sha256').update(bytes).digest('hex')}` as `sha256:${string}`,
      byteSize: bytes.byteLength,
    };
  }
  async writeTextAtomic(name: string, text: string) {
    this.writeInitial(name, text);
  }
  async writeBytesAtomic(name: string, bytes: Uint8Array) {
    this.writeInitial(name, bytes);
  }
  async movePathAtomic(from: string, to: string) {
    const bytes = await this.readBytes(from);
    this.files.delete(this.resolvePath(from));
    this.writeInitial(to, bytes);
  }
  async removeFile(name: string) {
    this.files.delete(this.resolvePath(name));
  }
  async createDirectory(name: string) {
    this.directories.add(this.resolvePath(name));
  }
  async createDirectoryExclusive(name: string) {
    if ((await this.inspect(name)) !== 'missing') return false;
    this.directories.add(this.resolvePath(name));
    return true;
  }
  async removeDirectory(name: string) {
    this.directories.delete(this.resolvePath(name));
  }
  async realpath(name: string) {
    return this.resolvePath(name);
  }
}
