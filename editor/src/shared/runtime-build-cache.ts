import { z } from 'zod';
import { NOVELTEA_BUILD_IDENTITY, NOVELTEA_VERSION } from './product-version';
import {
  COMPILED_PROJECT_FORMAT_VERSION,
  COMPILED_PROJECT_SCHEMA,
} from './project-schema/compiled-project';
import {
  PREPARED_RUNTIME_ARTIFACT_SCHEMA,
  preparedRuntimeArtifactSchema,
  type PreparedRuntimeArtifact,
} from './project-schema/prepared-runtime-artifact';
import {
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
  assertProjectWorkspacePathContained,
  assetSourcePaths,
  compareProjectWorkspaceUnicodeCodePoints,
  type LoadedProjectWorkspaceSnapshot,
  type ProjectWorkspaceFileSystem,
  type ProjectWorkspaceProcessLiveness,
} from './project-workspace';
import { sha256PrefixedUtf8 } from './web-crypto';

export const RUNTIME_BUILD_CACHE_SCHEMA = 'noveltea.runtime-build-cache' as const;
export const RUNTIME_BUILD_CACHE_ROOT = '.noveltea/cache/runtime' as const;
export const RUNTIME_BUILD_CACHE_COMPILER_IDENTITY = `${NOVELTEA_VERSION}:${NOVELTEA_BUILD_IDENTITY}`;

export type RuntimeBuildCacheStatus = 'hit' | 'miss' | 'stale' | 'unusable';

export interface RuntimeBuildCacheObservation {
  readonly status: RuntimeBuildCacheStatus;
  readonly reason: string;
  readonly published?: boolean;
  readonly publicationReason?: string;
}

export interface RuntimeBuildCacheInputSnapshot {
  readonly entries: readonly RuntimeBuildCacheInputEntry[];
}

interface RuntimeBuildCacheInputEntry {
  readonly path: string;
  readonly byteSize: number;
  readonly mtimeMilliseconds: number;
  readonly mtimeNanoseconds?: string;
}

export interface RuntimeBuildCachePublicationHost {
  readonly pid: number;
  readonly processLiveness: ProjectWorkspaceProcessLiveness;
}

interface RuntimeBuildCacheSourceRevisionEntry {
  readonly path: string;
  readonly contentHash: string;
  readonly byteSize: number;
}

interface RuntimeBuildCacheDiscoveryScope {
  readonly root: string;
  readonly extensions: readonly string[];
  readonly excludedPrefixes: readonly string[];
}

const cacheGenerationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const runtimeDiscoveryScopes: readonly RuntimeBuildCacheDiscoveryScope[] = [
  {
    root: 'records',
    extensions: ['.json', '.lua', '.rcss', '.rml'],
    excludedPrefixes: ['records/tests/'],
  },
  { root: 'scripts', extensions: ['.lua'], excludedPrefixes: [] },
  { root: 'i18n', extensions: ['.json'], excludedPrefixes: [] },
] as const;

const inputEntrySchema = z
  .object({
    path: z.string().min(1),
    byteSize: z.number().int().nonnegative(),
    mtimeMilliseconds: z.number().finite(),
    mtimeNanoseconds: z.string().regex(/^\d+$/u).optional(),
  })
  .strict();

const sourceRevisionEntrySchema = z
  .object({
    path: z.string().min(1),
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    byteSize: z.number().int().nonnegative(),
  })
  .strict();

const discoveryScopeSchema = z
  .object({
    root: z.string().min(1),
    extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/u)).min(1),
    excludedPrefixes: z.array(z.string()),
  })
  .strict();

