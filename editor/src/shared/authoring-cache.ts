import { z } from 'zod';
import { NOVELTEA_BUILD_IDENTITY, NOVELTEA_VERSION } from './product-version';
import {
  assertProjectWorkspacePathContained,
  assetSourcePaths,
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
  type LoadedProjectWorkspaceSnapshot,
  type ProjectWorkspaceFileSystem,
} from './project-workspace';
import {
  captureProjectSourceInventory,
  projectSourceDiscoveryScopesEqual,
  projectSourceInventoriesEqual,
  type ProjectSourceInventory,
} from './project-source-inventory';
import { sha256PrefixedBytes, sha256PrefixedUtf8 } from './web-crypto';

export const AUTHORING_CACHE_SCHEMA = 'noveltea.authoring-cache';
export const AUTHORING_CACHE_ROOT = '.noveltea/cache/authoring';
const buildIdentity = `${NOVELTEA_VERSION}:${NOVELTEA_BUILD_IDENTITY}`;
const discoveryScopes = [
  { root: 'records', extensions: ['.json', '.lua', '.rcss', '.rml'], excludedPrefixes: [] },
  { root: 'scripts', extensions: ['.lua'], excludedPrefixes: [] },
  { root: 'i18n', extensions: ['.json'], excludedPrefixes: [] },
];
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const pointerSchema = z
  .object({
    generation: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
    manifestSha256: digestSchema,
  })
  .strict();
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
const resultSchema = z
  .object({
    success: z.boolean(),
    exitCode: z.union([z.literal(0), z.literal(4), z.literal(6)]),
    diagnostics: z.array(diagnosticSchema),
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
    buildIdentity: z.literal(buildIdentity),
    projectRoot: z.string().min(1),
    projectWorkspace: z
      .object({
        schema: z.literal(PROJECT_WORKSPACE_SCHEMA),
        formatVersion: z.literal(PROJECT_WORKSPACE_SCHEMA_VERSION),
      })
      .strict(),
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
  // Reject symlinked cache ancestors, including links that remain inside the Project.
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

export async function readAuthoringCache(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
): Promise<CachedValidationResult | null> {
  if (!fileSystem.readPathMetadata) return null;
  try {
    if (!(await settled(fileSystem, root))) return null;
    const pointer = pointerSchema.parse(
      JSON.parse(await readCacheText(fileSystem, root, 'current')),
    );
    const text = await readCacheText(
      fileSystem,
      root,
      `generations/${pointer.generation}/manifest.json`,
    );
    if ((await sha256PrefixedUtf8(text)) !== pointer.manifestSha256) return null;
    const manifest = manifestSchema.parse(JSON.parse(text));
    if (
      manifest.projectRoot !== root ||
      !projectSourceDiscoveryScopesEqual(manifest.discoveryScopes, discoveryScopes)
    )
      return null;
    if (
      !manifest.inputs.some((input) => input.path === 'project.json') ||
      !manifest.inputs.some((input) => input.path === 'editor.json')
    )
      return null;
    const current = await captureProjectSourceInventory(fileSystem, root, {
      authoritativePaths: manifest.inputs.map((input) => input.path),
      discoveryScopes,
    });
    if (
      !projectSourceInventoriesEqual({ entries: manifest.inputs }, current) ||
      !(await settled(fileSystem, root))
    )
      return null;
    return manifest.result;
  } catch {
    return null;
  }
}

export async function captureAuthoringSourceBaseline(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
): Promise<ProjectSourceInventory | null> {
  try {
    return await captureProjectSourceInventory(fileSystem, root, {
      authoritativePaths: ['project.json', 'editor.json'],
      discoveryScopes,
    });
  } catch {
    return null;
  }
}

export async function captureAuthoringValidationInputs(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  baseline: ProjectSourceInventory | null,
): Promise<ProjectSourceInventory | null> {
  if (!fileSystem.readPathMetadata || !baseline) return null;
  try {
    if (!(await settled(fileSystem, snapshot.projectRoot))) return null;
    const inputs = await captureProjectSourceInventory(fileSystem, snapshot.projectRoot, {
      authoritativePaths: [
        ...snapshot.canonicalSourceFiles,
        'project.json',
        'editor.json',
        ...assetSourcePaths(snapshot.project),
      ],
      discoveryScopes,
    });
    const currentBaseline = await captureAuthoringSourceBaseline(fileSystem, snapshot.projectRoot);
    if (!currentBaseline || !projectSourceInventoriesEqual(baseline, currentBaseline)) return null;
    // Metadata is captured after open: prove that the parsed snapshot still describes these bytes.
    for (const relative of snapshot.canonicalSourceFiles) {
      const bytes = await fileSystem.readBytes(fileSystem.joinPath(snapshot.projectRoot, relative));
      if ((await sha256PrefixedBytes(bytes)) !== snapshot.fileRevisions[relative]?.contentHash)
        return null;
    }
    return inputs;
  } catch {
    return null;
  }
}

export async function publishAuthoringCache(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
  inputs: ProjectSourceInventory,
  result: Readonly<{
    success: boolean;
    exitCode: number;
    diagnostics: readonly z.infer<typeof diagnosticSchema>[];
  }>,
): Promise<void> {
  try {
    // Host failures are not deterministic validation products.
    if (
      result.diagnostics.some(
        (item) => item.severity === 'error' && item.code.startsWith('native.'),
      )
    )
      return;
    const manifest = manifestSchema.parse({
      schema: AUTHORING_CACHE_SCHEMA,
      buildIdentity,
      projectRoot: root,
      projectWorkspace: {
        schema: PROJECT_WORKSPACE_SCHEMA,
        formatVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
      },
      discoveryScopes,
      inputs: inputs.entries,
      result,
    });
    const generation = globalThis.crypto.randomUUID();
    const directory = await cachePath(fileSystem, root, `generations/${generation}`);
    await fileSystem.createDirectory(directory);
    const text = `${JSON.stringify(manifest)}\n`;
    await fileSystem.writeTextAtomic(
      await cachePath(fileSystem, root, `generations/${generation}/manifest.json`),
      text,
    );
    const current = await captureProjectSourceInventory(fileSystem, root, {
      authoritativePaths: inputs.entries.map((input) => input.path),
      discoveryScopes,
    });
    if (!projectSourceInventoriesEqual(inputs, current) || !(await settled(fileSystem, root)))
      return;
    await fileSystem.writeTextAtomic(
      await cachePath(fileSystem, root, 'current'),
      `${JSON.stringify({ generation, manifestSha256: await sha256PrefixedUtf8(text) })}\n`,
    );
  } catch {
    // Disposable persistence must never replace freshly computed validation diagnostics.
  }
}
