import type { ShaderCompileOptions, ShaderCompileResponse } from '../shared/editor-tooling';
import type { LocalizationFontCoverageResponse } from '../shared/localization-font-coverage';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import { assertProjectWorkspacePathContained } from '../shared/project-workspace/project-workspace-file-system';
import type { LoadedProjectWorkspaceSnapshot } from '../shared/project-workspace/project-workspace-service';
import { parseAssetData } from '../shared/project-schema/authoring-assets';
import { NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY } from './static-contracts';

/**
 * Exact native-validation products only, never compiled authoring models.
 * A disposable daemon worker lives for one invocation, so RAM-only memoization
 * would have no effect on ordinary headless validate.
 */
interface StageCache {
  contract: 'noveltea.native-validation-stages.v2';
  semanticKey: string;
  nativeIdentity: string;
  projectRoot: string;
  shader?: { inputKey: string; response: ShaderCompileResponse };
  font?: {
    dependencyRevision: string;
    fontRevisions: string;
    localeFingerprint: string;
    response: LocalizationFontCoverageResponse;
    /** Exact complete strings proved by successful native shaping. */
    provenMessages?: Readonly<Record<string, readonly string[]>>;
    stackIdentities?: Readonly<Record<string, string>>;
  };
}

const relativeCachePath = '.noveltea/cache/authoring/native-stages.json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function validShaderResponse(response: unknown): response is ShaderCompileResponse {
  if (!isRecord(response) || response.ok !== true || response.success !== true) return false;
  if (!Array.isArray(response.diagnostics) || !Array.isArray(response.outputs)) return false;
  return (
    response.diagnostics.every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item.message === 'string' &&
        ['info', 'warning', 'error'].includes(String(item.severity)),
    ) &&
    response.outputs.every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item.outputPath === 'string' &&
        typeof item.byteHash === 'string' &&
        /^sha256:[0-9a-f]{64}$/u.test(item.byteHash) &&
        Number.isSafeInteger(item.byteSize) &&
        Array.isArray(item.reflectedInputs) &&
        item.reflectedInputs.every(
          (input: unknown) =>
            isRecord(input) &&
            typeof input.name === 'string' &&
            typeof input.kind === 'string' &&
            typeof input.type === 'string' &&
            typeof input.arraySize === 'number',
        ),
    )
  );
}

function validFontResponse(response: unknown): response is LocalizationFontCoverageResponse {
  return (
    isRecord(response) &&
    response.ok === true &&
    response.success === true &&
    Array.isArray(response.diagnostics) &&
    response.diagnostics.every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item.message === 'string' &&
        typeof item.messageId === 'string' &&
        typeof item.path === 'string' &&
        Array.isArray(item.fontStack) &&
        item.fontStack.every((font: unknown) => typeof font === 'string') &&
        ['warning', 'error'].includes(String(item.severity)),
    )
  );
}

async function safeCachePath(fileSystem: ProjectWorkspaceFileSystem, root: string) {
  // Fixed internal path, no user-supplied segments. The active workspace root
  // was already canonicalized at admission; inspecting every ancestor for
  // symlinks avoids an expensive extra cross-process realpath round trip.
  if (!fileSystem.readPathMetadata) return null;
  const absolute = fileSystem.joinPath(root, relativeCachePath);
  for (const prefix of [
    '.noveltea',
    '.noveltea/cache',
    '.noveltea/cache/authoring',
    relativeCachePath,
  ]) {
    const metadata = await fileSystem.readPathMetadata(fileSystem.joinPath(root, prefix));
    if (metadata.kind === 'symlink' || metadata.kind === 'other') return null;
  }
  return absolute;
}

