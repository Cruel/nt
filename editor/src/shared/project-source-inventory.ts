import {
  compareProjectWorkspaceUnicodeCodePoints,
  type ProjectWorkspaceFileSystem,
} from './project-workspace';

export interface ProjectSourceInventoryEntry {
  readonly path: string;
  readonly byteSize: number;
  readonly mtimeNanoseconds: string;
}

export interface ProjectSourceInventory {
  readonly entries: readonly ProjectSourceInventoryEntry[];
}

export interface ProjectSourceDiscoveryScope {
  readonly root: string;
  readonly extensions: readonly string[];
  readonly excludedPrefixes: readonly string[];
}

export interface ProjectSourceInventoryRequest {
  readonly authoritativePaths: readonly string[];
  readonly discoveryScopes?: readonly ProjectSourceDiscoveryScope[];
}

export class ProjectSourceInventoryError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function slashPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function normalizeRelativePath(value: string): string {
  return slashPath(value).replace(/^\/+/, '');
}

function relationEscapesProject(value: string): boolean {
  const relation = slashPath(value);
  return (
    relation === '..' ||
    relation.startsWith('../') ||
    relation.startsWith('/') ||
    /^[A-Za-z]:\//u.test(relation)
  );
}

function scopeExcludes(scope: ProjectSourceDiscoveryScope, relative: string): boolean {
  return scope.excludedPrefixes.some(
    (prefix) => relative === prefix.replace(/\/$/u, '') || relative.startsWith(prefix),
  );
}

function matchesCandidateExtension(scope: ProjectSourceDiscoveryScope, relative: string): boolean {
  if (scopeExcludes(scope, relative)) return false;
  return scope.extensions.some((extension) => relative.endsWith(extension));
}

async function captureRegularFile(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  projectRootRealPath: string,
  relative: string,
): Promise<ProjectSourceInventoryEntry> {
  const normalized = normalizeRelativePath(relative);
  const absolute = fileSystem.joinPath(projectRoot, normalized);
  const metadata = await fileSystem.readPathMetadata!(absolute);
  if (metadata.kind === 'missing') throw new ProjectSourceInventoryError('input-missing');
  if (metadata.kind !== 'file' || metadata.byteSize === undefined || !metadata.mtimeNanoseconds)
    throw new ProjectSourceInventoryError(
      metadata.kind === 'symlink' ? 'input-symlink' : 'input-not-regular-file',
    );

  let real: string;
  try {
    real = await fileSystem.realpath(absolute);
  } catch {
    throw new ProjectSourceInventoryError('input-realpath-unavailable');
  }
  const relation = fileSystem.relativePath(projectRootRealPath, real);
  if (relationEscapesProject(relation))
    throw new ProjectSourceInventoryError('input-escapes-project');

  return {
    path: normalized,
    byteSize: metadata.byteSize,
    mtimeNanoseconds: metadata.mtimeNanoseconds,
  };
}

async function discoverScopeCandidates(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  scope: ProjectSourceDiscoveryScope,
): Promise<string[]> {
  const found: string[] = [];

  async function walk(relativeDirectory: string): Promise<void> {
    if (scopeExcludes(scope, `${relativeDirectory}/`)) return;
    const absoluteDirectory = fileSystem.joinPath(projectRoot, relativeDirectory);
    const metadata = await fileSystem.readPathMetadata!(absoluteDirectory);
    if (metadata.kind === 'missing') return;
    if (metadata.kind === 'symlink') throw new ProjectSourceInventoryError('discovery-symlink');
    if (metadata.kind !== 'directory')
      throw new ProjectSourceInventoryError('discovery-root-not-directory');

    let names: readonly string[];
    try {
      names = await fileSystem.listDirectory(absoluteDirectory);
    } catch {
      throw new ProjectSourceInventoryError('discovery-directory-unreadable');
    }

    for (const name of [...names].sort(compareProjectWorkspaceUnicodeCodePoints)) {
      const relative = `${relativeDirectory}/${name}`;
      if (scopeExcludes(scope, relative)) continue;
      const absolute = fileSystem.joinPath(projectRoot, relative);
      const entry = await fileSystem.readPathMetadata!(absolute);
      const candidate = matchesCandidateExtension(scope, relative);
      if (candidate && entry.kind !== 'file') {
        if (entry.kind === 'symlink') throw new ProjectSourceInventoryError('discovery-symlink');
        throw new ProjectSourceInventoryError('discovery-candidate-not-regular-file');
      }
      if (entry.kind === 'directory') {
        await walk(relative);
        continue;
      }
      if (entry.kind === 'symlink') {
        const followed = await fileSystem.inspect(absolute);
        if (followed === 'directory') throw new ProjectSourceInventoryError('discovery-symlink');
        continue;
      }
      if (candidate) found.push(relative);
    }
  }

  await walk(scope.root);
  return found;
}

export async function captureProjectSourceInventory(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  request: ProjectSourceInventoryRequest,
): Promise<ProjectSourceInventory> {
  if (!fileSystem.readPathMetadata) throw new ProjectSourceInventoryError('metadata-unavailable');

  let projectRootRealPath: string;
  try {
    projectRootRealPath = await fileSystem.realpath(projectRoot);
  } catch {
    throw new ProjectSourceInventoryError('project-root-realpath-unavailable');
  }

  const paths = new Set(request.authoritativePaths.map(normalizeRelativePath));
  for (const scope of request.discoveryScopes ?? [])
    for (const candidate of await discoverScopeCandidates(fileSystem, projectRoot, scope))
      paths.add(normalizeRelativePath(candidate));

  const entries: ProjectSourceInventoryEntry[] = [];
  for (const relative of [...paths].sort(compareProjectWorkspaceUnicodeCodePoints))
    entries.push(await captureRegularFile(fileSystem, projectRoot, projectRootRealPath, relative));
  return { entries };
}

export function projectSourceInventoriesEqual(
  left: ProjectSourceInventory,
  right: ProjectSourceInventory,
): boolean {
  if (left.entries.length !== right.entries.length) return false;
  return left.entries.every((entry, index) => {
    const other = right.entries[index];
    return (
      other !== undefined &&
      entry.path === other.path &&
      entry.byteSize === other.byteSize &&
      entry.mtimeNanoseconds === other.mtimeNanoseconds
    );
  });
}

export function projectSourceDiscoveryScopesEqual(
  left: readonly ProjectSourceDiscoveryScope[],
  right: readonly ProjectSourceDiscoveryScope[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((scope, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      scope.root === other.root &&
      scope.extensions.length === other.extensions.length &&
      scope.extensions.every(
        (extension, extensionIndex) => extension === other.extensions[extensionIndex],
      ) &&
      scope.excludedPrefixes.length === other.excludedPrefixes.length &&
      scope.excludedPrefixes.every(
        (prefix, prefixIndex) => prefix === other.excludedPrefixes[prefixIndex],
      )
    );
  });
}
