import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function entryDirectory(): string {
  return process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : process.cwd();
}

function sourceRootCandidates(): string[] {
  const entry = entryDirectory();
  return [path.resolve(process.cwd(), 'agent-kit'), path.resolve(entry, '..', '..', 'agent-kit')];
}

function systemLayoutSourceRootCandidates(): string[] {
  const entry = entryDirectory();
  return [
    path.resolve(process.cwd(), 'engine', 'assets', 'system'),
    path.resolve(process.cwd(), '..', 'engine', 'assets', 'system'),
    path.resolve(entry, '..', '..', '..', 'engine', 'assets', 'system'),
  ];
}

function findSourceRoot(): string {
  for (const candidate of sourceRootCandidates()) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next checkout-relative location used by the source and bundled Node CLI hosts.
    }
  }
  throw new Error('NovelTea agent-kit source directory is unavailable.');
}

function findSystemLayoutSourceRoot(): string {
  for (const candidate of systemLayoutSourceRootCandidates()) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next checkout-relative location used by source and bundled Node CLI hosts.
    }
  }
  throw new Error('NovelTea built-in system Layout source directory is unavailable.');
}

function collectFiles(root: string, directory: string, files: Record<string, string>): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    compareCodePoints(left.name, right.name),
  );
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile())
      throw new Error(`Agent-kit source path must be a regular file: ${absolutePath}`);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    files[relativePath] = readFileSync(absolutePath, 'utf8');
  }
}

export function loadAgentKitSourceFiles(): Readonly<Record<string, string>> {
  const root = findSourceRoot();
  const files: Record<string, string> = {};
  collectFiles(root, root, files);
  return Object.freeze(files);
}

export function loadAgentKitSystemLayoutSourceFiles(): Readonly<Record<string, string>> {
  const root = findSystemLayoutSourceRoot();
  const files: Record<string, string> = {};
  collectFiles(root, path.join(root, 'ui'), files);
  return Object.freeze(files);
}

export function loadAgentKitProvenance(): unknown {
  const sourceRoot = findSourceRoot();
  const provenancePath = path.join(path.dirname(sourceRoot), 'agent-kit-provenance.json');
  if (!statSync(provenancePath).isFile())
    throw new Error(`NovelTea agent-kit provenance must be a regular file: ${provenancePath}`);
  return JSON.parse(readFileSync(provenancePath, 'utf8')) as unknown;
}