export async function readValidationStageCache(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
  nativeIdentity: string,
): Promise<StageCache> {
  const empty: StageCache = {
    contract: 'noveltea.native-validation-stages.v2',
    semanticKey: NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY,
    nativeIdentity,
    projectRoot: root,
  };
  try {
    const filename = await safeCachePath(fileSystem, root);
    if (!filename || (await fileSystem.inspect(filename)) !== 'file') return empty;
    const candidate = JSON.parse(await fileSystem.readText(filename)) as Partial<StageCache>;
    if (
      candidate.contract !== empty.contract ||
      candidate.semanticKey !== empty.semanticKey ||
      candidate.nativeIdentity !== nativeIdentity ||
      candidate.projectRoot !== root
    )
      return empty;
    // The persisted file is untrusted. Validate the useful shape before using it.
    const shader = candidate.shader;
    const font = candidate.font;
    return {
      ...empty,
      ...(shader && typeof shader.inputKey === 'string' && validShaderResponse(shader.response)
        ? { shader }
        : {}),
      ...(font &&
      typeof font.dependencyRevision === 'string' &&
      typeof font.fontRevisions === 'string' &&
      /^[0-9a-f]{64}$/u.test(font.localeFingerprint) &&
      validFontResponse(font.response)
        ? {
            font: {
              ...font,
              ...(font.provenMessages &&
              font.stackIdentities &&
              isRecord(font.provenMessages) &&
              isRecord(font.stackIdentities) &&
              Object.values(font.provenMessages).every(
                (items) => Array.isArray(items) && items.every((item) => typeof item === 'string'),
              ) &&
              Object.values(font.stackIdentities).every((item) => typeof item === 'string')
                ? {
                    provenMessages: font.provenMessages,
                    stackIdentities: font.stackIdentities,
                  }
                : { provenMessages: undefined, stackIdentities: undefined }),
            },
          }
        : {}),
    };
  } catch {
    return empty;
  }
}

export async function publishValidationStageCache(
  fileSystem: ProjectWorkspaceFileSystem,
  cache: StageCache,
): Promise<void> {
  try {
    const filename = await safeCachePath(fileSystem, cache.projectRoot);
    if (!filename) return;
    const parent = fileSystem.dirname(filename);
    if ((await fileSystem.inspect(parent)) !== 'directory') {
      for (const relative of ['.noveltea', '.noveltea/cache', '.noveltea/cache/authoring']) {
        const directory = fileSystem.joinPath(cache.projectRoot, relative);
        if ((await fileSystem.inspect(directory)) === 'missing')
          await fileSystem.createDirectory(directory);
      }
    }
    await fileSystem.writeTextAtomic(filename, `${JSON.stringify(cache)}\n`);
  } catch {
    // Validation never fails because an optional cache cannot be written.
  }
}

/** Read exact revisions, not Asset declarations or mtime-only hints. */
export async function activeFontRevisions(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
): Promise<string | null> {
  const project = snapshot.project;
  const paths = new Set<string>();
  for (const locale of Object.values(project.localization.locales))
    for (const reference of locale.fontStack ?? project.settings.text.fontStack) {
      const asset = parseAssetData(project.assets[reference.$ref.id]?.data);
      if (asset?.kind === 'font') paths.add(asset.source.path);
    }
  const revisions: Array<[string, string, number]> = [];
  try {
    for (const relative of [...paths].sort()) {
      const absolute = fileSystem.joinPath(snapshot.projectRoot, relative);
      await assertProjectWorkspacePathContained(fileSystem, snapshot.projectRoot, absolute);
      const revision = await fileSystem.readFileRevision(absolute);
      revisions.push([relative, revision.contentHash, revision.byteSize]);
    }
    return JSON.stringify(revisions);
  } catch {
    return null;
  }
}

/** Include all shader stages/includes, including those with no current positive reference. */
export async function shaderSourceRevisions(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: Pick<LoadedProjectWorkspaceSnapshot, 'projectRoot'>,
): Promise<string | null> {
  const root = snapshot.projectRoot;
  const revisions: Array<[string, string, number]> = [];
  const walk = async (relative: string): Promise<void> => {
    const absolute = fileSystem.joinPath(root, relative);
    const kind = await fileSystem.inspect(absolute);
    if (kind === 'missing') return;
    if (kind !== 'directory') throw new Error('Shader source root is not a directory.');
    for (const name of [...(await fileSystem.listDirectory(absolute))].sort()) {
      const child = `${relative}/${name}`;
      const childAbsolute = fileSystem.joinPath(root, child);
      if ((await fileSystem.inspect(childAbsolute)) === 'directory') {
        await walk(child);
      } else {
        // Native shader includes are not restricted to .sc (e.g. .sh).
        // Hash every file in the shader tree, including additions/removals.
        await assertProjectWorkspacePathContained(fileSystem, root, childAbsolute);
        const revision = await fileSystem.readFileRevision(childAbsolute);
        revisions.push([child, revision.contentHash, revision.byteSize]);
      }
    }
  };
  try {
    await walk('shaders');
    return JSON.stringify(revisions);
  } catch {
    return null;
  }
}

