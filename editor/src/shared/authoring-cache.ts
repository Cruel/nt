import { z } from 'zod';
import type { AuthoringValidationContribution } from './project-schema/authoring-validation-contributions';
import type { AuthoringDependencyGraphContribution } from './authoring-dependency-contracts';
import { escapeJsonPointerSegment } from './json-pointer';
import { NOVELTEA_BUILD_IDENTITY, NOVELTEA_VERSION } from './product-version';
import {
  assertProjectWorkspacePathContained,
  assetSourcePaths,
  compareProjectWorkspaceUnicodeCodePoints,
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
  type LoadedProjectWorkspaceSnapshot,
  type ProjectWorkspaceDependencyAnalysis,
  type ProjectWorkspaceFileSystem,
  type ProjectWorkspaceSourceContribution,
  type ProjectWorkspaceSourceContributions,
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
const AUTHORING_CONTRIBUTIONS_SCHEMA = 'noveltea.authoring-cache.contributions';
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
  })
  .strict()
  .refine(
    (result) =>
      result.success === (result.exitCode === 0) &&
      result.success === !result.diagnostics.some((item) => item.severity === 'error'),
  );
export type CachedValidationResult = z.infer<typeof resultSchema>;
const sourceContributionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      path: z.string().min(1),
      contentHash: digestSchema,
      byteSize: z.number().int().nonnegative(),
      kind: z.literal('json'),
      parsed: z.unknown(),
      schemaValid: z.literal(true),
      ownerPaths: z.array(z.string()),
      localDiagnostics: z.array(projectValidationDiagnosticSchema),
    })
    .strict(),
  z
    .object({
      path: z.string().min(1),
      contentHash: digestSchema,
      byteSize: z.number().int().nonnegative(),
      kind: z.literal('text'),
      text: z.string(),
      schemaValid: z.literal(true),
      ownerPaths: z.array(z.string()),
      localDiagnostics: z.array(projectValidationDiagnosticSchema),
    })
    .strict(),
]);
const sourceRevisionSchema = z
  .object({
    path: z.string().min(1),
    contentHash: digestSchema,
  })
  .strict();
const externalSourceRevisionSchema = sourceRevisionSchema
  .extend({ byteSize: z.number().int().nonnegative() })
  .strict();
const dependencyContributionSchema = z
  .object({
    key: z.string().min(1),
    sourceRevisions: z.array(sourceRevisionSchema).min(1),
    contribution: z.unknown(),
  })
  .strict();
const sourceAnalysisContributionSchema = z
  .object({
    key: z.string().min(1),
    sourceRevisions: z.array(sourceRevisionSchema).min(1),
    analyses: z.array(z.unknown()),
  })
  .strict();
const contributionsSchema = z
  .object({
    schema: z.literal(AUTHORING_CONTRIBUTIONS_SCHEMA),
    buildIdentity: z.literal(buildIdentity),
    projectRoot: z.string().min(1),
    entries: z.array(sourceContributionSchema),
    externalSourceRevisions: z.array(externalSourceRevisionSchema),
    dependencyContributions: z.array(dependencyContributionSchema),
    sourceAnalyses: z.array(sourceAnalysisContributionSchema),
    validationContributions: z.array(
      z
        .object({
          key: z.string().min(1),
          inputPaths: z.array(z.string()),
          sourceRevisions: z.array(sourceRevisionSchema),
          diagnostics: z.array(projectValidationDiagnosticSchema),
        })
        .strict(),
    ),
  })
  .strict();
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
    contributions: z
      .object({
        schema: z.literal(AUTHORING_CONTRIBUTIONS_SCHEMA),
        validationInputs: z.literal('source-revisions'),
        sha256: digestSchema,
      })
      .strict(),
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

async function readCurrentGeneration(fileSystem: ProjectWorkspaceFileSystem, root: string) {
  if (!(await settled(fileSystem, root))) return null;
  const pointer = pointerSchema.parse(JSON.parse(await readCacheText(fileSystem, root, 'current')));
  const text = await readCacheText(
    fileSystem,
    root,
    `generations/${pointer.generation}/manifest.json`,
  );
  if ((await sha256PrefixedUtf8(text)) !== pointer.manifestSha256) return null;
  const manifest = manifestSchema.parse(JSON.parse(text));
  if (
    manifest.projectRoot !== root ||
    !projectSourceDiscoveryScopesEqual(manifest.discoveryScopes, discoveryScopes) ||
    !manifest.inputs.some((input) => input.path === 'project.json') ||
    !manifest.inputs.some((input) => input.path === 'editor.json') ||
    !manifest.inputs.some((input) => input.path === 'traits.json')
  )
    return null;
  return { pointer, manifest };
}

