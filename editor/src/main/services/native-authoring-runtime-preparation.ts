import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { authoringProjectSchema } from '../../shared/project-schema/authoring-project';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import { selectedExportProfile } from '../../shared/project-schema/authoring-export';
import { parseTestData } from '../../shared/project-schema/authoring-tests';
import { buildRuntimePlaybackSpecFromTestData } from '../../shared/project-schema/test-playback-project';
import { projectWithPreviewLocale } from '../../shared/preview-locale';
import {
  prepareRuntimeArtifact,
  type PreparedRuntimeArtifact,
  type RuntimeArtifactPathAdapter,
  type RuntimeArtifactShaderCompilerAdapter,
} from '../../shared/runtime-artifact-preparation';
import {
  nodeRuntimeArtifactPaths,
  nodeShaderCompilerAdapter,
} from './node-runtime-artifact-adapters';
import type { NativeAuthoringWorkingProject } from './native-authoring-working-project';
import type { ActiveProjectWorkspaceSession } from './active-project-workspace-session';
import { invokeNovelTeaNativeOperation } from '../../shared/noveltea-cli-subprocess';
import { compileShaders } from './editor-tool-service';
import type { Sha256Digest } from '../../shared/project-text-sources';
import type { NativeAuthoringPreparation } from './native-authoring-worker-contract';
import type { LoadedProjectWorkspaceSnapshot } from '../../shared/project-workspace/project-workspace-service';

const manifestFields = [
  'project',
  'settings',
  'export',
  'bootstrapModule',
  'undefinedInteractionProgram',
  'entrypoint',
  'inventories',
  'interactableInstances',
] as const;

/** Use an independently verified saved baseline, replacing only the native
 * active generation's dirty values. Never consult the canonical runtime cache. */
export function projectFromNativeWorkingPreparation(
  saved: AuthoringProject,
  savedFiles: Pick<LoadedProjectWorkspaceSnapshot, 'fileRevisions'>,
  prepared: NativeAuthoringPreparation,
): AuthoringProject {
  if (!prepared.accepted || !prepared.project || typeof prepared.project !== 'object')
    throw new Error(prepared.error || 'Native Project preparation was rejected.');
  for (const [file, revision] of Object.entries(prepared.sourceRevisions)) {
    const admitted = savedFiles.fileRevisions[file];
    // Source Assets (e.g. an RML template under assets/) have native exact-byte
    // authority but are not tracked YAML Workspace fileRevisions.
    if (
      (admitted && admitted.contentHash !== revision) ||
      (!admitted &&
        (file === 'project.yaml' ||
          file === 'traits.yaml' ||
          file === 'editor.yaml' ||
          file.startsWith('records/') ||
          file.startsWith('i18n/')))
    )
      throw new Error('Native preview source differs from the admitted saved workspace: ' + file);
  }
  const native = prepared.project as Record<string, unknown>;
  const candidate: Record<string, unknown> = { ...saved };
  for (const field of manifestFields) {
    if (!(field in native)) throw new Error('Native manifest omitted ' + field);
    candidate[field] = native[field];
  }
  candidate.localization = native.localization;
  if (native.traits !== undefined) candidate.traits = native.traits;
  if (native.editor !== undefined) {
    candidate.editor = { ...saved.editor, ...(native.editor as object) };
  }
  for (const family of authoringCollectionKeys) {
    const dirty = prepared.recordOverrides[family];
    if (dirty) candidate[family] = { ...saved[family], ...dirty };
  }
  const parsed = authoringProjectSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      'Native preview projection is incompatible with the current runtime contract: ' +
        parsed.error.issues
          .slice(0, 3)
          .map((issue) => issue.path.join('/'))
          .join(', '),
    );
  }
  return parsed.data;
}

export interface NativeWorkingRuntimeResult {
  readonly status: 'prepared';
  readonly artifact: PreparedRuntimeArtifact;
  readonly workingRevision: number;
  readonly test?: { readonly runner: 'runtime' | 'runtime-ui'; readonly spec: unknown };
  dispose(): Promise<void>;
}

