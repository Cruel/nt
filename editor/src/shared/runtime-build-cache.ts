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
import { runtimeTestCatalogSchema, type RuntimeTestCatalog } from './runtime-test-catalog';
import { validateAuthoringProject } from './project-schema/authoring-validation';

export const RUNTIME_BUILD_CACHE_SCHEMA = 'noveltea.runtime-build-cache' as const;
export const RUNTIME_BUILD_CACHE_ROOT = '.noveltea/cache/runtime' as const;
export const RUNTIME_BUILD_CACHE_COMPILER_IDENTITY = `${NOVELTEA_VERSION}:${NOVELTEA_BUILD_IDENTITY}`;
export const RUNTIME_BUILD_CACHE_CANONICAL_VARIANT = 'canonical-runtime' as const;

export type RuntimeBuildCacheStatus = 'hit' | 'miss' | 'stale' | 'unusable';

export interface RuntimeBuildCacheObservation {
  readonly status: RuntimeBuildCacheStatus;
  readonly reason: string;
  readonly testCatalogStatus?: RuntimeBuildCacheStatus;
  readonly testCatalogReason?: string;
  readonly published?: boolean;
  readonly publicationReason?: string;
}

export interface RuntimeBuildCacheInputSnapshot {
  readonly entries: readonly RuntimeBuildCacheInputEntry[];
}

interface RuntimeBuildCacheInputEntry {
  readonly path: string;
  readonly byteSize: number;
  readonly mtimeNanoseconds: string;
}

export interface RuntimeBuildCachePublicationHost {
  readonly pid: number;
  readonly processLiveness: ProjectWorkspaceProcessLiveness;
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
    mtimeNanoseconds: z.string().regex(/^\d+$/u),
  })
  .strict();

const discoveryScopeSchema = z
  .object({
    root: z.string().min(1),
    extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/u)).min(1),
    excludedPrefixes: z.array(z.string()),
  })
  .strict();

const cachedAuthoringDiagnosticSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(['error', 'warning', 'info']),
    path: z.string(),
    message: z.string(),
  })
  .strict();

const runtimeBuildCacheManifestSchema = z
  .object({
    schema: z.literal(RUNTIME_BUILD_CACHE_SCHEMA),
    variant: z.string().min(1),
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
    authoringDiagnostics: z.array(cachedAuthoringDiagnosticSchema),
    inputs: z.array(inputEntrySchema),
    artifactFile: z.literal('artifact.json'),
    artifactSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    testCatalog: z
      .object({
        inputs: z.array(inputEntrySchema),
        catalogFile: z.literal('tests.json'),
        catalogSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      })
      .strict(),
  })
  .strict();

type RuntimeBuildCacheManifest = z.infer<typeof runtimeBuildCacheManifestSchema>;

export type RuntimeBuildCacheLookup =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly observation: RuntimeBuildCacheObservation;
      readonly inputSnapshot?: RuntimeBuildCacheInputSnapshot;
      readonly testInputSnapshot?: RuntimeBuildCacheInputSnapshot;
      readonly artifact?: PreparedRuntimeArtifact;
      readonly artifactText?: string;
      readonly testCatalog?: RuntimeTestCatalog;
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
  if (metadata.kind !== 'file' || metadata.byteSize === undefined || !metadata.mtimeNanoseconds)
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
    mtimeNanoseconds: metadata.mtimeNanoseconds,
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

async function captureTestInputs(
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
  const entries: RuntimeBuildCacheInputEntry[] = [];
  for (const relative of snapshot.canonicalSourceFiles
    .filter((file) => file.startsWith('records/tests/'))
    .sort(compareProjectWorkspaceUnicodeCodePoints))
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
  return JSON.stringify(left.entries) === JSON.stringify(right.entries);
}

