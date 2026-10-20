import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ParsedGlobalArguments } from './bootstrap';
import { novelTeaCliUsageFailure } from './bootstrap';
import { cliDiagnostic, formatCliResult, type NovelTeaCliCommandResult } from './contracts';
import { nativeProjectRoot, type NativeProjectCommandCall } from './native-project-lifecycle-cli';
import { nativeProjectDiagnostics } from './native-project-results';
import type { NovelTeaCliNativeToolService } from './native-tool-service';
import {
  removeFileIfPresent,
  nativeSuccess,
  publishStagedPackage,
} from './commands/native-commands';
import type { CliSemanticResult } from './semantic-project';
import { selectedExportProfile } from '../shared/project-schema/authoring-export';
import { authoringCollectionKeys } from '../shared/project-schema/authoring-collections';
import type { AuthoringProject } from '../shared/project-schema/authoring-project';
import { emptyEditorProjectState } from '../shared/project-schema/editor-project-state';
import {
  classifyProjectValidationDiagnostics,
  type ProjectValidationDiagnostic,
} from '../shared/project-schema/project-validation';
import {
  prepareRuntimeArtifact,
  type RuntimeArtifactPathAdapter,
} from '../shared/runtime-artifact-preparation';
import { localizationWarningDiagnostics } from '../shared/export-localization-closure';
import {
  nodeRuntimeArtifactPaths,
  nodeShaderCompilerAdapter,
} from '../main/services/node-runtime-artifact-adapters';
import type { NativeResidentProjectPreparation } from '../shared/project-workspace/resident-project-workspace-service';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace';
import { createNodeProjectWorkspaceFileSystem } from '../shared/project-workspace/node-project-workspace-file-system';
import {
  packageOptionsWithPinnedProjectTextSources,
  pinnedShaderSourceOverlays,
  runtimeArtifactPathsWithPinnedSources,
  type PinnedProjectTextSources,
} from './pinned-project-text-sources';
import {
  verifyPinnedExternalAssets,
  type PinnedExternalAssetExpectation,
} from './pinned-external-assets';

type NativePinnedGeneration = Readonly<{
  projectRoot: string;
  preparation: NativeResidentProjectPreparation | null;
}>;

export interface NativePackageCliOptions {
  readonly pinned?: NativePinnedGeneration;
  readonly pinnedExternalAssets?: readonly PinnedExternalAssetExpectation[];
  readonly pinnedProjectTextSources?: PinnedProjectTextSources;
  readonly paths?: RuntimeArtifactPathAdapter;
  readonly fileSystem?: ProjectWorkspaceFileSystem;
  readonly abortSignal?: AbortSignal;
}

type ParsedPackageExport = Readonly<{
  output: string;
  requestedProfile?: string;
  includeUnusedAssets: boolean;
  includeShaderSources: boolean;
  allowLocalizationWarnings: boolean;
}>;

function parsePackageExport(arguments_: readonly string[]): ParsedPackageExport {
  const valueOptions = new Set(['--output', '--profile']);
  const flags = new Set([
    '--include-unused-assets',
    '--include-shader-sources',
    '--allow-localization-warnings',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index]!;
    if (flags.has(value)) continue;
    if (!valueOptions.has(value)) throw new Error(`Unknown command option '${value}'.`);
    const optionValue = arguments_[index + 1];
    if (!optionValue || optionValue.startsWith('--')) throw new Error(`${value} requires a value.`);
    if (!values.has(value)) values.set(value, optionValue);
    index += 1;
  }
  const output = values.get('--output');
  if (!output) throw new Error("package export requires '--output <path>'.");
  return {
    output,
    ...(values.get('--profile') ? { requestedProfile: values.get('--profile')! } : {}),
    includeUnusedAssets: arguments_.includes('--include-unused-assets'),
    includeShaderSources: arguments_.includes('--include-shader-sources'),
    allowLocalizationWarnings: arguments_.includes('--allow-localization-warnings'),
  };
}

