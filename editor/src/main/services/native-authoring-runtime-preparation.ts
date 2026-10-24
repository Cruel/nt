import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';
import {
  AUTHORING_PROJECT_SCHEMA,
  authoringCollectionKeys,
} from '../../shared/project-schema/authoring-collections';
import { selectedExportProfile } from '../../shared/project-schema/authoring-export';
import type { TestData } from '../../shared/project-schema/authoring-tests';
import { buildRuntimePlaybackSpecFromTestData } from '../../shared/project-schema/test-playback-projection';
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
import { invokeNovelTeaNativeOperation } from '../../shared/noveltea-cli-subprocess';
import type { Sha256Digest } from '../../shared/project-text-sources';
import type { ShaderVariant } from '../../shared/shader-variants';
import { compileShaders } from './native-shader-compiler-service';
import type { NativeAuthoringPreparation } from './native-authoring-worker-contract';
import { classifyProjectValidationDiagnostics } from '../../shared/project-schema/project-diagnostic-projection';
import { nativeAssetContentHashes, verifyNativeSourceBytes } from './native-authoring-source-proof';

/** Consume every effective native owner without TypeScript schema validation
 * or normalization. The addon owns canonical Project and record semantics;
 * this host boundary only checks transport shape and supplies editor-only
 * local view defaults not stored in tracked editor.yaml. */
export function projectFromNativeCompletePreparation(
  prepared: NativeAuthoringPreparation,
): AuthoringProject {
  if (
    !prepared.accepted ||
    !prepared.completeProject ||
    typeof prepared.completeProject !== 'object' ||
    Array.isArray(prepared.completeProject)
  )
    throw new Error(prepared.error || 'Native complete working Project was not available.');
  const raw = prepared.completeProject as Record<string, unknown>;
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const project = raw.project;
  if (
    raw.schema !== AUTHORING_PROJECT_SCHEMA ||
    !isObject(project) ||
    typeof project.id !== 'string' ||
    typeof project.name !== 'string' ||
    !isObject(raw.settings) ||
    !isObject(raw.export) ||
    !isObject(raw.bootstrapModule) ||
    !Object.hasOwn(raw, 'undefinedInteractionProgram') ||
    !Object.hasOwn(raw, 'entrypoint') ||
    !isObject(raw.prefetchHints) ||
    !isObject(raw.traits) ||
    !isObject(raw.localization) ||
    !Array.isArray(raw.inventories) ||
    !isObject(raw.interactableInstances) ||
    (raw.editor !== undefined && !isObject(raw.editor))
  )
    throw new Error('Native complete Project returned an invalid transport shape.');
  const candidate: Record<string, unknown> = {
    ...raw,
    editor: {
      ...emptyEditorProjectState(),
      ...(raw.editor && typeof raw.editor === 'object' && !Array.isArray(raw.editor)
        ? raw.editor
        : {}),
    },
  };
  for (const family of authoringCollectionKeys) {
    if (!(family in candidate)) candidate[family] = {};
    else if (!isObject(candidate[family]))
      throw new Error(`Native complete Project returned malformed ${family} transport.`);
  }
  // Only missing empty collection containers are a wire-format adaptation.
  // Do not invoke Zod or rewrite native record data: C++ generated contracts
  // own all authored schema defaults and semantic checks.
  return candidate as unknown as AuthoringProject;
}

function nativeRuntimeProject(options: NativeWorkingRuntimeOptions): AuthoringProject {
  return options.legacy
    ? options.legacy.project()
    : projectFromNativeCompletePreparation(options.prepared);
}

function admittedPlaybackTestData(
  options: NativeWorkingRuntimeOptions,
  project: AuthoringProject,
): TestData | null {
  const value = project.tests[options.testId!]?.data;
  if (options.legacy) return options.legacy.testData(value);
  // Native admission owns defaults/validation. Only assert the transport
  // fields required to construct a typed runtime playback specification.
  const data = value as TestData | null | undefined;
  return data?.kind === 'test' && Array.isArray(data.steps) && Array.isArray(data.finalExpectations)
    ? data
    : null;
}

