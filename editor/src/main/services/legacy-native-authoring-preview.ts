import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseTestData } from '../../shared/project-schema/authoring-tests';
import { authoringProjectSchema } from '../../shared/project-schema/authoring-project';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import { compileShaders } from './native-shader-compiler-service';
import { nodeShaderCompilerAdapter } from './node-runtime-artifact-adapters';
import { prepareRuntimeArtifact as prepareLegacyRuntimeArtifact } from '../../shared/legacy-runtime-artifact-preparation';
import {
  NativeWorkingRuntimePreparationCache,
  prepareNativeWorkingRuntime,
  type NativeWorkingRuntimeOptions,
  type NativeWorkingRuntimePreparation,
} from './native-authoring-runtime-preparation';
import type { NativeAuthoringPreparation } from './native-authoring-worker-contract';
import type { NativeAuthoringWorkingProject } from './native-authoring-working-project';
import type { ActiveProjectWorkspaceSession } from './active-project-workspace-session';
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
    if (dirty) {
      const records = { ...saved[family] } as Record<string, unknown>;
      for (const [id, value] of Object.entries(dirty)) {
        if (value === null) delete records[id];
        else records[id] = value;
      }
      candidate[family] = records;
    }
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
    shaderCompiler: options.shaderCompiler ?? nodeShaderCompilerAdapter(compileShaders),
    paths: options.paths,
    prepared,
    legacy: {
      project: () =>
        projectFromNativeWorkingPreparation(
          savedWorkspace.project(),
          savedWorkspace.snapshot(),
          prepared,
        ),
      prepare: prepareLegacyRuntimeArtifact,
      testData: parseTestData,
    },
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