export async function readAuthoringCache(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
): Promise<CachedValidationResult | null> {
  if (!fileSystem.readPathMetadata) return null;
  try {
    const generation = await readCurrentGeneration(fileSystem, root);
    if (!generation) return null;
    const current = await captureProjectSourceInventory(fileSystem, root, {
      authoritativePaths: generation.manifest.inputs.map((input) => input.path),
      discoveryScopes,
    });
    if (
      !projectSourceInventoriesEqual({ entries: generation.manifest.inputs }, current) ||
      !(await settled(fileSystem, root))
    )
      return null;
    return generation.manifest.result;
  } catch {
    return null;
  }
}

function inventoryPathsEqual(left: ProjectSourceInventory, right: ProjectSourceInventory): boolean {
  return (
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => entry.path === right.entries[index]?.path)
  );
}

function contributionRecord(
  entries: readonly z.infer<typeof sourceContributionSchema>[],
): ProjectWorkspaceSourceContributions | null {
  const result: Record<string, ProjectWorkspaceSourceContribution> = {};
  let previous: string | null = null;
  for (const entry of entries) {
    if (
      (previous !== null && compareProjectWorkspaceUnicodeCodePoints(entry.path, previous) <= 0) ||
      result[entry.path]
    )
      return null;
    previous = entry.path;
    result[entry.path] = entry as ProjectWorkspaceSourceContribution;
  }
  return Object.freeze(result);
}

export interface ReusableAuthoringDependencyContribution {
  readonly key: string;
  readonly sourceRevisions: readonly Readonly<{ path: string; contentHash: string }>[];
  readonly contribution: unknown;
}
export interface ReusableAuthoringSourceAnalysis {
  readonly key: string;
  readonly sourceRevisions: readonly Readonly<{ path: string; contentHash: string }>[];
  readonly analyses: readonly unknown[];
}
export interface ReusableAuthoringContributions {
  readonly sourceContributions: ProjectWorkspaceSourceContributions;
  readonly dependencyContributions: readonly ReusableAuthoringDependencyContribution[];
  readonly sourceAnalyses: readonly ReusableAuthoringSourceAnalysis[];
  readonly inventory: ProjectSourceInventory;
  readonly validationContributions: readonly AuthoringValidationContribution[];
}