/** The full native response carries a physically verified manifest, not an
 * independent TypeScript saved Workspace. Recheck every byte before compile
 * or cache reuse so neither files nor binary Assets can change unnoticed. */
async function verifyCompleteNativeSources(options: NativeWorkingRuntimeOptions): Promise<void> {
  if (options.legacy) return;
  const root = await realpath(options.projectRoot);
  const revisions = Object.entries(options.prepared.sourceRevisions);
  const assetHashes = nativeAssetContentHashes(
    projectFromNativeCompletePreparation(options.prepared),
  );
  if (!revisions.some(([file]) => file === 'project.yaml'))
    throw new Error('Native complete preparation omitted its Project manifest revision.');
  for (const [relative, expected] of revisions) {
    if (
      !relative ||
      relative.startsWith('/') ||
      relative.includes('\\') ||
      relative.includes(':') ||
      relative.includes('\0') ||
      path.posix.normalize(relative) !== relative ||
      relative.split('/').includes('..')
    )
      throw new Error('Native complete preparation contains an unsafe source path.');
    const candidate = path.join(root, relative);
    let bytes: Buffer | null = null;
    try {
      const canonical = await realpath(candidate);
      if (!canonical.startsWith(root + path.sep))
        throw new Error('Native complete preparation source escapes Project root: ' + relative);
      bytes = await readFile(canonical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (expected === 'absent' && bytes === null) continue;
    if (bytes === null || expected === 'absent')
      throw new Error('Native complete preparation source changed on disk: ' + relative);
    verifyNativeSourceBytes(relative, expected, bytes, assetHashes);
  }
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
    const { prepared, legacy } = options;
    const effective = legacy ? legacy.project() : projectFromNativeCompletePreparation(prepared);
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
      Boolean(options.testSuite),
      options.shaderVariant ?? null,
      { ...effective, tests: {} },
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
    await verifyCompleteNativeSources(options);
    nativeRuntimeProject(options);
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
      const project = nativeRuntimeProject(options);
      const data = admittedPlaybackTestData(options, project);
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
  /** Isolated pre-#521 legacy adapter. Native candidate never imports its implementation. */
  legacy?: {
    project(): AuthoringProject;
    prepare: typeof prepareRuntimeArtifact;
    testData(value: unknown): TestData | null;
  };
  projectRoot: string;
  testId?: string;
  testSuite?: boolean;
  shaderVariant?: ShaderVariant;
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
  await verifyCompleteNativeSources(options);
  const workingProject = nativeRuntimeProject(options);
  const project = options.testId ? workingProject : projectWithPreviewLocale(workingProject);
  let test: NativeWorkingRuntimeResult['test'];
  if (options.testId) {
    const data = admittedPlaybackTestData(options, project);
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
    const prepare = options.legacy?.prepare ?? prepareRuntimeArtifact;
    if (!options.legacy && !Array.isArray(prepared.referencedAssetIds))
      throw new Error('Native complete preparation omitted admitted Runtime Asset references.');
    const runtime = await prepare({
      project,
      ...(!options.legacy
        ? {
            admittedAuthoringDiagnostics: classifyProjectValidationDiagnostics(
              prepared.diagnostics,
              { producer: 'authoring' },
            ),
            admittedValidationContributions: [],
            admittedRuntimeAssetReferences: prepared.referencedAssetIds,
          }
        : {}),
      projectRoot,
      profile: {
        ...selectedExportProfile(project),
        ...(options.shaderVariant ? { shaderVariants: [options.shaderVariant] } : {}),
      },
      intent: test || options.testSuite ? 'test-playback' : 'play',
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
    // Compilation may read physical sources after its initial preflight.
    // Recheck the complete pinned revision manifest before admitting the
    // compiled artifact; a concurrent external edit invalidates the build.
    await verifyCompleteNativeSources(options);
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
    projectRoot,
    shaderVariants: artifact.packageOptions.shaderVariants,
  });
}