function nativeProject(prepared: NativeResidentProjectPreparation): AuthoringProject {
  if (!prepared.project || typeof prepared.project !== 'object' || Array.isArray(prepared.project))
    throw new Error('Native Runtime Package preparation omitted the Project.');
  if (!prepared.sourceGeneration || !prepared.sourceRevisions?.['project.yaml'])
    throw new Error('Native Runtime Package preparation omitted its source generation.');
  if (
    !prepared.sourceOverlays ||
    Object.values(prepared.sourceOverlays).some((value) => typeof value !== 'string') ||
    !Array.isArray(prepared.referencedAssetIds) ||
    prepared.referencedAssetIds.some((value) => typeof value !== 'string') ||
    Object.entries(prepared.sourceRevisions).some(
      ([name, revision]) =>
        !name ||
        path.posix.normalize(name) !== name ||
        name.startsWith('/') ||
        name.includes('\\') ||
        name.includes(':') ||
        name.split('/').includes('..') ||
        typeof revision !== 'string' ||
        !/^sha256:[0-9a-f]{64}$|^absent$/u.test(revision),
    )
  )
    throw new Error('Native Runtime Package preparation returned invalid source authority.');
  const project: Record<string, unknown> = { ...prepared.project };
  for (const family of authoringCollectionKeys) if (!(family in project)) project[family] = {};
  if (!project.editor) project.editor = emptyEditorProjectState();
  return project as AuthoringProject;
}

function admittedDiagnostics(
  prepared: NativeResidentProjectPreparation,
): ProjectValidationDiagnostic[] {
  return classifyProjectValidationDiagnostics(prepared.cliDiagnostics, { producer: 'authoring' });
}

async function verifyNativeSourceAuthority(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  prepared: NativeResidentProjectPreparation,
): Promise<string | null> {
  for (const [relative, expectedRevision] of Object.entries(prepared.sourceRevisions)) {
    const absolute = fileSystem.joinPath(projectRoot, relative);
    const metadata = fileSystem.readPathMetadata
      ? await fileSystem.readPathMetadata(absolute)
      : { kind: await fileSystem.inspect(absolute) };
    if (expectedRevision === 'absent') {
      if (metadata.kind !== 'missing')
        return `Pinned Project input '${relative}' appeared after native admission.`;
      continue;
    }
    if (metadata.kind !== 'file')
      return `Pinned Project input '${relative}' is no longer the same regular file.`;
    const current = await fileSystem.readFileRevision(absolute);
    if (current.contentHash !== expectedRevision)
      return `Pinned Project input '${relative}' changed after native admission.`;
  }
  return null;
}

function exitFor(result: CliSemanticResult): 0 | 4 | 6 {
  return result.ok
    ? 0
    : result.diagnostics.some((diagnostic) => diagnostic.code.startsWith('native.'))
      ? 6
      : 4;
}

/** Native-authoritative Runtime Package candidate. The native owner admits one
 * exact Project generation; the established Prepared Runtime Artifact and
 * native package writer retain all downstream compilation/export semantics. */