export async function readReusableAuthoringContributions(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
): Promise<ReusableAuthoringContributions | null> {
  if (!fileSystem.readPathMetadata) return null;
  try {
    const generation = await readCurrentGeneration(fileSystem, root);
    if (!generation) return null;
    const contributionText = await readCacheText(
      fileSystem,
      root,
      `generations/${generation.pointer.generation}/contributions.json`,
    );
    if ((await sha256PrefixedUtf8(contributionText)) !== generation.manifest.contributions.sha256)
      return null;
    const artifact = contributionsSchema.parse(JSON.parse(contributionText));
    if (artifact.projectRoot !== root) return null;
    const prior = { entries: generation.manifest.inputs };
    const current = await captureProjectSourceInventory(fileSystem, root, {
      authoritativePaths: generation.manifest.inputs.map((input) => input.path),
      discoveryScopes,
    });
    // Inventory shape changes can reclassify source ownership, so reuse fails closed here.
    if (!inventoryPathsEqual(prior, current)) return null;

    const priorByPath = new Map(prior.entries.map((entry) => [entry.path, entry]));
    const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
    const revisionIsReusable = async (
      path: string,
      byteSize: number,
      contentHash: string,
    ): Promise<boolean> => {
      const previousInput = priorByPath.get(path);
      const currentInput = currentByPath.get(path);
      if (!previousInput || !currentInput || byteSize !== previousInput.byteSize)
        throw new Error('Cached content revision is not part of the published source inventory.');
      if (
        previousInput.byteSize === currentInput.byteSize &&
        previousInput.mtimeNanoseconds === currentInput.mtimeNanoseconds
      )
        return true;
      const bytes = await fileSystem.readBytes(fileSystem.joinPath(root, path));
      return (
        bytes.byteLength === currentInput.byteSize &&
        bytes.byteLength === byteSize &&
        (await sha256PrefixedBytes(bytes)) === contentHash
      );
    };

    const reusable: z.infer<typeof sourceContributionSchema>[] = [];
    for (const contribution of artifact.entries)
      if (
        await revisionIsReusable(contribution.path, contribution.byteSize, contribution.contentHash)
      )
        reusable.push(contribution);

    const reusableExternalSourceRevisions = new Map<string, string>();
    let previousExternalPath: string | null = null;
    const contributionPaths = new Set(artifact.entries.map((entry) => entry.path));
    for (const revision of artifact.externalSourceRevisions) {
      if (
        contributionPaths.has(revision.path) ||
        (previousExternalPath !== null &&
          compareProjectWorkspaceUnicodeCodePoints(revision.path, previousExternalPath) <= 0)
      )
        return null;
      previousExternalPath = revision.path;
      if (await revisionIsReusable(revision.path, revision.byteSize, revision.contentHash))
        reusableExternalSourceRevisions.set(revision.path, revision.contentHash);
    }
    if (!(await settled(fileSystem, root))) return null;
    const sourceContributions = contributionRecord(reusable);
    if (!sourceContributions) return null;
    const cachedRevisionPaths = new Set([
      ...artifact.entries.map((entry) => entry.path),
      ...artifact.externalSourceRevisions.map((entry) => entry.path),
    ]);
    const semanticReuseUncertain = current.entries.some((entry) => {
      const previous = priorByPath.get(entry.path);
      return (
        !cachedRevisionPaths.has(entry.path) &&
        previous !== undefined &&
        (previous.byteSize !== entry.byteSize ||
          previous.mtimeNanoseconds !== entry.mtimeNanoseconds)
      );
    });
    const reusableRevision = (revisions: readonly { path: string; contentHash: string }[]) =>
      revisions.every((revision) => {
        const admittedHash =
          sourceContributions[revision.path]?.contentHash ??
          reusableExternalSourceRevisions.get(revision.path);
        return admittedHash === revision.contentHash;
      });
    return {
      sourceContributions,
      dependencyContributions: semanticReuseUncertain
        ? []
        : artifact.dependencyContributions.filter((entry) =>
            reusableRevision(entry.sourceRevisions),
          ),
      sourceAnalyses: semanticReuseUncertain
        ? []
        : artifact.sourceAnalyses.filter((entry) => reusableRevision(entry.sourceRevisions)),
      validationContributions: semanticReuseUncertain
        ? []
        : artifact.validationContributions.filter((entry) =>
            reusableRevision(entry.sourceRevisions),
          ),
      inventory: current,
    };
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
      authoritativePaths: ['project.json', 'editor.json', 'traits.json'],
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
  sourceContributions: ProjectWorkspaceSourceContributions,
  admittedInventory: ProjectSourceInventory | null = null,
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
    if (admittedInventory && !projectSourceInventoriesEqual(admittedInventory, inputs)) return null;
    // Each parsed source contribution is tied to the exact revision admitted by workspace assembly.
    for (const relative of snapshot.canonicalSourceFiles) {
      const contribution = sourceContributions[relative];
      const revision = snapshot.fileRevisions[relative];
      if (
        !contribution ||
        !revision ||
        contribution.path !== relative ||
        contribution.contentHash !== revision.contentHash ||
        contribution.byteSize !== revision.byteSize
      )
        return null;
    }
    return inputs;
  } catch {
    return null;
  }
}