const runtimeBuildCacheManifestSchema = z
  .object({
    schema: z.literal(RUNTIME_BUILD_CACHE_SCHEMA),
    variant: z.literal('canonical-runtime'),
    compilerIdentity: z.string().min(1),
    projectWorkspace: z
      .object({
        schema: z.literal(PROJECT_WORKSPACE_SCHEMA),
        formatVersion: z.literal(PROJECT_WORKSPACE_SCHEMA_VERSION),
      })
      .strict(),
    compiledProject: z
      .object({
        schema: z.literal(COMPILED_PROJECT_SCHEMA),
        formatVersion: z.literal(COMPILED_PROJECT_FORMAT_VERSION),
      })
      .strict(),
    preparedArtifactSchema: z.literal(PREPARED_RUNTIME_ARTIFACT_SCHEMA),
    discoveryScopes: z.array(discoveryScopeSchema),
    sourceRevisions: z.array(sourceRevisionEntrySchema),
    inputs: z.array(inputEntrySchema),
    artifactFile: z.literal('artifact.json'),
    artifactSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict();

type RuntimeBuildCacheManifest = z.infer<typeof runtimeBuildCacheManifestSchema>;

export type RuntimeBuildCacheLookup =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly observation: RuntimeBuildCacheObservation;
      readonly inputSnapshot?: RuntimeBuildCacheInputSnapshot;
      readonly artifact?: PreparedRuntimeArtifact;
    };

class RuntimeBuildCacheInputError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+/, '');
}

function runtimeCanonicalSourcePaths(snapshot: LoadedProjectWorkspaceSnapshot): string[] {
  return snapshot.canonicalSourceFiles.filter(
    (file) => file !== 'editor.json' && !file.startsWith('records/tests/'),
  );
}

function runtimeSourceRevisions(
  snapshot: LoadedProjectWorkspaceSnapshot,
): RuntimeBuildCacheSourceRevisionEntry[] {
  return runtimeCanonicalSourcePaths(snapshot).map((file) => {
    const revision = snapshot.fileRevisions[file];
    if (!revision) throw new RuntimeBuildCacheInputError('workspace-source-revision-missing');
    return { path: file, contentHash: revision.contentHash, byteSize: revision.byteSize };
  });
}

function runtimeAuthoritativePaths(snapshot: LoadedProjectWorkspaceSnapshot): string[] {
  const paths = new Set(runtimeCanonicalSourcePaths(snapshot));
  for (const file of assetSourcePaths(snapshot.project)) paths.add(file);
  return [...paths].sort(compareProjectWorkspaceUnicodeCodePoints);
}

function scopeExcludes(scope: RuntimeBuildCacheDiscoveryScope, relative: string): boolean {
  return scope.excludedPrefixes.some(
    (prefix) => relative === prefix.replace(/\/$/u, '') || relative.startsWith(prefix),
  );
}

function matchesCandidateExtension(
  scope: RuntimeBuildCacheDiscoveryScope,
  relative: string,
): boolean {
  if (scopeExcludes(scope, relative)) return false;
  return scope.extensions.some((extension) => relative.endsWith(extension));
}

async function assertContainedRegularFile(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  projectRootRealPath: string,
  relative: string,
): Promise<RuntimeBuildCacheInputEntry> {
  const absolute = fileSystem.joinPath(projectRoot, relative);
  const metadata = await fileSystem.readPathMetadata!(absolute);
  if (metadata.kind === 'missing') throw new RuntimeBuildCacheInputError('input-missing');
  if (
    metadata.kind !== 'file' ||
    metadata.byteSize === undefined ||
    metadata.mtimeMilliseconds === undefined
  )
    throw new RuntimeBuildCacheInputError(
      metadata.kind === 'symlink' ? 'input-symlink' : 'input-not-regular-file',
    );
  let real: string;
  try {
    real = await fileSystem.realpath(absolute);
  } catch {
    throw new RuntimeBuildCacheInputError('input-realpath-unavailable');
  }
  const relation = normalizeRelativePath(fileSystem.relativePath(projectRootRealPath, real));
  if (relation === '..' || relation.startsWith('../'))
    throw new RuntimeBuildCacheInputError('input-escapes-project');
  return {
    path: normalizeRelativePath(relative),
    byteSize: metadata.byteSize,
    mtimeMilliseconds: metadata.mtimeMilliseconds,
    ...(metadata.mtimeNanoseconds ? { mtimeNanoseconds: metadata.mtimeNanoseconds } : {}),
  };
}