/** Cached compilation must not mask missing/replaced output binaries. */
export async function shaderOutputsStillValid(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
  response: ShaderCompileResponse,
): Promise<boolean> {
  try {
    const outputRoot = fileSystem.joinPath(root, '.noveltea', 'build');
    for (const output of response.outputs) {
      const relative =
        typeof output.outputPath === 'string'
          ? fileSystem.relativePath(outputRoot, output.outputPath).replaceAll('\\', '/')
          : '..';
      if (
        typeof output.outputPath !== 'string' ||
        relative === '..' ||
        relative === '.' ||
        relative.startsWith('../') ||
        relative.startsWith('/') ||
        /^[A-Za-z]:\//u.test(relative) ||
        !/^sha256:[0-9a-f]{64}$/u.test(output.byteHash) ||
        !Number.isSafeInteger(output.byteSize)
      )
        return false;
      await assertProjectWorkspacePathContained(fileSystem, root, output.outputPath);
      const revision = await fileSystem.readFileRevision(output.outputPath);
      if (revision.contentHash !== output.byteHash || revision.byteSize !== output.byteSize)
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Allow export and CLI validate to share the same exact-input native result.
 * Export retains responsibility for required variants and output completeness.
 * Bypass on forced rebuilds, source overlays or target-specific compiler roots.
 */
export async function compileWithVerifiedValidationCache(
  fileSystem: ProjectWorkspaceFileSystem | undefined,
  root: string,
  identity: string | undefined,
  compilation: unknown,
  options: ShaderCompileOptions,
  compile: () => Promise<ShaderCompileResponse>,
  observation?: {
    /** A validation invocation batches font and shader cache publication. */
    cache?: StageCache;
    onTiming?: (stage: 'revision' | 'outputs' | 'native', milliseconds: number) => void;
  },
): Promise<ShaderCompileResponse> {
  const timed = async <T>(stage: 'revision' | 'outputs' | 'native', action: () => Promise<T>) => {
    const start = Date.now();
    try {
      return await action();
    } finally {
      observation?.onTiming?.(stage, Date.now() - start);
    }
  };
  const standardVariants = ['glsl-330', 'essl-300', 'metal'];
  if (
    !fileSystem ||
    !identity ||
    options.forceRebuild ||
    Object.keys(options.sourceOverlays ?? {}).length > 0 ||
    (options.shaderVariants &&
      (options.shaderVariants.length !== standardVariants.length ||
        options.shaderVariants.some((variant, index) => variant !== standardVariants[index]))) ||
    (options.projectRoot && options.projectRoot !== root) ||
    (options.outputRoot &&
      options.outputRoot !== fileSystem.joinPath(root, '.noveltea', 'build')) ||
    (options.cacheRoot && options.cacheRoot !== fileSystem.joinPath(root, '.noveltea', 'cache')) ||
    options.engineShaderRoot
  )
    return timed('native', compile);

  const revisions = await timed('revision', () =>
    shaderSourceRevisions(fileSystem, { projectRoot: root }),
  );
  if (revisions === null) return timed('native', compile);
  const key = JSON.stringify([compilation, revisions]);
  const existing =
    observation?.cache ?? (await readValidationStageCache(fileSystem, root, identity));
  const outputsValid = (response: ShaderCompileResponse) =>
    timed('outputs', () => shaderOutputsStillValid(fileSystem, root, response));
  if (existing.shader?.inputKey === key && (await outputsValid(existing.shader.response)))
    return existing.shader.response;

  const response = await timed('native', compile);
  if (response.ok && response.success && (await outputsValid(response))) {
    existing.shader = { inputKey: key, response };
    if (!observation?.cache) await publishValidationStageCache(fileSystem, existing);
  }
  return response;
}

export type { StageCache };