function sameDiscoveryScopes(value: readonly RuntimeBuildCacheDiscoveryScope[]): boolean {
  return JSON.stringify(value) === JSON.stringify(runtimeDiscoveryScopes);
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

const PREVIEW_INDEX_SCHEMA = 'noveltea.runtime-build-cache.preview-index';
const MAX_PERSISTENT_PREVIEW_VARIANTS = 4;

const previewIndexSchema = z
  .object({
    schema: z.literal(PREVIEW_INDEX_SCHEMA),
    entries: z
      .array(
        z
          .object({
            variant: z.string().min(1),
            generation: z.string().regex(cacheGenerationIdPattern),
            lastUsedAtMs: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(MAX_PERSISTENT_PREVIEW_VARIANTS),
  })
  .strict();

type PreviewIndex = z.infer<typeof previewIndexSchema>;

function currentPointerPath(fileSystem: ProjectWorkspaceFileSystem, projectRoot: string): string {
  return fileSystem.joinPath(projectRoot, RUNTIME_BUILD_CACHE_ROOT, 'current');
}

function previewIndexPath(fileSystem: ProjectWorkspaceFileSystem, projectRoot: string): string {
  return fileSystem.joinPath(projectRoot, RUNTIME_BUILD_CACHE_ROOT, 'preview-index.json');
}

async function readPreviewIndex(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
): Promise<PreviewIndex> {
  const path = previewIndexPath(fileSystem, projectRoot);
  const metadata = await fileSystem.readPathMetadata!(path);
  if (metadata.kind === 'missing') return { schema: PREVIEW_INDEX_SCHEMA, entries: [] };
  if (metadata.kind !== 'file') throw new RuntimeBuildCacheInputError('preview-index-invalid');
  const parsed = previewIndexSchema.safeParse(
    JSON.parse(await readContainedCacheText(fileSystem, projectRoot, path)),
  );
  if (!parsed.success) throw new RuntimeBuildCacheInputError('preview-index-invalid');
  return parsed.data;
}

async function writePreviewIndex(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  index: PreviewIndex,
): Promise<void> {
  await fileSystem.writeTextAtomic(
    previewIndexPath(fileSystem, projectRoot),
    `${JSON.stringify(index)}\n`,
  );
}

async function touchPreviewIndexVariant(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  variant: string,
  generation: string,
): Promise<void> {
  try {
    const index = await readPreviewIndex(fileSystem, projectRoot);
    const entries = index.entries.filter((entry) => entry.variant !== variant);
    entries.push({ variant, generation, lastUsedAtMs: Date.now() });
    await writePreviewIndex(fileSystem, projectRoot, { schema: PREVIEW_INDEX_SCHEMA, entries });
  } catch {
    // Preview LRU bookkeeping is disposable and must not invalidate a usable generation.
  }
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
  variant: string,
  inputSnapshot: RuntimeBuildCacheInputSnapshot,
  testInputSnapshot: RuntimeBuildCacheInputSnapshot,
  authoringDiagnostics: RuntimeBuildCacheManifest['authoringDiagnostics'],
  artifactSha256: `sha256:${string}`,
  catalogSha256: `sha256:${string}`,
): RuntimeBuildCacheManifest {
  return {
    schema: RUNTIME_BUILD_CACHE_SCHEMA,
    variant,
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
    authoringDiagnostics,
    inputs: [...inputSnapshot.entries],
    artifactFile: 'artifact.json',
    artifactSha256,
    testCatalog: {
      inputs: [...testInputSnapshot.entries],
      catalogFile: 'tests.json',
      catalogSha256,
    },
  };
}

async function lookupRuntimeBuildCache(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  variant: string,
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

  let testInputs: RuntimeBuildCacheInputSnapshot | undefined;
  try {
    testInputs = await captureTestInputs(fileSystem, snapshot);
  } catch {
    testInputs = undefined;
  }

  let generation: string;
  if (variant === RUNTIME_BUILD_CACHE_CANONICAL_VARIANT) {
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
  } else {
    try {
      const index = await readPreviewIndex(fileSystem, snapshot.projectRoot);
      const entry = index.entries.find((candidate) => candidate.variant === variant);
      if (!entry)
        return {
          enabled: true,
          observation: { status: 'miss', reason: 'preview-variant-missing' },
          inputSnapshot: inputs,
        };
      generation = entry.generation;
    } catch (error) {
      return {
        enabled: true,
        observation: {
          status: 'unusable',
          reason:
            error instanceof RuntimeBuildCacheInputError ? error.reason : 'preview-index-invalid',
        },
        inputSnapshot: inputs,
      };
    }
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

  if (manifest.variant !== variant)
    return {
      enabled: true,
      observation: { status: 'unusable', reason: 'manifest-variant-mismatch' },
      inputSnapshot: inputs,
    };
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
  if (!sameInputSnapshot({ entries: manifest.inputs }, inputs))
    return {
      enabled: true,
      observation: { status: 'stale', reason: 'input-metadata-changed' },
      inputSnapshot: inputs,
    };

  let artifact: PreparedRuntimeArtifact;
  let artifactText: string;
  try {
    artifactText = await readContainedCacheText(
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
    artifact = preparedRuntimeArtifactSchema.parse(JSON.parse(artifactText));
    if (variant !== RUNTIME_BUILD_CACHE_CANONICAL_VARIANT)
      await touchPreviewIndexVariant(fileSystem, snapshot.projectRoot, variant, generation);
  } catch {
    return {
      enabled: true,
      observation: { status: 'unusable', reason: 'artifact-invalid' },
      inputSnapshot: inputs,
    };
  }

  if (!testInputs)
    return {
      enabled: true,
      observation: {
        status: 'hit',
        reason: 'current-runtime-generation-valid',
        testCatalogStatus: 'unusable',
        testCatalogReason: 'test-input-inspection-failed',
      },
      inputSnapshot: inputs,
      artifact,
      artifactText,
    };
  if (!sameInputSnapshot({ entries: manifest.testCatalog.inputs }, testInputs))
    return {
      enabled: true,
      observation: {
        status: 'hit',
        reason: 'current-runtime-generation-valid',
        testCatalogStatus: 'stale',
        testCatalogReason: 'test-input-metadata-changed',
      },
      inputSnapshot: inputs,
      testInputSnapshot: testInputs,
      artifact,
      artifactText,
    };

  try {
    const catalogText = await readContainedCacheText(
      fileSystem,
      snapshot.projectRoot,
      fileSystem.joinPath(directory, manifest.testCatalog.catalogFile),
    );
    if ((await sha256PrefixedUtf8(catalogText)) !== manifest.testCatalog.catalogSha256)
      return {
        enabled: true,
        observation: {
          status: 'hit',
          reason: 'current-runtime-generation-valid',
          testCatalogStatus: 'unusable',
          testCatalogReason: 'test-catalog-digest-mismatch',
        },
        inputSnapshot: inputs,
        artifact,
        artifactText,
      };
    const testCatalog = runtimeTestCatalogSchema.parse(JSON.parse(catalogText));
    return {
      enabled: true,
      observation: {
        status: 'hit',
        reason: 'current-generation-valid',
        testCatalogStatus: 'hit',
        testCatalogReason: 'current-test-catalog-valid',
      },
      inputSnapshot: inputs,
      ...(testInputs ? { testInputSnapshot: testInputs } : {}),
      artifact,
      artifactText,
      testCatalog,
    };
  } catch {
    return {
      enabled: true,
      observation: {
        status: 'hit',
        reason: 'current-runtime-generation-valid',
        testCatalogStatus: 'unusable',
        testCatalogReason: 'test-catalog-invalid',
      },
      inputSnapshot: inputs,
      artifact,
      artifactText,
    };
  }
}

export function captureRuntimeBuildCacheTestInputs(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
): Promise<RuntimeBuildCacheInputSnapshot> {
  return captureTestInputs(fileSystem, snapshot);
}

export function lookupCanonicalRuntimeBuildCache(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  compilerIdentity = RUNTIME_BUILD_CACHE_COMPILER_IDENTITY,
): Promise<RuntimeBuildCacheLookup> {
  return lookupRuntimeBuildCache(
    fileSystem,
    snapshot,
    RUNTIME_BUILD_CACHE_CANONICAL_VARIANT,
    compilerIdentity,
  );
}

export function lookupRuntimeBuildCacheVariant(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  variant: string,
  compilerIdentity = RUNTIME_BUILD_CACHE_COMPILER_IDENTITY,
): Promise<RuntimeBuildCacheLookup> {
  if (variant === RUNTIME_BUILD_CACHE_CANONICAL_VARIANT)
    return lookupCanonicalRuntimeBuildCache(fileSystem, snapshot, compilerIdentity);
  return lookupRuntimeBuildCache(fileSystem, snapshot, variant, compilerIdentity);
}

const CACHE_GENERATION_CLEANUP_GRACE_NANOSECONDS = 24n * 60n * 60n * 1_000_000_000n;
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
  cutoffNanoseconds: bigint,
): Promise<boolean> {
  const metadata = await fileSystem.readPathMetadata!(path);
  return (
    metadata.kind === 'file' &&
    metadata.mtimeNanoseconds !== undefined &&
    BigInt(metadata.mtimeNanoseconds) < cutoffNanoseconds
  );
}

async function cleanupOldGenerations(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  retained: ReadonlySet<string>,
  host: RuntimeBuildCachePublicationHost,
): Promise<void> {
  const root = generationsRoot(fileSystem, snapshot.projectRoot);
  let names: readonly string[];
  try {
    names = await fileSystem.listDirectory(root);
  } catch {
    return;
  }
  const cutoffNanoseconds =
    BigInt(Date.now()) * 1_000_000n - CACHE_GENERATION_CLEANUP_GRACE_NANOSECONDS;
  for (const name of names) {
    if (retained.has(name) || !cacheGenerationIdPattern.test(name)) continue;
    const directory = fileSystem.joinPath(root, name);
    try {
      if (
        (await metadataIsOlderThan(
          fileSystem,
          fileSystem.joinPath(directory, CACHE_GENERATION_RETIRED_FILE),
          cutoffNanoseconds,
        )) ||
        (await metadataIsOlderThan(
          fileSystem,
          fileSystem.joinPath(directory, CACHE_GENERATION_PUBLISHED_FILE),
          cutoffNanoseconds,
        ))
      ) {
        await fileSystem.removeDirectory(directory);
        continue;
      }

      const writerPath = fileSystem.joinPath(directory, CACHE_GENERATION_WRITER_FILE);
      const writerMetadata = await fileSystem.readPathMetadata!(writerPath);
      if (writerMetadata.kind === 'file') {
        if (
          writerMetadata.mtimeNanoseconds === undefined ||
          BigInt(writerMetadata.mtimeNanoseconds) >= cutoffNanoseconds
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
        directoryMetadata.mtimeNanoseconds !== undefined &&
        BigInt(directoryMetadata.mtimeNanoseconds) < cutoffNanoseconds
      )
        await fileSystem.removeDirectory(directory);
    } catch {
      // Obsolete/abandoned cache cleanup must never affect playback.
    }
  }
}

async function publishRuntimeBuildCache(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  currentSnapshot: LoadedProjectWorkspaceSnapshot,
  artifact: PreparedRuntimeArtifact,
  testCatalog: RuntimeTestCatalog,
  expectedInputs: RuntimeBuildCacheInputSnapshot,
  expectedTestInputs: RuntimeBuildCacheInputSnapshot,
  reusedArtifactText: string | undefined,
  host: RuntimeBuildCachePublicationHost,
  variant: string,
  compilerIdentity = RUNTIME_BUILD_CACHE_COMPILER_IDENTITY,
): Promise<Readonly<{ published: boolean; reason?: string }>> {
  if (!fileSystem.readPathMetadata) return { published: false, reason: 'metadata-unavailable' };

  if (snapshot.sourceRevision !== currentSnapshot.sourceRevision)
    return { published: false, reason: 'workspace-source-changed-during-preparation' };

  let currentInputs: RuntimeBuildCacheInputSnapshot;
  let currentTestInputs: RuntimeBuildCacheInputSnapshot;
  try {
    currentInputs = await captureRuntimeInputs(fileSystem, currentSnapshot);
    currentTestInputs = await captureTestInputs(fileSystem, currentSnapshot);
  } catch (error) {
    return {
      published: false,
      reason:
        error instanceof RuntimeBuildCacheInputError ? error.reason : 'input-inspection-failed',
    };
  }
  if (!sameInputSnapshot(expectedInputs, currentInputs))
    return { published: false, reason: 'inputs-changed-during-preparation' };
  if (!sameInputSnapshot(expectedTestInputs, currentTestInputs))
    return { published: false, reason: 'test-inputs-changed-during-preparation' };

  const authoringDiagnostics = validateAuthoringProject(currentSnapshot.project).map((item) => ({
    code: item.code,
    severity: item.severity,
    path: item.path,
    message: item.message,
  }));

  let previous: string | null = null;
  let previewIndex: PreviewIndex = { schema: PREVIEW_INDEX_SCHEMA, entries: [] };
  if (variant === RUNTIME_BUILD_CACHE_CANONICAL_VARIANT) {
    try {
      const pointer = currentPointerPath(fileSystem, snapshot.projectRoot);
      if ((await fileSystem.readPathMetadata(pointer)).kind === 'file')
        previous = (await readContainedCacheText(fileSystem, snapshot.projectRoot, pointer)).trim();
    } catch {
      previous = null;
    }
  } else {
    try {
      previewIndex = await readPreviewIndex(fileSystem, snapshot.projectRoot);
      previous =
        previewIndex.entries.find((entry) => entry.variant === variant)?.generation ?? null;
    } catch {
      previewIndex = { schema: PREVIEW_INDEX_SCHEMA, entries: [] };
    }
  }

  const id = generationId();
  const directory = generationDirectory(fileSystem, snapshot.projectRoot, id);
  const pointer = currentPointerPath(fileSystem, snapshot.projectRoot);
  try {
    await assertProjectWorkspacePathContained(fileSystem, snapshot.projectRoot, directory);
    if (variant === RUNTIME_BUILD_CACHE_CANONICAL_VARIANT)
      await assertProjectWorkspacePathContained(fileSystem, snapshot.projectRoot, pointer);
    else
      await assertProjectWorkspacePathContained(
        fileSystem,
        snapshot.projectRoot,
        previewIndexPath(fileSystem, snapshot.projectRoot),
      );
    await fileSystem.createDirectory(directory);
    await writeGenerationWriterLease(fileSystem, snapshot, id, host);
    const artifactText = reusedArtifactText ?? `${JSON.stringify(artifact)}\n`;
    const artifactSha256 = await sha256PrefixedUtf8(artifactText);
    const catalogText = `${JSON.stringify(testCatalog)}\n`;
    const catalogSha256 = await sha256PrefixedUtf8(catalogText);
    await fileSystem.writeTextAtomic(fileSystem.joinPath(directory, 'artifact.json'), artifactText);
    await fileSystem.writeTextAtomic(fileSystem.joinPath(directory, 'tests.json'), catalogText);
    await fileSystem.writeTextAtomic(
      fileSystem.joinPath(directory, 'manifest.json'),
      `${JSON.stringify(
        manifestFor(
          compilerIdentity,
          variant,
          currentInputs,
          currentTestInputs,
          authoringDiagnostics,
          artifactSha256,
          catalogSha256,
        ),
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

  const retired: string[] = [];
  let activePreviewIndex = previewIndex;
  try {
    if (variant === RUNTIME_BUILD_CACHE_CANONICAL_VARIANT) {
      await fileSystem.writeTextAtomic(pointer, `${id}\n`);
      try {
        activePreviewIndex = await readPreviewIndex(fileSystem, snapshot.projectRoot);
      } catch {
        activePreviewIndex = { schema: PREVIEW_INDEX_SCHEMA, entries: [] };
      }
    } else {
      const nextEntries = previewIndex.entries
        .filter((entry) => entry.variant !== variant)
        .concat({ variant, generation: id, lastUsedAtMs: Date.now() })
        .sort((left, right) => right.lastUsedAtMs - left.lastUsedAtMs);
      for (const evicted of nextEntries.slice(MAX_PERSISTENT_PREVIEW_VARIANTS))
        retired.push(evicted.generation);
      activePreviewIndex = {
        schema: PREVIEW_INDEX_SCHEMA,
        entries: nextEntries.slice(0, MAX_PERSISTENT_PREVIEW_VARIANTS),
      };
      await writePreviewIndex(fileSystem, snapshot.projectRoot, activePreviewIndex);
    }
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
  if (variant !== RUNTIME_BUILD_CACHE_CANONICAL_VARIANT && previous) retired.push(previous);
  for (const generation of new Set(retired)) {
    if (!cacheGenerationIdPattern.test(generation) || generation === id) continue;
    await markGenerationRetired(fileSystem, snapshot, generation);
    try {
      await fileSystem.removeDirectory(
        generationDirectory(fileSystem, snapshot.projectRoot, generation),
      );
    } catch {
      // Preview LRU cleanup is best-effort after the new index/generation is already published.
    }
  }

  const retained = new Set(activePreviewIndex.entries.map((entry) => entry.generation));
  retained.add(id);
  if (variant !== RUNTIME_BUILD_CACHE_CANONICAL_VARIANT) {
    try {
      const canonicalPointer = currentPointerPath(fileSystem, snapshot.projectRoot);
      if ((await fileSystem.readPathMetadata(canonicalPointer)).kind === 'file') {
        const canonical = (
          await readContainedCacheText(fileSystem, snapshot.projectRoot, canonicalPointer)
        ).trim();
        if (cacheGenerationIdPattern.test(canonical)) retained.add(canonical);
      }
    } catch {
      // Cleanup is best-effort; inability to identify canonical retention must not fail publication.
    }
  }
  await cleanupOldGenerations(fileSystem, snapshot, retained, host);
  return { published: true };
}

export function publishCanonicalRuntimeBuildCache(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  currentSnapshot: LoadedProjectWorkspaceSnapshot,
  artifact: PreparedRuntimeArtifact,
  testCatalog: RuntimeTestCatalog,
  expectedInputs: RuntimeBuildCacheInputSnapshot,
  expectedTestInputs: RuntimeBuildCacheInputSnapshot,
  reusedArtifactText: string | undefined,
  host: RuntimeBuildCachePublicationHost,
  compilerIdentity = RUNTIME_BUILD_CACHE_COMPILER_IDENTITY,
): Promise<Readonly<{ published: boolean; reason?: string }>> {
  return publishRuntimeBuildCache(
    fileSystem,
    snapshot,
    currentSnapshot,
    artifact,
    testCatalog,
    expectedInputs,
    expectedTestInputs,
    reusedArtifactText,
    host,
    RUNTIME_BUILD_CACHE_CANONICAL_VARIANT,
    compilerIdentity,
  );
}

export function publishRuntimeBuildCacheVariant(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  currentSnapshot: LoadedProjectWorkspaceSnapshot,
  artifact: PreparedRuntimeArtifact,
  testCatalog: RuntimeTestCatalog,
  expectedInputs: RuntimeBuildCacheInputSnapshot,
  expectedTestInputs: RuntimeBuildCacheInputSnapshot,
  reusedArtifactText: string | undefined,
  host: RuntimeBuildCachePublicationHost,
  variant: string,
  compilerIdentity = RUNTIME_BUILD_CACHE_COMPILER_IDENTITY,
): Promise<Readonly<{ published: boolean; reason?: string }>> {
  return publishRuntimeBuildCache(
    fileSystem,
    snapshot,
    currentSnapshot,
    artifact,
    testCatalog,
    expectedInputs,
    expectedTestInputs,
    reusedArtifactText,
    host,
    variant,
    compilerIdentity,
  );
}