export type NativeWorkingRuntimePreparation =
  | NativeWorkingRuntimeResult
  | { status: 'blocked'; diagnostics: readonly { message: string; path: string }[] };

interface RetainedWorkingArtifact {
  readonly result: NativeWorkingRuntimeResult;
  leases: number;
  retired: boolean;
}

/** Cache runtime artifacts by their effective runtime inputs, not the broad
 * editor revision. A Test-only change refreshes its typed playback spec while
 * retaining the compiled game. Old source-overlay roots stay alive until all
 * borrowers release them. Owners explicitly clear this certification cache. */
export class NativeWorkingRuntimePreparationCache {
  private readonly entries = new Map<string, RetainedWorkingArtifact>();
  private queue: Promise<unknown> = Promise.resolve();

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private key(options: NativeWorkingRuntimeOptions): string {
    const { prepared, saved } = options;
    const runtimeOverrides = Object.fromEntries(
      Object.entries(prepared.recordOverrides).filter(([owner]) => owner !== 'tests'),
    );
    const runtimeRevisions = Object.fromEntries(
      Object.entries(prepared.sourceRevisions).filter(
        ([name]) => !name.startsWith('records/tests/'),
      ),
    );
    const content = JSON.stringify([
      options.projectRoot,
      Boolean(options.testId),
      { ...saved, tests: {} },
      prepared.project,
      runtimeOverrides,
      runtimeRevisions,
      prepared.textOverlays,
      prepared.shaderOverlays,
    ]);
    return createHash('sha256').update(content).digest('hex');
  }

  private async retire(entry: RetainedWorkingArtifact): Promise<void> {
    entry.retired = true;
    if (entry.leases === 0) await entry.result.dispose();
  }

  prepare(options: NativeWorkingRuntimeOptions): Promise<NativeWorkingRuntimePreparation> {
    return this.serialized(() => this.prepareSerial(options));
  }

  private async prepareSerial(
    options: NativeWorkingRuntimeOptions,
  ): Promise<NativeWorkingRuntimePreparation> {
    if (!options.prepared.accepted) return prepareNativeWorkingRuntime(options);
    // A hit must still prove the new native snapshot is based on the active
    // saved Workspace generation; caching never bypasses source authority.
    projectFromNativeWorkingPreparation(options.saved, options.savedFiles, options.prepared);
    // Shader files are physical compiler inputs, not tracked YAML workspace
    // revisions. Recheck them at cache lookup, including on a cache hit, so
    // an external edit after the native preparation cannot return stale GL
    // artifacts under an otherwise unchanged key.
    for (const [relative, revision] of Object.entries(options.prepared.sourceRevisions)) {
      if (!relative.startsWith('shaders/')) continue;
      const actual =
        'sha256:' +
        createHash('sha256')
          .update(await readFile(path.join(options.projectRoot, relative)))
          .digest('hex');
      if (revision !== actual)
        throw new Error('Native preview shader source changed during preparation: ' + relative);
    }
    const key = this.key(options);
    let retained = this.entries.get(key);
    if (!retained) {
      const result = await prepareNativeWorkingRuntime(options);
      if (result.status !== 'prepared') return result;
      retained = { result, leases: 0, retired: false };
      this.entries.set(key, retained);
      while (this.entries.size > 4) {
        const oldest = this.entries.keys().next().value!;
        const evicted = this.entries.get(oldest)!;
        this.entries.delete(oldest);
        await this.retire(evicted);
      }
    } else {
      this.entries.delete(key);
      this.entries.set(key, retained);
    }
    let test: NativeWorkingRuntimeResult['test'];
    if (options.testId) {
      const project = projectFromNativeWorkingPreparation(
        options.saved,
        options.savedFiles,
        options.prepared,
      );
      const data = parseTestData(project.tests[options.testId]?.data);
      if (!data)
        return {
          status: 'blocked',
          diagnostics: [
            { path: '/tests/' + options.testId + '/data', message: 'Invalid or missing Test.' },
          ],
        };
      const built = buildRuntimePlaybackSpecFromTestData(options.testId, data);
      if (!built.ok || !built.spec || !built.runner)
        return { status: 'blocked', diagnostics: built.diagnostics };
      test = { runner: built.runner, spec: built.spec };
    }
    const lease = retained;
    lease.leases++;
    let released = false;
    return {
      status: 'prepared',
      artifact: lease.result.artifact,
      workingRevision: options.prepared.workingRevision,
      ...(test ? { test } : {}),
      async dispose() {
        if (released) return;
        released = true;
        lease.leases--;
        if (lease.retired && lease.leases === 0) await lease.result.dispose();
      },
    };
  }

