import { z } from 'zod';
import { NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY } from '../cli/static-contracts';
import {
  assertProjectWorkspacePathContained,
  assetSourcePaths,
  type LoadedProjectWorkspaceSnapshot,
  type ProjectWorkspaceFileSystem,
} from './project-workspace';
import {
  captureProjectSourceInventory,
  projectSourceDiscoveryScopesEqual,
  projectSourceInventoriesEqual,
  type ProjectSourceInventory,
} from './project-source-inventory';

export const AUTHORING_CACHE_SCHEMA = 'noveltea.authoring-cache';
export const AUTHORING_CACHE_ROOT = '.noveltea/cache/authoring';

export const AUTHORING_VALIDATION_DISCOVERY_SCOPES = Object.freeze([
  { root: 'i18n', extensions: ['.json'], excludedPrefixes: [] },
  { root: 'records', extensions: ['.json', '.lua', '.rcss', '.rml'], excludedPrefixes: [] },
  { root: 'scripts', extensions: ['.lua'], excludedPrefixes: [] },
]);

const diagnosticSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(['error', 'warning', 'info']),
    path: z.string(),
    message: z.string(),
    sourceUrl: z.string().optional(),
    line: z.number().int().nonnegative().optional(),
    column: z.number().int().nonnegative().optional(),
  })
  .strict();
const projectValidationDiagnosticSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(['error', 'warning', 'info']),
    path: z.string(),
    message: z.string(),
    category: z.string().optional(),
    boundaries: z.array(z.enum(['authoring', 'runtime-package', 'platform-export'])),
    ownerPaths: z.array(z.string()),
    navigation: z
      .object({
        kind: z.literal('interactable-instance-property'),
        instanceId: z.string(),
        propertyId: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
const resultSchema = z
  .object({
    success: z.boolean(),
    exitCode: z.union([z.literal(0), z.literal(4), z.literal(6)]),
    diagnostics: z.array(diagnosticSchema),
    editorDiagnostics: z.array(projectValidationDiagnosticSchema),
  })
  .strict()
  .refine(
    (result) =>
      result.success === (result.exitCode === 0) &&
      result.success === !result.diagnostics.some((item) => item.severity === 'error'),
  );

export type CachedValidationResult = z.infer<typeof resultSchema>;

const manifestSchema = z
  .object({
    schema: z.literal(AUTHORING_CACHE_SCHEMA),
    semanticKey: z.literal(NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY),
    projectRoot: z.string().min(1),
    discoveryScopes: z.array(
      z
        .object({
          root: z.string(),
          extensions: z.array(z.string()),
          excludedPrefixes: z.array(z.string()),
        })
        .strict(),
    ),
    inputs: z.array(
      z
        .object({
          path: z.string().min(1),
          sourceIdentity: z.string().min(1),
          byteSize: z.number().int().nonnegative(),
          mtimeNanoseconds: z.string().regex(/^\d+$/u),
        })
        .strict(),
    ),
    result: resultSchema,
  })
  .strict();

async function settled(fileSystem: ProjectWorkspaceFileSystem, root: string): Promise<boolean> {
  const transactions = fileSystem.joinPath(root, '.noveltea/transactions');
  const metadata = await fileSystem.readPathMetadata!(transactions);
  return (
    metadata.kind === 'missing' ||
    (metadata.kind === 'directory' && (await fileSystem.listDirectory(transactions)).length === 0)
  );
}

async function cachePath(fileSystem: ProjectWorkspaceFileSystem, root: string, relative: string) {
  const absolute = fileSystem.joinPath(root, AUTHORING_CACHE_ROOT, relative);
  await assertProjectWorkspacePathContained(fileSystem, root, absolute);
  const parts = `${AUTHORING_CACHE_ROOT}/${relative}`.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const metadata = await fileSystem.readPathMetadata!(
      fileSystem.joinPath(root, ...parts.slice(0, index)),
    );
    if (metadata.kind === 'symlink' || metadata.kind === 'other')
      throw new Error('Unsafe cache path');
  }
  return absolute;
}

async function readCacheText(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
  relative: string,
) {
  const absolute = await cachePath(fileSystem, root, relative);
  if ((await fileSystem.readPathMetadata!(absolute)).kind !== 'file')
    throw new Error('Cache file unavailable');
  return fileSystem.readText(absolute);
}

async function readCurrentManifest(fileSystem: ProjectWorkspaceFileSystem, root: string) {
  if (!(await settled(fileSystem, root))) return null;
  const manifest = manifestSchema.parse(
    JSON.parse(await readCacheText(fileSystem, root, 'current.json')),
  );
  if (
    manifest.projectRoot !== root ||
    !projectSourceDiscoveryScopesEqual(
      manifest.discoveryScopes,
      AUTHORING_VALIDATION_DISCOVERY_SCOPES,
    ) ||
    !manifest.inputs.some((input) => input.path === 'project.json') ||
    !manifest.inputs.some((input) => input.path === 'editor.json') ||
    !manifest.inputs.some((input) => input.path === 'traits.json')
  )
    return null;
  return manifest;
}

export async function readAuthoringCache(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
  expectedInputs: ProjectSourceInventory | null = null,
): Promise<CachedValidationResult | null> {
  const admission = await readAuthoringCacheAdmission(fileSystem, root, expectedInputs);
  return admission.result;
}

export interface AuthoringCacheAdmission {
  readonly result: CachedValidationResult | null;
  readonly timings: Readonly<{
    generationMs: number;
    sourceInventoryMs: number;
  }>;
}

async function manifestInputsMatchPhysicalAuthority(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
  inputs: z.infer<typeof manifestSchema>['inputs'],
  current: ProjectSourceInventory,
): Promise<boolean> {
  if (
    !projectSourceInventoriesEqual(
      {
        entries: inputs.map(({ path, byteSize, mtimeNanoseconds }) => ({
          path,
          byteSize,
          mtimeNanoseconds,
        })),
      },
      current,
    )
  )
    return false;
  for (const input of inputs) {
    const metadata = await fileSystem.readPathMetadata!(fileSystem.joinPath(root, input.path));
    if (
      metadata.kind !== 'file' ||
      metadata.sourceIdentity !== input.sourceIdentity ||
      metadata.byteSize !== input.byteSize ||
      metadata.mtimeNanoseconds !== input.mtimeNanoseconds
    )
      return false;
  }
  return true;
}

export async function readAuthoringCacheAdmission(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
  expectedInputs: ProjectSourceInventory | null = null,
): Promise<AuthoringCacheAdmission> {
  const started = Date.now();
  const emptyTimings = { generationMs: 0, sourceInventoryMs: 0 };
  if (!fileSystem.readPathMetadata) return { result: null, timings: emptyTimings };
  try {
    const manifest = await readCurrentManifest(fileSystem, root);
    const generationMs = Date.now() - started;
    if (!manifest) return { result: null, timings: { generationMs, sourceInventoryMs: 0 } };
    const inventoryStarted = Date.now();
    const current = await captureProjectSourceInventory(fileSystem, root, {
      authoritativePaths: manifest.inputs.map((input) => input.path),
      discoveryScopes: AUTHORING_VALIDATION_DISCOVERY_SCOPES,
    });
    const sourceInventoryMs = Date.now() - inventoryStarted;
    const exact =
      (await manifestInputsMatchPhysicalAuthority(fileSystem, root, manifest.inputs, current)) &&
      (!expectedInputs ||
        projectSourceInventoriesEqual(
          {
            entries: manifest.inputs.map(({ path, byteSize, mtimeNanoseconds }) => ({
              path,
              byteSize,
              mtimeNanoseconds,
            })),
          },
          expectedInputs,
        )) &&
      (await settled(fileSystem, root));
    return {
      result: exact ? manifest.result : null,
      timings: { generationMs, sourceInventoryMs },
    };
  } catch {
    return { result: null, timings: emptyTimings };
  }
}

export interface AuthoringValidationAuthorityInputs {
  readonly entries: readonly z.infer<typeof manifestSchema>['inputs'][number][];
}

export async function captureAuthoringValidationAuthorityInputs(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
): Promise<AuthoringValidationAuthorityInputs | null> {
  if (!fileSystem.readPathMetadata) return null;
  try {
    if (!(await settled(fileSystem, snapshot.projectRoot))) return null;
    const validatedPaths = new Set([
      ...snapshot.canonicalSourceFiles,
      'project.json',
      'editor.json',
      ...assetSourcePaths(snapshot.project),
    ]);
    const inputs = await captureProjectSourceInventory(fileSystem, snapshot.projectRoot, {
      authoritativePaths: [...validatedPaths],
      discoveryScopes: AUTHORING_VALIDATION_DISCOVERY_SCOPES,
    });
    // Discovery must not attach an unparsed addition to an older validation result.
    if (inputs.entries.some((entry) => !validatedPaths.has(entry.path))) return null;
    const inputByPath = new Map(inputs.entries.map((entry) => [entry.path, entry]));
    for (const relative of snapshot.canonicalSourceFiles) {
      const captured = snapshot.fileRevisions[relative];
      const input = inputByPath.get(relative);
      if (!captured || !input || input.byteSize !== captured.byteSize) return null;
      const current = await fileSystem.readFileRevision(
        fileSystem.joinPath(snapshot.projectRoot, relative),
      );
      if (current.contentHash !== captured.contentHash || current.byteSize !== captured.byteSize)
        return null;
    }
    const entries = [];
    for (const input of inputs.entries) {
      const metadata = await fileSystem.readPathMetadata(
        fileSystem.joinPath(snapshot.projectRoot, input.path),
      );
      if (
        metadata.kind !== 'file' ||
        !metadata.sourceIdentity ||
        metadata.byteSize !== input.byteSize ||
        metadata.mtimeNanoseconds !== input.mtimeNanoseconds
      )
        return null;
      entries.push({ ...input, sourceIdentity: metadata.sourceIdentity });
    }
    return (await settled(fileSystem, snapshot.projectRoot)) ? { entries } : null;
  } catch {
    return null;
  }
}

export async function publishAuthoringCache(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
  inputs: AuthoringValidationAuthorityInputs,
  result: Readonly<{
    success: boolean;
    exitCode: number;
    diagnostics: readonly z.infer<typeof diagnosticSchema>[];
    editorDiagnostics: readonly z.infer<typeof projectValidationDiagnosticSchema>[];
  }>,
): Promise<void> {
  try {
    if (
      result.diagnostics.some(
        (item) => item.severity === 'error' && item.code.startsWith('native.'),
      )
    )
      return;
    const physicalInputs = [];
    for (const input of inputs.entries) {
      const metadata = await fileSystem.readPathMetadata!(fileSystem.joinPath(root, input.path));
      if (
        metadata.kind !== 'file' ||
        metadata.sourceIdentity !== input.sourceIdentity ||
        metadata.byteSize !== input.byteSize ||
        metadata.mtimeNanoseconds !== input.mtimeNanoseconds
      )
        return;
      physicalInputs.push({ ...input, sourceIdentity: metadata.sourceIdentity });
    }
    const manifest = manifestSchema.parse({
      schema: AUTHORING_CACHE_SCHEMA,
      semanticKey: NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY,
      projectRoot: root,
      discoveryScopes: AUTHORING_VALIDATION_DISCOVERY_SCOPES,
      inputs: physicalInputs,
      result,
    });
    const text = `${JSON.stringify(manifest)}\n`;
    const current = await captureProjectSourceInventory(fileSystem, root, {
      authoritativePaths: inputs.entries.map((input) => input.path),
      discoveryScopes: AUTHORING_VALIDATION_DISCOVERY_SCOPES,
    });
    if (!projectSourceInventoriesEqual(inputs, current) || !(await settled(fileSystem, root)))
      return;
    await fileSystem.writeTextAtomic(await cachePath(fileSystem, root, 'current.json'), text);
  } catch {
    // Cache persistence is optional restart acceleration only.
  }
}