function semanticSourceRevisions(
  contributionKey: string,
  contribution: AuthoringDependencyGraphContribution,
  sourceContributions: ProjectWorkspaceSourceContributions,
  dependencyAnalysis: ProjectWorkspaceDependencyAnalysis,
  scope: 'dependency' | 'source-analysis',
): readonly { path: string; contentHash: `sha256:${string}` }[] | null {
  const revisions = new Map<string, `sha256:${string}`>();
  const addMostSpecificOwner = (ownerPath: string): boolean => {
    const candidates: { path: string; contentHash: `sha256:${string}`; score: number }[] = [];
    for (const sourceContribution of Object.values(sourceContributions)) {
      const score = Math.max(
        -1,
        ...sourceContribution.ownerPaths
          .filter(
            (sourceOwner) => ownerPath === sourceOwner || ownerPath.startsWith(`${sourceOwner}/`),
          )
          .map((sourceOwner) => sourceOwner.length),
      );
      if (score >= 0)
        candidates.push({
          path: sourceContribution.path,
          contentHash: sourceContribution.contentHash,
          score,
        });
    }
    const bestScore = Math.max(-1, ...candidates.map((candidate) => candidate.score));
    if (bestScore < 0) return false;
    for (const candidate of candidates)
      if (candidate.score === bestScore) revisions.set(candidate.path, candidate.contentHash);
    return true;
  };
  const addOwnerFamily = (prefix: string): boolean => {
    let found = false;
    for (const sourceContribution of Object.values(sourceContributions)) {
      if (!sourceContribution.ownerPaths.some((ownerPath) => ownerPath.startsWith(prefix)))
        continue;
      revisions.set(sourceContribution.path, sourceContribution.contentHash);
      found = true;
    }
    return found;
  };
  const addRevisionPath = (path: string): boolean => {
    const sourceContribution = sourceContributions[path];
    if (sourceContribution) {
      revisions.set(path, sourceContribution.contentHash);
      return true;
    }
    const externalRevision = dependencyAnalysis.externalSourceRevisions.get(path);
    if (!externalRevision) return false;
    revisions.set(path, externalRevision.contentHash);
    return true;
  };
  const addGlobalSourceAnalysisInputs = (): boolean => {
    for (const [key, analyses] of dependencyAnalysis.sourceAnalyses) {
      if (analyses.length === 0) continue;
      const ownerContribution = dependencyAnalysis.contributions.byKey.get(key);
      if (!ownerContribution || !addMostSpecificOwner(ownerContribution.ownerPath)) return false;
      for (const path of dependencyAnalysis.sourcePathsByContributionKey.get(key) ?? [])
        if (!addRevisionPath(path)) return false;
    }
    return true;
  };

  if (!addMostSpecificOwner(contribution.ownerPath)) return null;
  for (const path of dependencyAnalysis.sourcePathsByContributionKey.get(contributionKey) ?? [])
    if (!addRevisionPath(path)) return null;
  if (scope === 'source-analysis') {
    // Source-analysis limits are snapshot-wide. Any analyzed source can alter another owner's
    // limit diagnostics, so a persisted analysis is reusable only while the complete analyzed
    // source revision set remains exact.
    if (!addGlobalSourceAnalysisInputs()) return null;
    return [...revisions.entries()]
      .sort(([left], [right]) => compareProjectWorkspaceUnicodeCodePoints(left, right))
      .map(([path, contentHash]) => ({ path, contentHash }));
  }

  if ((dependencyAnalysis.sourceAnalyses.get(contributionKey)?.length ?? 0) > 0) {
    if (!addGlobalSourceAnalysisInputs()) return null;
    for (const sourceContribution of Object.values(sourceContributions)) {
      const contributesSymbols =
        sourceContribution.path === 'project.json' ||
        sourceContribution.path === 'traits.json' ||
        (/^records\/[^/]+\/[^/]+\.json$/u.test(sourceContribution.path) &&
          !sourceContribution.path.startsWith('records/layouts/')) ||
        /^records\/layouts\/[^/]+\/layout\.json$/u.test(sourceContribution.path);
      if (contributesSymbols)
        revisions.set(sourceContribution.path, sourceContribution.contentHash);
    }
  }
  for (const dependency of contribution.derivationDependencies) {
    if (dependency.kind === 'project-field') {
      if (!addMostSpecificOwner(dependency.path)) return null;
      continue;
    }
    if (dependency.kind === 'source-project-file') {
      if (!addRevisionPath(dependency.path)) return null;
      continue;
    }
    if (dependency.kind === 'source-asset' || dependency.kind === 'source-resolution-asset') {
      if (!addMostSpecificOwner(`/assets/${escapeJsonPointerSegment(dependency.assetId)}`))
        return null;
      continue;
    }
    if (dependency.kind === 'localization-lookup') {
      if (!addOwnerFamily('/localization/')) return null;
      continue;
    }
    if (
      !addMostSpecificOwner(
        `/${dependency.ownerCollection}/${escapeJsonPointerSegment(dependency.ownerId)}`,
      ) ||
      !addOwnerFamily('/traits')
    )
      return null;
    // Archetypes are an optional input family. If none exist, source-inventory shape still protects
    // that absence; if they do exist, retain all of them conservatively for property resolution.
    addOwnerFamily('/archetypes/');
  }
  return [...revisions.entries()]
    .sort(([left], [right]) => compareProjectWorkspaceUnicodeCodePoints(left, right))
    .map(([path, contentHash]) => ({ path, contentHash }));
}

