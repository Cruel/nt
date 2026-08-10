import type { ProjectWorkspaceFileSystem } from './project-workspace-file-system';

function normalize(value: string): string {
  const parts: string[] = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** In-memory test port; production code must use the Node implementation. */
export class InMemoryProjectWorkspaceFileSystem implements ProjectWorkspaceFileSystem {
  private readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>(['/']);

  constructor(initialFiles: Readonly<Record<string, string>> = {}) {
    for (const [file, content] of Object.entries(initialFiles))
      this.putFile(normalize(file), new TextEncoder().encode(content));
  }

  resolvePath(value: string): string {
    return normalize(value);
  }

  joinPath(...values: string[]): string {
    return normalize(values.join('/'));
  }

  dirname(value: string): string {
    const normalized = normalize(value);
    return normalized.slice(0, normalized.lastIndexOf('/')) || '/';
  }

  relativePath(from: string, to: string): string {
    const base = normalize(from).replace(/\/$/, '');
    const target = normalize(to);
    return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : target;
  }

  async inspect(value: string): Promise<'missing' | 'file' | 'directory'> {
    const normalized = normalize(value);
    if (this.files.has(normalized)) return 'file';
    return this.directories.has(normalized) ||
      [...this.files.keys()].some((file) => file.startsWith(`${normalized}/`))
      ? 'directory'
      : 'missing';
  }

  async listDirectory(value: string): Promise<readonly string[]> {
    const directory = normalize(value).replace(/\/$/, '');
    const names = new Set<string>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(`${directory}/`)) continue;
      const name = file.slice(directory.length + 1).split('/')[0];
      if (name) names.add(name);
    }
    return [...names].sort();
  }

  async readText(value: string): Promise<string> {
    return new TextDecoder('utf-8', { fatal: true }).decode(await this.readBytes(value));
  }

  async readBytes(value: string): Promise<Uint8Array> {
    const bytes = this.files.get(normalize(value));
    if (bytes === undefined) throw new Error(`ENOENT: ${value}`);
    return bytes.slice();
  }

  async writeTextAtomic(value: string, text: string): Promise<void> {
    await this.writeBytesAtomic(value, new TextEncoder().encode(text));
  }

  async writeBytesAtomic(value: string, bytes: Uint8Array): Promise<void> {
    this.putFile(normalize(value), bytes.slice());
  }

  async movePathAtomic(from: string, to: string): Promise<void> {
    const source = normalize(from);
    const target = normalize(to);
    const sourceKind = await this.inspect(source);
    if (sourceKind === 'missing') throw new Error(`ENOENT: ${from}`);
    if ((await this.inspect(target)) !== 'missing') throw new Error(`EEXIST: ${to}`);
    if (sourceKind === 'file') {
      const bytes = this.files.get(source)!;
      this.putFile(target, bytes);
      this.files.delete(source);
      return;
    }
    const movedFiles = [...this.files.entries()].filter(([file]) => file.startsWith(`${source}/`));
    for (const [file, bytes] of movedFiles) {
      const relative = file.slice(source.length + 1);
      this.putFile(`${target}/${relative}`, bytes);
      this.files.delete(file);
    }
    const movedDirectories = [...this.directories].filter(
      (directory) => directory === source || directory.startsWith(`${source}/`),
    );
    for (const directory of movedDirectories) {
      const relative = directory.slice(source.length);
      this.directories.delete(directory);
      this.addDirectory(`${target}${relative}`);
    }
  }

  async removeFile(value: string): Promise<void> {
    this.files.delete(normalize(value));
  }

  async createDirectory(value: string): Promise<void> {
    this.addDirectory(normalize(value));
  }

  async createDirectoryExclusive(value: string): Promise<boolean> {
    const normalized = normalize(value);
    if ((await this.inspect(normalized)) !== 'missing') return false;
    this.addDirectory(normalized);
    return true;
  }

  async removeDirectory(value: string): Promise<void> {
    const normalized = normalize(value);
    for (const file of this.files.keys())
      if (file === normalized || file.startsWith(`${normalized}/`)) this.files.delete(file);
    for (const directory of this.directories)
      if (directory === normalized || directory.startsWith(`${normalized}/`))
        this.directories.delete(directory);
  }

  async realpath(value: string): Promise<string> {
    if ((await this.inspect(value)) === 'missing') throw new Error(`ENOENT: ${value}`);
    return normalize(value);
  }

  private addDirectory(value: string) {
    let current = value;
    while (true) {
      this.directories.add(current);
      if (current === '/') break;
      current = this.dirname(current);
    }
  }

  private putFile(value: string, bytes: Uint8Array) {
    this.addDirectory(this.dirname(value));
    this.files.set(value, bytes);
  }
}
