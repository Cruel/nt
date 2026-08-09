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
  private readonly files = new Map<string, string>();

  constructor(initialFiles: Readonly<Record<string, string>> = {}) {
    for (const [file, content] of Object.entries(initialFiles))
      this.files.set(normalize(file), content);
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
    return [...this.files.keys()].some((file) => file.startsWith(`${normalized}/`))
      ? 'directory'
      : 'missing';
  }

  async readText(value: string): Promise<string> {
    const text = this.files.get(normalize(value));
    if (text === undefined) throw new Error(`ENOENT: ${value}`);
    return text;
  }

  async writeTextAtomic(value: string, text: string): Promise<void> {
    this.files.set(normalize(value), text);
  }

  async realpath(value: string): Promise<string> {
    if ((await this.inspect(value)) === 'missing') throw new Error(`ENOENT: ${value}`);
    return normalize(value);
  }
}
