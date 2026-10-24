import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { selectedExportProfile } from '../../shared/project-schema/authoring-export';
import { runtimeExportProfileForPlatform } from '../../shared/project-schema/authoring-export';
import { parseProjectPlatformExportSettings } from '../../shared/project-schema/platform-export-contracts';
import {
  prepareRuntimeArtifact,
  type PreparedRuntimeArtifact,
  type RuntimeArtifactPathAdapter,
  type RuntimeArtifactShaderCompilerAdapter,
  type PrepareRuntimeArtifactResult,
} from '../../shared/runtime-artifact-preparation';
import {
  nodeRuntimeArtifactPaths,
  nodeShaderCompilerAdapter,
} from './node-runtime-artifact-adapters';
import { compileShaders } from './native-shader-compiler-service';
import type {
  NativeCleanExportAdmission,
  NativeEditorSessionController,
} from './native-editor-session-controller';

type CleanExportOwner = Pick<NativeEditorSessionController, 'prepareCleanExportAdmission'>;

function assertExportRevision(
  admission: NativeCleanExportAdmission,
  expectedRevision: number,
): void {
  if (admission.workingRevision !== expectedRevision)
    throw new Error('Stale native Project export revision.');
}

export async function prepareNativeEditorExportAssessment(
  owner: CleanExportOwner,
  sessionId: string,
  expectedRevision: number,
  projectRoot: string,
  mode: 'runtime' | 'platform',
  profileId?: string,
): Promise<PrepareRuntimeArtifactResult> {
  const admission = await owner.prepareCleanExportAdmission(sessionId);
  assertExportRevision(admission, expectedRevision);
  let profile = selectedExportProfile(admission.project);
  if (mode === 'platform') {
    const configured = parseProjectPlatformExportSettings({
      profiles: admission.project.export.profiles,
      assetMemoryPolicies: admission.project.export.assetMemoryPolicies,
    }).profiles.find((item) => item.id === profileId);
    if (!configured) throw new Error('Native platform export profile is no longer available.');
    profile = {
      ...runtimeExportProfileForPlatform(
        admission.project,
        configured.target,
        configured.localization,
      ),
      excludeUnusedAssets: configured.excludeUnusedAssets,
      includeShaderSources: configured.includeShaderSources,
      stripShaderSources: !configured.includeShaderSources,
    };
  }
  const result = await prepareRuntimeArtifact({
    project: admission.project,
    admittedAuthoringDiagnostics: admission.diagnostics,
    admittedValidationContributions: [],
    admittedRuntimeAssetReferences: admission.runtimeAssetReferences,
    projectRoot,
    profile,
    intent: mode === 'platform' ? 'platform-preflight' : 'runtime-package-preflight',
    paths: nodeRuntimeArtifactPaths,
  });
  await verifyNativeCleanExportAdmission(owner, sessionId, admission);
  return result;
}

/** A completed build may not publish after an intervening editor Save or CLI
 * write, even if a second native admission would accept the newer bytes. */
export async function verifyNativeCleanExportAdmission(
  owner: CleanExportOwner,
  sessionId: string,
  original: NativeCleanExportAdmission,
): Promise<void> {
  const current = await owner.prepareCleanExportAdmission(sessionId);
  const previous = Object.entries(original.sourceRevisions).sort(([a], [b]) => a.localeCompare(b));
  const latest = Object.entries(current.sourceRevisions).sort(([a], [b]) => a.localeCompare(b));
  if (
    current.workingRevision !== original.workingRevision ||
    JSON.stringify(previous) !== JSON.stringify(latest)
  )
    throw new Error('Native Project sources changed during export; retry with current sources.');
}

export interface NativeEditorPackageTools {
  readonly prepare?: typeof prepareRuntimeArtifact;
  readonly shaderCompiler?: RuntimeArtifactShaderCompilerAdapter;
  readonly paths?: RuntimeArtifactPathAdapter;
  readonly authorizePackageOptions?: (options: PreparedRuntimeArtifact['packageOptions']) => void;
  readonly publish: (
    project: PreparedRuntimeArtifact['compiledProject'],
    outputPath: string,
    options: PreparedRuntimeArtifact['packageOptions'],
  ) => Promise<unknown>;
}

/** Native admission plus the retained post-admission compiler/package writer.
 * Never open a TypeScript Workspace or call the legacy runtime preparation.
 * The output is staged beside its final path until all source proofs pass. */
export async function exportNativeEditorPackage(
  owner: CleanExportOwner,
  sessionId: string,
  projectRoot: string,
  outputPath: string,
  tools: NativeEditorPackageTools,
  expectedRevision?: number,
): Promise<unknown> {
  const admission = await owner.prepareCleanExportAdmission(sessionId);
  if (expectedRevision !== undefined) assertExportRevision(admission, expectedRevision);
  const prepared = await (tools.prepare ?? prepareRuntimeArtifact)({
    project: admission.project,
    admittedAuthoringDiagnostics: admission.diagnostics,
    admittedValidationContributions: [],
    admittedRuntimeAssetReferences: admission.runtimeAssetReferences,
    projectRoot,
    profile: { ...selectedExportProfile(admission.project), outputPath },
    intent: 'runtime-package-export',
    shaderCompiler: tools.shaderCompiler ?? nodeShaderCompilerAdapter(compileShaders),
    paths: tools.paths ?? nodeRuntimeArtifactPaths,
  });
  if (prepared.status !== 'prepared')
    throw new Error(
      prepared.status === 'blocked'
        ? prepared.diagnostics.map((item) => item.message).join('; ')
        : 'Native Project runtime package preparation was cancelled.',
    );
  tools.authorizePackageOptions?.(prepared.artifact.packageOptions);
  await verifyNativeCleanExportAdmission(owner, sessionId, admission);
  const finalPath = path.resolve(outputPath);
  const directory = path.dirname(finalPath);
  await mkdir(directory, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(directory, '.noveltea-package-'));
  try {
    const staged = path.join(stagingRoot, path.basename(finalPath));
    const result = await tools.publish(
      prepared.artifact.compiledProject,
      staged,
      prepared.artifact.packageOptions,
    );
    if (!result || typeof result !== 'object' || !('success' in result) || !result.success)
      return result;
    await verifyNativeCleanExportAdmission(owner, sessionId, admission);
    await rename(staged, finalPath);
    return result;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