export async function runNativeProjectPackageCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
  nativeTools: NovelTeaCliNativeToolService,
  options: NativePackageCliOptions = {},
): Promise<NovelTeaCliCommandResult | null> {
  if (globals.command[0] !== 'package' || globals.command[1] !== 'export') return null;
  let parsed: ParsedPackageExport;
  try {
    parsed = parsePackageExport(globals.command.slice(2));
  } catch (error) {
    return novelTeaCliUsageFailure(
      error instanceof Error ? error.message : String(error),
      globals.json,
    );
  }
  const fileSystem = options.fileSystem ?? createNodeProjectWorkspaceFileSystem();
  const root =
    options.pinned?.projectRoot ?? (await nativeProjectRoot(cwd, globals.project, fileSystem));
  const result = (
    semantic: CliSemanticResult,
    exitCode: 0 | 3 | 4 | 5 | 6 | 70 | 130 = exitFor(semantic),
  ) =>
    formatCliResult(
      {
        success: semantic.ok && exitCode === 0,
        exitCode,
        diagnostics: semantic.diagnostics,
        ...(root ? { projectRoot: root } : {}),
        ...semantic.fields,
      },
      globals.json,
      {
        success: semantic.humanSuccess ?? 'NovelTea package export succeeded.',
        failure:
          semantic.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ??
          'Runtime Package export failed.',
      },
    );
  const fail = (
    code: string,
    message: string,
    exitCode: 3 | 4 | 5 | 6 | 70 | 130,
    pathValue = '/export/runtime',
  ) => result({ ok: false, diagnostics: [cliDiagnostic(code, pathValue, message)] }, exitCode);
  if (!root)
    return fail('WORKSPACE_NOT_FOUND', 'No NovelTea project.yaml was found.', 3, '/project.yaml');
  const cancelled = (priorDiagnostics: readonly ReturnType<typeof cliDiagnostic>[] = []) =>
    result(
      {
        ok: false,
        diagnostics: [
          ...priorDiagnostics,
          cliDiagnostic(
            'export.cancelled',
            '/output',
            'Runtime Package export was cancelled before publication.',
            'warning',
          ),
        ],
      },
      4,
    );
  if (options.abortSignal?.aborted) return cancelled();
  if (options.pinned && !options.pinned.preparation)
    return fail('CLI_INTERNAL', 'Pinned generation has no native Runtime Package preparation.', 70);
  if (
    options.pinned &&
    (!options.paths || !options.pinnedProjectTextSources || !options.pinnedExternalAssets)
  )
    return fail('CLI_INTERNAL', 'Pinned generation has no complete physical input authority.', 70);

  const outputPath = path.resolve(cwd, parsed.output);
  const stagedPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const admitted = options.pinned?.preparation
      ? { ok: true as const, ...options.pinned.preparation }
      : await native({
          action: 'runtime-package-preparation',
          projectRoot: root,
        });
    if (!admitted.ok) {
      if (admitted.kind === 'conflict')
        return fail('WORKSPACE_REVISION_CONFLICT', admitted.error ?? 'Project sources changed.', 5);
      const projectErrors = nativeProjectDiagnostics({
        cliDiagnostics: admitted.projectDiagnostics,
      });
      if (projectErrors.some((diagnostic) => diagnostic.severity === 'error'))
        return result(
          { ok: false, diagnostics: [...nativeProjectDiagnostics(admitted), ...projectErrors] },
          4,
        );
      return fail(
        'WORKSPACE_SOURCE_READ',
        admitted.error ?? 'Native Runtime Package preparation failed.',
        3,
      );
    }
    const preparation = admitted as unknown as NativeResidentProjectPreparation;
    const ownerDiagnostics = nativeProjectDiagnostics(admitted);
    const project = nativeProject(preparation);
    const baseProfile = selectedExportProfile(project);
    if (
      !options.pinned &&
      ((admitted as Record<string, unknown>).runtimeIntent !== 'runtime-package-export' ||
        JSON.stringify((admitted as Record<string, unknown>).profile) !==
          JSON.stringify(baseProfile) ||
        JSON.stringify((admitted as Record<string, unknown>).projectIdentity) !==
          JSON.stringify(project.project))
    )
      return result(
        {
          ok: false,
          diagnostics: [
            ...ownerDiagnostics,
            cliDiagnostic(
              'CLI_INTERNAL',
              '/export/runtime',
              'Native Runtime Package preparation returned mismatched package authority.',
            ),
          ],
        },
        70,
      );
    if (parsed.requestedProfile && parsed.requestedProfile !== baseProfile.id)
      return result(
        {
          ok: false,
          diagnostics: [
            ...ownerDiagnostics,
            cliDiagnostic(
              'export.profile_missing',
              '/export/runtime',
              `Export profile '${parsed.requestedProfile}' does not exist.`,
            ),
          ],
        },
        4,
      );
    const profile = {
      ...baseProfile,
      ...(parsed.includeUnusedAssets ? { excludeUnusedAssets: false } : {}),
      ...(parsed.includeShaderSources
        ? { includeShaderSources: true, stripShaderSources: false }
        : {}),
    };
    const prove = async () => {
      if (options.abortSignal?.aborted) return { cancelled: true as const };
      if (options.pinnedExternalAssets) {
        const assetDiagnostics = await verifyPinnedExternalAssets(
          fileSystem,
          root,
          options.pinnedExternalAssets,
        );
        if (assetDiagnostics.length > 0)
          return { diagnostic: assetDiagnostics[0]!, exitCode: 4 as const };
      }
      if (!options.pinned) {
        const sourceDrift = await verifyNativeSourceAuthority(fileSystem, root, preparation);
        if (sourceDrift)
          return {
            diagnostic: cliDiagnostic('export.pinned_input_changed', '/output', sourceDrift),
            exitCode: 4 as const,
          };
        const proof = await native({
          action: 'source-generation-proof',
          projectRoot: root,
          expectedSourceGeneration: preparation.sourceGeneration,
        });
        if (!proof.ok)
          return {
            diagnostic: cliDiagnostic(
              'WORKSPACE_REVISION_CONFLICT',
              '/output',
              proof.error ?? 'Native Project generation changed.',
            ),
            exitCode: 5 as const,
          };
      }
      return null;
    };
    const initialProof = await prove();
    if (initialProof?.cancelled) return cancelled(ownerDiagnostics);
    if (initialProof?.diagnostic)
      return result(
        { ok: false, diagnostics: [...ownerDiagnostics, initialProof.diagnostic] },
        initialProof.exitCode,
      );

    await nativeTools.registerStagedOutput?.(stagedPath);
    await fileSystem.writeBytesAtomic(stagedPath, new Uint8Array());
    const prepared = await prepareRuntimeArtifact({
      project,
      admittedAuthoringDiagnostics: admittedDiagnostics(preparation),
      admittedValidationContributions: [],
      admittedRuntimeAssetReferences: preparation.referencedAssetIds,
      projectRoot: root,
      profile,
      intent: 'runtime-package-export',
      shaderCompiler: nodeShaderCompilerAdapter((shaderProject, shaderOptions) =>
        nativeTools.compileShaders(shaderProject, {
          ...shaderOptions,
          sourceOverlays: {
            ...shaderOptions.sourceOverlays,
            ...preparation.sourceOverlays,
            ...pinnedShaderSourceOverlays(options.pinnedProjectTextSources),
          },
        }),
      ),
      paths: runtimeArtifactPathsWithPinnedSources(
        options.paths ?? nodeRuntimeArtifactPaths,
        options.pinnedProjectTextSources,
      ),
      isCancelled: () => options.abortSignal?.aborted === true,
    });
    if (prepared.status === 'cancelled') return cancelled(ownerDiagnostics);
    if (prepared.status !== 'prepared')
      return result({
        ok: false,
        diagnostics: [
          ...ownerDiagnostics,
          ...prepared.diagnostics.map((item) =>
            cliDiagnostic(item.code, item.path, item.message, item.severity),
          ),
        ],
      });
    const localizationWarnings = localizationWarningDiagnostics(prepared.artifact.diagnostics);
    if (localizationWarnings.length > 0 && !parsed.allowLocalizationWarnings)
      return result({
        ok: false,
        diagnostics: [
          ...ownerDiagnostics,
          ...localizationWarnings.map((item) =>
            cliDiagnostic(item.code, item.path, item.message, item.severity),
          ),
          cliDiagnostic(
            'localization.export.warning_override_required',
            '/export/runtime/localization',
            'Localization quality warnings require explicit acknowledgement; pass --allow-localization-warnings to continue.',
          ),
        ],
      });
    const beforeWriter = await prove();
    if (beforeWriter?.cancelled) return cancelled(ownerDiagnostics);
    if (beforeWriter?.diagnostic)
      return result(
        { ok: false, diagnostics: [...ownerDiagnostics, beforeWriter.diagnostic] },
        beforeWriter.exitCode,
      );
    const response = await nativeTools.exportPackage({
      project: prepared.artifact.compiledProject,
      outputPath: stagedPath,
      options: packageOptionsWithPinnedProjectTextSources(
        prepared.artifact.packageOptions,
        options.pinnedProjectTextSources,
      ),
    });
    const semantic = nativeSuccess(response);
    if (!semantic.ok)
      return result({
        ...semantic,
        diagnostics: [...ownerDiagnostics, ...semantic.diagnostics],
      });
    const afterWriter = await prove();
    if (afterWriter?.cancelled) return cancelled(ownerDiagnostics);
    if (afterWriter?.diagnostic)
      return result(
        { ok: false, diagnostics: [...ownerDiagnostics, afterWriter.diagnostic] },
        afterWriter.exitCode,
      );
    const publication = await publishStagedPackage(
      { fileSystem, nativeTools },
      stagedPath,
      outputPath,
    );
    if (publication)
      return result({
        ...publication,
        diagnostics: [...ownerDiagnostics, ...publication.diagnostics],
      });
    return result({
      ...semantic,
      diagnostics: [...ownerDiagnostics, ...semantic.diagnostics],
    });
  } catch (error) {
    if (options.abortSignal?.aborted) return cancelled();
    return fail('CLI_INTERNAL', error instanceof Error ? error.message : String(error), 70);
  } finally {
    await removeFileIfPresent({ fileSystem }, stagedPath).catch(() => undefined);
  }
}