async function discoverScopeCandidates(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  scope: RuntimeBuildCacheDiscoveryScope,
): Promise<string[]> {
  const found: string[] = [];

  async function walk(relativeDirectory: string): Promise<void> {
    if (scopeExcludes(scope, `${relativeDirectory}/`)) return;
    const absoluteDirectory = fileSystem.joinPath(projectRoot, relativeDirectory);
    const metadata = await fileSystem.readPathMetadata!(absoluteDirectory);
    if (metadata.kind === 'missing') return;
    if (metadata.kind === 'symlink') throw new RuntimeBuildCacheInputError('discovery-symlink');
    if (metadata.kind !== 'directory')
      throw new RuntimeBuildCacheInputError('discovery-root-not-directory');
    let names: readonly string[];
    try {
      names = await fileSystem.listDirectory(absoluteDirectory);
    } catch {
      throw new RuntimeBuildCacheInputError('discovery-directory-unreadable');
    }
    for (const name of [...names].sort(compareProjectWorkspaceUnicodeCodePoints)) {
      const relative = `${relativeDirectory}/${name}`;
      if (scopeExcludes(scope, relative)) continue;
      const absolute = fileSystem.joinPath(projectRoot, relative);
      const entry = await fileSystem.readPathMetadata!(absolute);
      const candidate = matchesCandidateExtension(scope, relative);
      if (candidate && entry.kind !== 'file') {
        if (entry.kind === 'symlink') throw new RuntimeBuildCacheInputError('discovery-symlink');
        throw new RuntimeBuildCacheInputError('discovery-candidate-not-regular-file');
      }
      if (entry.kind === 'directory') {
        await walk(relative);
        continue;
      }
      if (entry.kind === 'symlink') {
        const followed = await fileSystem.inspect(absolute);
        if (followed === 'directory') throw new RuntimeBuildCacheInputError('discovery-symlink');
        continue;
      }
      if (candidate) found.push(relative);
    }
  }

  await walk(scope.root);
  return found;
}

async function captureRuntimeInputs(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
): Promise<RuntimeBuildCacheInputSnapshot> {
  if (!fileSystem.readPathMetadata) throw new RuntimeBuildCacheInputError('metadata-unavailable');
  let projectRootRealPath: string;
  try {
    projectRootRealPath = await fileSystem.realpath(snapshot.projectRoot);
  } catch {
    throw new RuntimeBuildCacheInputError('project-root-realpath-unavailable');
  }
  const paths = new Set(runtimeAuthoritativePaths(snapshot));
  for (const scope of runtimeDiscoveryScopes)
    for (const candidate of await discoverScopeCandidates(fileSystem, snapshot.projectRoot, scope))
      paths.add(candidate);

  const entries: RuntimeBuildCacheInputEntry[] = [];
  for (const relative of [...paths].sort(compareProjectWorkspaceUnicodeCodePoints))
    entries.push(
      await assertContainedRegularFile(
        fileSystem,
        snapshot.projectRoot,
        projectRootRealPath,
        relative,
      ),
    );
  return { entries };
}

function sameInputSnapshot(
  left: RuntimeBuildCacheInputSnapshot,
  right: RuntimeBuildCacheInputSnapshot,
): boolean {
  if (left.entries.length !== right.entries.length) return false;
  return left.entries.every((entry, index) => {
    const other = right.entries[index];
    if (
      !other ||
      entry.path !== other.path ||
      entry.byteSize !== other.byteSize ||
      entry.mtimeMilliseconds !== other.mtimeMilliseconds
    )
      return false;
    return (
      !entry.mtimeNanoseconds ||
      !other.mtimeNanoseconds ||
      entry.mtimeNanoseconds === other.mtimeNanoseconds
    );
  });
}

function sameDiscoveryScopes(value: readonly RuntimeBuildCacheDiscoveryScope[]): boolean {
  return JSON.stringify(value) === JSON.stringify(runtimeDiscoveryScopes);
}