export async function publishAuthoringCache(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
  inputs: ProjectSourceInventory,
  sourceContributions: ProjectWorkspaceSourceContributions,
  dependencyAnalysis: ProjectWorkspaceDependencyAnalysis | undefined,
  result: Readonly<{
    success: boolean;
    exitCode: number;
    diagnostics: readonly z.infer<typeof diagnosticSchema>[];
  }>,
  validationContributions: readonly AuthoringValidationContribution[],
): Promise<void> {
  try {
    // Host failures are not deterministic validation products.
    if (
      result.diagnostics.some(
        (item) => item.severity === 'error' && item.code.startsWith('native.'),
      )
    )
      return;
    const inputByPath = new Map(inputs.entries.map((input) => [input.path, input]));
    const contributionEntries = Object.keys(sourceContributions)
      .sort(compareProjectWorkspaceUnicodeCodePoints)
      .map((path) => sourceContributions[path]!);
    if (
      contributionEntries.some((contribution) => {
        const input = inputByPath.get(contribution.path);
        return !input || input.byteSize !== contribution.byteSize;
      })
    )
      return;
    const contributionPaths = new Set(contributionEntries.map((entry) => entry.path));
    const externalSourceRevisions = dependencyAnalysis
      ? [...dependencyAnalysis.externalSourceRevisions.entries()]
          .filter(([path]) => !contributionPaths.has(path))
          .sort(([left], [right]) => compareProjectWorkspaceUnicodeCodePoints(left, right))
          .map(([path, revision]) => ({ path, ...revision }))
      : [];
    if (
      externalSourceRevisions.some((revision) => {
        const input = inputByPath.get(revision.path);
        return !input || input.byteSize !== revision.byteSize;
      })
    )
      return;
    const dependencyContributions = dependencyAnalysis
      ? [...dependencyAnalysis.contributions.byKey.entries()]
          .sort(([left], [right]) => compareProjectWorkspaceUnicodeCodePoints(left, right))
          .flatMap(([key, contribution]) => {
            const sourceRevisions = semanticSourceRevisions(
              key,
              contribution,
              sourceContributions,
              dependencyAnalysis,
              'dependency',
            );
            return sourceRevisions && sourceRevisions.length > 0
              ? [{ key, sourceRevisions, contribution }]
              : [];
          })
      : [];
    const sourceAnalyses = dependencyAnalysis
      ? [...dependencyAnalysis.sourceAnalyses.entries()]
          .sort(([left], [right]) => compareProjectWorkspaceUnicodeCodePoints(left, right))
          .flatMap(([key, analyses]) => {
            const contribution = dependencyAnalysis.contributions.byKey.get(key);
            if (!contribution || analyses.length === 0) return [];
            const sourceRevisions = semanticSourceRevisions(
              key,
              contribution,
              sourceContributions,
              dependencyAnalysis,
              'source-analysis',
            );
            return sourceRevisions && sourceRevisions.length > 0
              ? [{ key, sourceRevisions, analyses }]
              : [];
          })
      : [];
    const contributions = contributionsSchema.parse({
      schema: AUTHORING_CONTRIBUTIONS_SCHEMA,
      buildIdentity,
      projectRoot: root,
      entries: contributionEntries,
      externalSourceRevisions,
      dependencyContributions,
      sourceAnalyses,
      validationContributions,
    });
    const contributionText = `${JSON.stringify(contributions)}\n`;
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
      contributions: {
        schema: AUTHORING_CONTRIBUTIONS_SCHEMA,
        validationInputs: 'source-revisions',
        sha256: await sha256PrefixedUtf8(contributionText),
      },
      result,
    });
    const generation = globalThis.crypto.randomUUID();
    const directory = await cachePath(fileSystem, root, `generations/${generation}`);
    await fileSystem.createDirectory(directory);
    await fileSystem.writeTextAtomic(
      await cachePath(fileSystem, root, `generations/${generation}/contributions.json`),
      contributionText,
    );
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