  clear(): Promise<void> {
    return this.serialized(() => this.clearSerial());
  }

  private async clearSerial(): Promise<void> {
    const retained = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(retained.map((entry) => this.retire(entry)));
  }
}

export interface NativeWorkingRuntimeOptions {
  prepared: NativeAuthoringPreparation;
  saved: AuthoringProject;
  savedFiles: Pick<LoadedProjectWorkspaceSnapshot, 'fileRevisions'>;
  projectRoot: string;
  testId?: string;
  shaderCompiler?: RuntimeArtifactShaderCompilerAdapter;
  paths?: RuntimeArtifactPathAdapter;
}

/** Certification-only native dirty → existing runtime/native playback seam.
 * Temporary source files never touch the Project or its published cache. */
export async function prepareNativeWorkingRuntime(
  options: NativeWorkingRuntimeOptions,
): Promise<NativeWorkingRuntimePreparation> {
  const { prepared, projectRoot } = options;
  if (!prepared.accepted)
    return {
      status: 'blocked',
      diagnostics: prepared.diagnostics.length
        ? prepared.diagnostics
        : [{ path: '/', message: prepared.error }],
    };
  const workingProject = projectFromNativeWorkingPreparation(
    options.saved,
    options.savedFiles,
    prepared,
  );
  const project = options.testId ? workingProject : projectWithPreviewLocale(workingProject);
  let test: NativeWorkingRuntimeResult['test'];
  if (options.testId) {
    const data = parseTestData(project.tests[options.testId]?.data);
    if (!data)
      return {
        status: 'blocked',
        diagnostics: [
          { path: '/tests/' + options.testId + '/data', message: 'Invalid or missing Test.' },
        ],
      };
    const built = buildRuntimePlaybackSpecFromTestData(options.testId, data);
    if (!built.ok || !built.spec || !built.runner)
      return { status: 'blocked', diagnostics: built.diagnostics };
    test = { runner: built.runner, spec: built.spec };
  }
  const overlays = { ...prepared.textOverlays, ...prepared.shaderOverlays };
  const root = await mkdtemp(path.join(tmpdir(), 'noveltea-native-preview-'));
  try {
    const relocated = new Map<string, string>();
    for (const [name, text] of Object.entries(overlays)) {
      if (
        !name ||
        path.posix.normalize(name) !== name ||
        name.startsWith('/') ||
        name.split('/').includes('..') ||
        name.includes('\\') ||
        name.includes(':')
      )
        throw new Error('Unsafe native preview source identity.');
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text, { flag: 'wx' });
      relocated.set(name, target);
    }
    const base = options.paths ?? nodeRuntimeArtifactPaths;
    const paths: RuntimeArtifactPathAdapter = {
      ...base,
      resolveProjectSource(project, source) {
        return relocated.get(source) ?? base.resolveProjectSource(project, source);
      },
      async readProjectTextSources(project, entries) {
        const originals =
          (await base.readProjectTextSources?.(
            project,
            entries.filter((entry) => !relocated.has(entry.projectRelativePath)),
          )) ?? [];
        const dirty: Array<
          | { status: 'unavailable'; assetId: string }
          | {
              status: 'ready';
              assetId: string;
              projectRelativePath: string;
              contentHash: Sha256Digest;
              byteLength: number;
              text: string;
            }
        > = [];
        for (const entry of entries) {
          const text = overlays[entry.projectRelativePath];
          if (text === undefined) continue;
          const bytes = Buffer.from(text);
          const contentHash = ('sha256:' +
            createHash('sha256').update(bytes).digest('hex')) as Sha256Digest;
          if (entry.expectedContentHash !== null && entry.expectedContentHash !== contentHash) {
            dirty.push({ status: 'unavailable', assetId: entry.assetId });
          } else {
            dirty.push({
              status: 'ready',
              assetId: entry.assetId,
              projectRelativePath: entry.projectRelativePath,
              contentHash,
              byteLength: bytes.length,
              text,
            });
          }
        }
        return [...originals, ...dirty];
      },
    };
    const baseCompiler = options.shaderCompiler ?? nodeShaderCompilerAdapter(compileShaders);
    const runtime = await prepareRuntimeArtifact({
      project,
      projectRoot,
      profile: selectedExportProfile(project),
      intent: test ? 'test-playback' : 'play',
      shaderCompiler: {
        compile: (shaderProject, shaderOptions) =>
          baseCompiler.compile(shaderProject, {
            ...shaderOptions,
            sourceOverlays: { ...shaderOptions.sourceOverlays, ...prepared.shaderOverlays },
          }),
      },
      paths,
    });
    if (runtime.status !== 'prepared') {
      await rm(root, { recursive: true, force: true });
      return { status: 'blocked', diagnostics: runtime.diagnostics };
    }
    return {
      status: 'prepared',
      artifact: runtime.artifact,
      workingRevision: prepared.workingRevision,
      ...(test ? { test } : {}),
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Capture an active native working session, then reject a late build if that
 * session was edited or closed while the runtime compiler was running. */
export async function prepareNativeWorkingSession(
  working: NativeAuthoringWorkingProject,
  savedWorkspace: ActiveProjectWorkspaceSession,
  options: Pick<NativeWorkingRuntimeOptions, 'testId' | 'shaderCompiler' | 'paths'> & {
    cache?: NativeWorkingRuntimePreparationCache;
  } = {},
): Promise<NativeWorkingRuntimePreparation> {
  const sessionId = working.sessionId();
  const prepared = await working.prepareWorking(options.testId);
  const input = {
    testId: options.testId,
    shaderCompiler: options.shaderCompiler,
    paths: options.paths,
    prepared,
    saved: savedWorkspace.project(),
    savedFiles: savedWorkspace.snapshot(),
    projectRoot: savedWorkspace.projectRoot(),
  };
  const result = await (options.cache
    ? options.cache.prepare(input)
    : prepareNativeWorkingRuntime(input));
  if (
    working.sessionId() !== sessionId ||
    working.snapshot()?.workingRevision !== prepared.workingRevision
  ) {
    if (result.status === 'prepared') await result.dispose();
    throw new Error('Native working Project changed during preview/Test preparation.');
  }
  return result;
}

/** Execute the prepared authored Test through the same runtime or runtime-ui
 * native entrypoints as the editor. Never interpret it in the authoring worker. */
export async function runNativeWorkingTest(
  result: NativeWorkingRuntimeResult,
  projectRoot: string,
  invoke: (operation: string, request: unknown) => Promise<unknown> = invokeNovelTeaNativeOperation,
): Promise<unknown> {
  if (!result.test) throw new Error('Native preparation does not contain an authored Test.');
  const { artifact, test } = result;
  if (test.runner === 'runtime-ui')
    return invoke('run-ui-test', {
      project: artifact.compiledProject,
      spec: test.spec,
      projectRoot,
      shaderMaterialMetadata: artifact.shaderMaterialMetadata ?? null,
      shaderVariants: artifact.packageOptions.shaderVariants,
    });
  return invoke('run-test', {
    project: artifact.compiledProject,
    spec: test.spec,
    shaderVariants: artifact.packageOptions.shaderVariants,
  });
}