function sameSourceRevisions(
  left: readonly RuntimeBuildCacheSourceRevisionEntry[],
  right: readonly RuntimeBuildCacheSourceRevisionEntry[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readContainedCacheText(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  absolute: string,
): Promise<string> {
  const metadata = await fileSystem.readPathMetadata!(absolute);
  if (metadata.kind !== 'file') throw new RuntimeBuildCacheInputError('cache-file-not-regular');
  const rootReal = await fileSystem.realpath(projectRoot);
  const fileReal = await fileSystem.realpath(absolute);
  const relation = normalizeRelativePath(fileSystem.relativePath(rootReal, fileReal));
  if (relation === '..' || relation.startsWith('../'))
    throw new RuntimeBuildCacheInputError('cache-file-escapes-project');
  return fileSystem.readText(absolute);
}

function currentPointerPath(fileSystem: ProjectWorkspaceFileSystem, projectRoot: string): string {
  return fileSystem.joinPath(projectRoot, RUNTIME_BUILD_CACHE_ROOT, 'current');
}

function generationsRoot(fileSystem: ProjectWorkspaceFileSystem, projectRoot: string): string {
  return fileSystem.joinPath(projectRoot, RUNTIME_BUILD_CACHE_ROOT, 'generations');
}

function generationDirectory(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  generation: string,
): string {
  return fileSystem.joinPath(generationsRoot(fileSystem, projectRoot), generation);
}

function generationId(): string {
  return globalThis.crypto.randomUUID();
}

function manifestFor(
  compilerIdentity: string,
  snapshot: LoadedProjectWorkspaceSnapshot,
  inputSnapshot: RuntimeBuildCacheInputSnapshot,
  artifactSha256: `sha256:${string}`,
): RuntimeBuildCacheManifest {
  return {
    schema: RUNTIME_BUILD_CACHE_SCHEMA,
    variant: 'canonical-runtime',
    compilerIdentity,
    projectWorkspace: {
      schema: PROJECT_WORKSPACE_SCHEMA,
      formatVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
    },
    compiledProject: {
      schema: COMPILED_PROJECT_SCHEMA,
      formatVersion: COMPILED_PROJECT_FORMAT_VERSION,
    },
    preparedArtifactSchema: PREPARED_RUNTIME_ARTIFACT_SCHEMA,
    discoveryScopes: runtimeDiscoveryScopes.map((scope) => ({
      root: scope.root,
      extensions: [...scope.extensions],
      excludedPrefixes: [...scope.excludedPrefixes],
    })),
    sourceRevisions: runtimeSourceRevisions(snapshot),
    inputs: [...inputSnapshot.entries],
    artifactFile: 'artifact.json',
    artifactSha256,
  };
}

export async function lookupCanonicalRuntimeBuildCache(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  compilerIdentity = RUNTIME_BUILD_CACHE_COMPILER_IDENTITY,
): Promise<RuntimeBuildCacheLookup> {
  if (!fileSystem.readPathMetadata) return { enabled: false };

  let inputs: RuntimeBuildCacheInputSnapshot;
  try {
    inputs = await captureRuntimeInputs(fileSystem, snapshot);
  } catch (error) {
    return {
      enabled: true,
      observation: {
        status: 'unusable',
        reason:
          error instanceof RuntimeBuildCacheInputError ? error.reason : 'input-inspection-failed',
      },
    };
  }

  const pointer = currentPointerPath(fileSystem, snapshot.projectRoot);
  let pointerMetadata;
  try {
    pointerMetadata = await fileSystem.readPathMetadata(pointer);
  } catch {
    return {
      enabled: true,
      observation: { status: 'unusable', reason: 'current-generation-unreadable' },
      inputSnapshot: inputs,
    };
  }
  if (pointerMetadata.kind === 'missing')
    return {
      enabled: true,
      observation: { status: 'miss', reason: 'current-generation-missing' },
      inputSnapshot: inputs,
    };
  if (pointerMetadata.kind !== 'file')
    return {
      enabled: true,
      observation: { status: 'unusable', reason: 'current-generation-not-regular' },
      inputSnapshot: inputs,
    };

  let generation: string;
  try {
    generation = (await readContainedCacheText(fileSystem, snapshot.projectRoot, pointer)).trim();
  } catch (error) {
    return {
      enabled: true,
      observation: {
        status: 'unusable',
        reason:
          error instanceof RuntimeBuildCacheInputError
            ? error.reason
            : 'current-generation-unreadable',
      },
      inputSnapshot: inputs,
    };
  }
  if (!cacheGenerationIdPattern.test(generation))
    return {
      enabled: true,
      observation: { status: 'unusable', reason: 'current-generation-invalid' },
      inputSnapshot: inputs,
    };

  const directory = generationDirectory(fileSystem, snapshot.projectRoot, generation);
  try {
    const generationMetadata = await fileSystem.readPathMetadata(directory);
    if (generationMetadata.kind !== 'directory')
      throw new RuntimeBuildCacheInputError('generation-not-directory');
  } catch (error) {
    return {
      enabled: true,
      observation: {
        status: 'unusable',
        reason:
          error instanceof RuntimeBuildCacheInputError ? error.reason : 'generation-unreadable',
      },
      inputSnapshot: inputs,
    };
  }
  let manifest: RuntimeBuildCacheManifest;
  try {
    const parsed = runtimeBuildCacheManifestSchema.safeParse(
      JSON.parse(
        await readContainedCacheText(
          fileSystem,
          snapshot.projectRoot,
          fileSystem.joinPath(directory, 'manifest.json'),
        ),
      ),
    );
    if (!parsed.success) throw new Error('invalid manifest');
    manifest = parsed.data;
  } catch {
    return {
      enabled: true,
      observation: { status: 'unusable', reason: 'manifest-invalid' },
      inputSnapshot: inputs,
    };
  }

  if (manifest.compilerIdentity !== compilerIdentity)
    return {
      enabled: true,
      observation: { status: 'stale', reason: 'compiler-identity-changed' },
      inputSnapshot: inputs,
    };
  if (!sameDiscoveryScopes(manifest.discoveryScopes))
    return {
      enabled: true,
      observation: { status: 'stale', reason: 'discovery-contract-changed' },
      inputSnapshot: inputs,
    };
  let currentSourceRevisions: RuntimeBuildCacheSourceRevisionEntry[];
  try {
    currentSourceRevisions = runtimeSourceRevisions(snapshot);
  } catch {
    return {
      enabled: true,
      observation: { status: 'unusable', reason: 'workspace-source-revision-missing' },
      inputSnapshot: inputs,
    };
  }
  if (!sameSourceRevisions(manifest.sourceRevisions, currentSourceRevisions))
    return {
      enabled: true,
      observation: { status: 'stale', reason: 'workspace-source-revision-changed' },
      inputSnapshot: inputs,
    };
  if (!sameInputSnapshot({ entries: manifest.inputs }, inputs))
    return {
      enabled: true,
      observation: { status: 'stale', reason: 'input-metadata-changed' },
      inputSnapshot: inputs,
    };

  try {
    const artifactText = await readContainedCacheText(
      fileSystem,
      snapshot.projectRoot,
      fileSystem.joinPath(directory, manifest.artifactFile),
    );
    if ((await sha256PrefixedUtf8(artifactText)) !== manifest.artifactSha256)
      return {
        enabled: true,
        observation: { status: 'unusable', reason: 'artifact-digest-mismatch' },
        inputSnapshot: inputs,
      };
    const artifact = preparedRuntimeArtifactSchema.parse(JSON.parse(artifactText));
    return {
      enabled: true,
      observation: { status: 'hit', reason: 'current-generation-valid' },
      inputSnapshot: inputs,
      artifact,
    };
  } catch {
    return {
      enabled: true,
      observation: { status: 'unusable', reason: 'artifact-invalid' },
      inputSnapshot: inputs,
    };
  }
}

const CACHE_GENERATION_CLEANUP_GRACE_MILLISECONDS = 24 * 60 * 60 * 1000;
const CACHE_GENERATION_RETIRED_FILE = 'retired';
const CACHE_GENERATION_PUBLISHED_FILE = 'published';
const CACHE_GENERATION_WRITER_FILE = 'writer.json';
const CACHE_GENERATION_WRITER_SCHEMA = 'noveltea.runtime-build-cache.writer';

const cacheGenerationWriterSchema = z
  .object({
    schema: z.literal(CACHE_GENERATION_WRITER_SCHEMA),
    pid: z.number().int().positive(),
    startedAtMs: z.number().int().nonnegative(),
  })
  .strict();

async function writeGenerationWriterLease(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  generation: string,
  host: RuntimeBuildCachePublicationHost,
): Promise<void> {
  await fileSystem.writeTextAtomic(
    fileSystem.joinPath(
      generationDirectory(fileSystem, snapshot.projectRoot, generation),
      CACHE_GENERATION_WRITER_FILE,
    ),
    `${JSON.stringify({
      schema: CACHE_GENERATION_WRITER_SCHEMA,
      pid: host.pid,
      startedAtMs: Date.now(),
    })}\n`,
  );
}

async function markGenerationPublished(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  generation: string,
): Promise<void> {
  try {
    await fileSystem.writeTextAtomic(
      fileSystem.joinPath(
        generationDirectory(fileSystem, snapshot.projectRoot, generation),
        CACHE_GENERATION_PUBLISHED_FILE,
      ),
      `${Date.now()}\n`,
    );
    await fileSystem.removeFile(
      fileSystem.joinPath(
        generationDirectory(fileSystem, snapshot.projectRoot, generation),
        CACHE_GENERATION_WRITER_FILE,
      ),
    );
  } catch {
    // Current-generation publication is already committed; bookkeeping is best-effort.
  }
}

async function markGenerationRetired(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  generation: string | null,
): Promise<void> {
  if (!generation || !cacheGenerationIdPattern.test(generation)) return;
  try {
    await fileSystem.writeTextAtomic(
      fileSystem.joinPath(
        generationDirectory(fileSystem, snapshot.projectRoot, generation),
        CACHE_GENERATION_RETIRED_FILE,
      ),
      `${Date.now()}\n`,
    );
  } catch {
    // Retirement bookkeeping is only for best-effort cleanup.
  }
}

async function metadataIsOlderThan(
  fileSystem: ProjectWorkspaceFileSystem,
  path: string,
  cutoffMs: number,
): Promise<boolean> {
  const metadata = await fileSystem.readPathMetadata!(path);
  return (
    metadata.kind === 'file' &&
    metadata.mtimeMilliseconds !== undefined &&
    metadata.mtimeMilliseconds < cutoffMs
  );
}

async function cleanupOldGenerations(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  current: string,
  previous: string | null,
  host: RuntimeBuildCachePublicationHost,
): Promise<void> {
  const root = generationsRoot(fileSystem, snapshot.projectRoot);
  let names: readonly string[];
  try {
    names = await fileSystem.listDirectory(root);
  } catch {
    return;
  }
  const cutoffMs = Date.now() - CACHE_GENERATION_CLEANUP_GRACE_MILLISECONDS;
  for (const name of names) {
    if (name === current || name === previous || !cacheGenerationIdPattern.test(name)) continue;
    const directory = fileSystem.joinPath(root, name);
    try {
      if (
        (await metadataIsOlderThan(
          fileSystem,
          fileSystem.joinPath(directory, CACHE_GENERATION_RETIRED_FILE),
          cutoffMs,
        )) ||
        (await metadataIsOlderThan(
          fileSystem,
          fileSystem.joinPath(directory, CACHE_GENERATION_PUBLISHED_FILE),
          cutoffMs,
        ))
      ) {
        await fileSystem.removeDirectory(directory);
        continue;
      }

      const writerPath = fileSystem.joinPath(directory, CACHE_GENERATION_WRITER_FILE);
      const writerMetadata = await fileSystem.readPathMetadata!(writerPath);
      if (writerMetadata.kind === 'file') {
        if (
          writerMetadata.mtimeMilliseconds === undefined ||
          writerMetadata.mtimeMilliseconds >= cutoffMs
        )
          continue;
        let writerPid: number | null = null;
        try {
          const parsed = cacheGenerationWriterSchema.safeParse(
            JSON.parse(await readContainedCacheText(fileSystem, snapshot.projectRoot, writerPath)),
          );
          if (parsed.success) writerPid = parsed.data.pid;
        } catch {
          writerPid = null;
        }
        if (writerPid !== null) {
          const alive = await host.processLiveness.isProcessAlive(writerPid);
          if (alive !== false) continue;
        }
        await fileSystem.removeDirectory(directory);
        continue;
      }

      const directoryMetadata = await fileSystem.readPathMetadata!(directory);
      if (
        directoryMetadata.kind === 'directory' &&
        directoryMetadata.mtimeMilliseconds !== undefined &&
        directoryMetadata.mtimeMilliseconds < cutoffMs
      )
        await fileSystem.removeDirectory(directory);
    } catch {
      // Obsolete/abandoned cache cleanup must never affect playback.
    }
  }
}

export async function publishCanonicalRuntimeBuildCache(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  currentSnapshot: LoadedProjectWorkspaceSnapshot,
  artifact: PreparedRuntimeArtifact,
  expectedInputs: RuntimeBuildCacheInputSnapshot,
  host: RuntimeBuildCachePublicationHost,
  compilerIdentity = RUNTIME_BUILD_CACHE_COMPILER_IDENTITY,
): Promise<Readonly<{ published: boolean; reason?: string }>> {
  if (!fileSystem.readPathMetadata) return { published: false, reason: 'metadata-unavailable' };

  let originalSourceRevisions: RuntimeBuildCacheSourceRevisionEntry[];
  let currentSourceRevisions: RuntimeBuildCacheSourceRevisionEntry[];
  try {
    originalSourceRevisions = runtimeSourceRevisions(snapshot);
    currentSourceRevisions = runtimeSourceRevisions(currentSnapshot);
  } catch {
    return { published: false, reason: 'workspace-source-revision-missing' };
  }
  if (!sameSourceRevisions(originalSourceRevisions, currentSourceRevisions))
    return { published: false, reason: 'workspace-source-changed-during-preparation' };

  let currentInputs: RuntimeBuildCacheInputSnapshot;
  try {
    currentInputs = await captureRuntimeInputs(fileSystem, snapshot);
  } catch (error) {
    return {
      published: false,
      reason:
        error instanceof RuntimeBuildCacheInputError ? error.reason : 'input-inspection-failed',
    };
  }
  if (!sameInputSnapshot(expectedInputs, currentInputs))
    return { published: false, reason: 'inputs-changed-during-preparation' };

  let previous: string | null = null;
  try {
    const pointer = currentPointerPath(fileSystem, snapshot.projectRoot);
    if ((await fileSystem.readPathMetadata(pointer)).kind === 'file')
      previous = (await readContainedCacheText(fileSystem, snapshot.projectRoot, pointer)).trim();
  } catch {
    previous = null;
  }

  const id = generationId();
  const directory = generationDirectory(fileSystem, snapshot.projectRoot, id);
  const pointer = currentPointerPath(fileSystem, snapshot.projectRoot);
  try {
    await assertProjectWorkspacePathContained(fileSystem, snapshot.projectRoot, directory);
    await assertProjectWorkspacePathContained(fileSystem, snapshot.projectRoot, pointer);
    await fileSystem.createDirectory(directory);
    await writeGenerationWriterLease(fileSystem, snapshot, id, host);
    const artifactText = `${JSON.stringify(artifact)}\n`;
    const artifactSha256 = await sha256PrefixedUtf8(artifactText);
    await fileSystem.writeTextAtomic(fileSystem.joinPath(directory, 'artifact.json'), artifactText);
    await fileSystem.writeTextAtomic(
      fileSystem.joinPath(directory, 'manifest.json'),
      `${JSON.stringify(
        manifestFor(compilerIdentity, currentSnapshot, currentInputs, artifactSha256),
      )}\n`,
    );
  } catch {
    try {
      await fileSystem.removeDirectory(directory);
    } catch {
      // A failed cache publication is disposable state.
    }
    return { published: false, reason: 'cache-publication-failed' };
  }

  try {
    await fileSystem.writeTextAtomic(pointer, `${id}\n`);
  } catch {
    try {
      await fileSystem.removeDirectory(directory);
    } catch {
      // A failed cache publication is disposable state.
    }
    return { published: false, reason: 'cache-publication-failed' };
  }

  await markGenerationPublished(fileSystem, snapshot, id);
  await markGenerationRetired(fileSystem, snapshot, previous);
  await cleanupOldGenerations(fileSystem, snapshot, id, previous, host);
  return { published: true };
}
