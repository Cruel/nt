import path from 'node:path';
import type { ParsedGlobalArguments } from './bootstrap';
import { novelTeaCliUsageFailure } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  type NovelTeaCliCommandResult,
  type NovelTeaCliDiagnostic,
} from './contracts';
import { nativeProjectRoot, type NativeProjectCommandCall } from './native-project-lifecycle-cli';
import {
  admittedDiagnostics,
  nativeProject,
  verifyNativeSourceAuthority,
} from './native-project-package-cli';
import { nativeProjectDiagnostics } from './native-project-results';
import type { NovelTeaCliPlatformToolService } from './platform-tool-service';
import { parsePlatformOptions, parsePlatformTemplateToken } from './platform-command-helpers';
import {
  verifyPinnedExternalAssets,
  type PinnedExternalAssetExpectation,
} from './pinned-external-assets';
import { createNodeProjectWorkspaceFileSystem } from '../shared/project-workspace/node-project-workspace-file-system';
import {
  assertProjectWorkspacePathContained,
  type ProjectWorkspaceFileSystem,
} from '../shared/project-workspace/project-workspace-file-system';
import type { NativeResidentProjectPreparation } from '../shared/project-workspace/native-project-preparation-contracts';
import { projectWorkspaceLocalStateFile } from '../shared/editor-local-state-file';
import { EDITOR_LOCAL_STATE_SCHEMA } from '../shared/project-workspace/project-workspace-contracts';
import {
  editorProjectStateSchema,
  emptyEditorProjectState,
  type EditorProjectState,
} from '../shared/project-schema/editor-project-state';
import { projectSettingsFromProject } from '../shared/project-schema/authoring-project-settings';
import {
  parseEditorExportLocalState,
  parseProjectPlatformExportSettings,
  userSigningProfileToExportSigningState,
  type ProjectPlatformExportRequest,
  type PlatformStageDiagnostic,
} from '../shared/project-schema/platform-export-contracts';
import type { RuntimeArtifactPathAdapter } from '../shared/runtime-artifact-preparation';

export interface NativePlatformCliOptions {
  readonly pinned?: Readonly<{
    projectRoot: string;
    preparation: NativeResidentProjectPreparation | null;
  }>;
  readonly pinnedExternalAssets?: readonly PinnedExternalAssetExpectation[];
  readonly pinnedProjectTextSources?: Readonly<
    Record<string, Readonly<{ text: string; contentHash?: string }>>
  >;
  readonly paths?: RuntimeArtifactPathAdapter;
  readonly fileSystem?: ProjectWorkspaceFileSystem;
  readonly abortSignal?: AbortSignal;
  readonly onProgress?: (stage: string, message: string) => void;
}

function platformDiagnostics(
  diagnostics: readonly PlatformStageDiagnostic[],
): NovelTeaCliDiagnostic[] {
  return diagnostics.map((item) =>
    cliDiagnostic(
      /toolchain|signing|host/.test(item.code) ? `native.${item.code}` : item.code,
      item.path,
      item.message,
      item.severity,
    ),
  );
}

/** The local editor-state file is ignored Project metadata, not a tracked native
 * source. Read its latest bytes and preserve recovery/drafts when recording an
 * accepted publication. Do not use an older prepared Project editor snapshot. */
async function readLocalState(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
): Promise<{ state: EditorProjectState; text: string | null }> {
  const localPath = fileSystem.joinPath(root, '.noveltea/editor/state.json');
  await assertProjectWorkspacePathContained(fileSystem, root, localPath);
  const kind = await fileSystem.inspect(localPath);
  if (kind === 'missing') return { state: emptyEditorProjectState(), text: null };
  if (kind !== 'file') throw new Error('Local editor state is not a regular file.');
  const text = await fileSystem.readText(localPath);
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || raw.schema !== EDITOR_LOCAL_STATE_SCHEMA)
    throw new Error('Local editor state uses an unsupported schema.');
  const state = editorProjectStateSchema.parse({
    ...raw,
    schema: emptyEditorProjectState().schema,
  });
  return { state, text };
}

async function acceptLocalIdentity(
  fileSystem: ProjectWorkspaceFileSystem,
  root: string,
  expected: string | null,
  identity: { applicationId: string; saveNamespace: string },
): Promise<boolean> {
  const current = await readLocalState(fileSystem, root);
  // Never overwrite editor recovery state written by an active editor during export.
  if (current.text !== expected) return false;
  const next = editorProjectStateSchema.parse({
    ...current.state,
    lastSuccessfulPlatformExportIdentity: {
      ...identity,
      completedAt: new Date().toISOString(),
    },
  });
  const localDirectory = fileSystem.joinPath(root, '.noveltea/editor');
  await assertProjectWorkspacePathContained(fileSystem, root, localDirectory);
  await fileSystem.createDirectory(localDirectory);
  await fileSystem.writeTextAtomic(
    fileSystem.joinPath(root, '.noveltea/editor/state.json'),
    projectWorkspaceLocalStateFile(next),
  );
  return true;
}

/**
 * Native Project authority candidate for both platform preflight and publication.
 * Template selection, package writing, signing and transactional activation all
 * remain in the established platform service.
 */
export async function runNativeProjectPlatformCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
  platformTools: NovelTeaCliPlatformToolService,
  options: NativePlatformCliOptions = {},
): Promise<NovelTeaCliCommandResult | null> {
  if (globals.command[0] !== 'platform' || globals.command[1] !== 'export') return null;
  let parsed: ReturnType<typeof parsePlatformOptions>;
  try {
    parsed = parsePlatformOptions(
      globals.command.slice(2),
      ['--output', '--profile', '--template', '--config', '--signing-profile'],
      [
        '--check',
        '--force',
        '--sign',
        '--allow-untrusted-template',
        '--allow-identity-change',
        '--allow-localization-warnings',
        '--include-unused-assets',
        '--include-shader-sources',
      ],
    );
    if (!parsed.values['--output']) throw new Error("platform export requires '--output <path>'.");
    if (parsed.values['--template']) parsePlatformTemplateToken(parsed.values['--template']);
    if (parsed.values['--config'] && parsed.values['--signing-profile'])
      throw new Error(
        '--signing-profile cannot be combined with --config; select signing inside the explicit config instead.',
      );
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
    success: boolean,
    diagnostics: readonly NovelTeaCliDiagnostic[],
    fields: Readonly<Record<string, unknown>> = {},
    exitCode: 0 | 3 | 4 | 5 | 6 | 70 = success
      ? 0
      : diagnostics.some((item) => item.code.startsWith('native.'))
        ? 6
        : 4,
    humanSuccess?: string,
  ) =>
    formatCliResult(
      {
        success,
        exitCode,
        diagnostics,
        ...(root ? { projectRoot: root } : {}),
        ...fields,
      },
      globals.json,
      {
        success: humanSuccess ?? 'Platform export succeeded.',
        failure:
          diagnostics.find((item) => item.severity === 'error')?.message ??
          'Platform export failed.',
      },
    );
  const fail = (code: string, message: string, exitCode: 3 | 4 | 5 | 6 | 70, at = '/export') =>
    result(false, [cliDiagnostic(code, at, message)], {}, exitCode);
  if (!root)
    return fail('WORKSPACE_NOT_FOUND', 'No NovelTea project.yaml was found.', 3, '/project.yaml');
  if (options.abortSignal?.aborted)
    return fail('export.cancelled', 'Platform export was cancelled.', 4);
  if (options.pinned && !options.pinned.preparation)
    return fail('CLI_INTERNAL', 'Pinned generation has no native platform preparation.', 70);
  if (
    options.pinned &&
    (!options.paths || !options.pinnedProjectTextSources || !options.pinnedExternalAssets)
  )
    return fail('CLI_INTERNAL', 'Pinned generation has no complete physical input authority.', 70);

  try {
    const response = options.pinned?.preparation
      ? { ok: true as const, ...options.pinned.preparation }
      : await native({ action: 'platform-export-preparation', projectRoot: root });
    if (!response.ok) {
      if (response.kind === 'conflict')
        return fail('WORKSPACE_REVISION_CONFLICT', response.error ?? 'Project sources changed.', 5);
      const diagnostics = nativeProjectDiagnostics({ cliDiagnostics: response.projectDiagnostics });
      if (diagnostics.some((item) => item.severity === 'error'))
        return result(false, [...nativeProjectDiagnostics(response), ...diagnostics]);
      return fail(
        'WORKSPACE_SOURCE_READ',
        response.error ?? 'Native platform preparation failed.',
        3,
      );
    }
    const preparation = response as unknown as NativeResidentProjectPreparation;
    if (
      !options.pinned &&
      ((response as Record<string, unknown>).runtimeIntent !== 'platform-export' ||
        JSON.stringify((response as Record<string, unknown>).projectIdentity) !==
          JSON.stringify(preparation.project.project))
    )
      return fail('CLI_INTERNAL', 'Native platform preparation returned mismatched authority.', 70);
    const project = nativeProject(preparation);
    const ownerDiagnostics = nativeProjectDiagnostics(response);
    const profiles = parseProjectPlatformExportSettings({
      profiles: project.export.profiles,
      assetMemoryPolicies: project.export.assetMemoryPolicies,
    }).profiles;
    const requestedProfile = parsed.values['--profile'];
    const profile = requestedProfile
      ? profiles.find((item) => item.id === requestedProfile)
      : profiles.length === 1
        ? profiles[0]
        : undefined;
    if (!profile)
      return result(false, [
        ...ownerDiagnostics,
        cliDiagnostic(
          'platform.profile_missing',
          '/export/profiles',
          requestedProfile
            ? `Platform export profile '${requestedProfile}' does not exist.`
            : profiles.length === 0
              ? 'No platform export profiles are configured.'
              : "Multiple platform export profiles are configured; pass '--profile <id>'.",
        ),
      ]);

    let local: { state: EditorProjectState; text: string | null };
    try {
      local = await readLocalState(fileSystem, root);
    } catch (error) {
      return fail(
        'platform.local_state_invalid',
        error instanceof Error ? error.message : String(error),
        4,
        '/.noveltea/editor/state.json',
      );
    }
    const settings = projectSettingsFromProject(project);
    const identity = {
      applicationId:
        profile.target === 'android'
          ? (settings.app.android.applicationId ?? settings.app.applicationId)
          : settings.app.applicationId,
      saveNamespace: settings.app.saveNamespace,
    };
    const previous = local.state.lastSuccessfulPlatformExportIdentity;
    if (
      previous &&
      (previous.applicationId !== identity.applicationId ||
        previous.saveNamespace !== identity.saveNamespace) &&
      !parsed.flags.has('--allow-identity-change')
    )
      return result(false, [
        ...ownerDiagnostics,
        cliDiagnostic(
          'platform.identity_change_acknowledgement_required',
          '/settings/app',
          `Application identity changed from '${previous.applicationId}'/'${previous.saveNamespace}' to '${identity.applicationId}'/'${identity.saveNamespace}'; pass --allow-identity-change to continue.`,
        ),
      ]);
    const signingProfileId = parsed.values['--signing-profile'];
    const sign = parsed.flags.has('--sign') || signingProfileId !== undefined;
    let localState: ProjectPlatformExportRequest['localState'];
    const config = parsed.values['--config'];
    if (config) {
      try {
        const contents = parseEditorExportLocalState(
          JSON.parse(await fileSystem.readText(path.resolve(cwd, config))) as unknown,
        );
        localState = { ...contents.toolchains, signing: contents.signing };
      } catch (error) {
        return result(false, [
          ...ownerDiagnostics,
          cliDiagnostic(
            'platform.config_invalid',
            '/config',
            error instanceof Error ? error.message : String(error),
          ),
        ]);
      }
    } else {
      const user = await platformTools.loadUserConfig();
      localState = { ...user.toolchains };
      if (sign) {
        const matching = user.signingProfiles.filter((item) => item.target === profile.target);
        const selected = signingProfileId
          ? matching.find((item) => item.id === signingProfileId)
          : matching.length === 1
            ? matching[0]
            : undefined;
        if (!selected)
          return result(false, [
            ...ownerDiagnostics,
            cliDiagnostic(
              'platform.signing_profile_required',
              '/signingProfile',
              signingProfileId
                ? `Signing profile '${signingProfileId}' is not configured for ${profile.target}.`
                : matching.length === 0
                  ? `No signing profile is configured for ${profile.target}.`
                  : `Multiple signing profiles are configured for ${profile.target}; pass --signing-profile <id>.`,
            ),
          ]);
        localState.signing = userSigningProfileToExportSigningState(selected);
      }
    }
    const prove = async (): Promise<string | null> => {
      if (options.abortSignal?.aborted) return 'Platform export was cancelled.';
      if (options.pinnedExternalAssets) {
        const drift = await verifyPinnedExternalAssets(
          fileSystem,
          root,
          options.pinnedExternalAssets,
        );
        if (drift.length) return drift[0]!.message;
      }
      // Pinned compilation does not authorize publishing an obsolete Project
      // generation. Inspect physical revisions without re-admitting the pinned
      // snapshot in a disposable worker.
      const physical = await verifyNativeSourceAuthority(fileSystem, root, preparation);
      if (physical) return physical;
      if (!options.pinned) {
        const source = await native({
          action: 'source-generation-proof',
          projectRoot: root,
          expectedSourceGeneration: preparation.sourceGeneration,
        });
        if (!source.ok) return source.error ?? 'Native Project source generation changed.';
      }
      return null;
    };
    const initialProof = await prove();
    if (initialProof) return fail('WORKSPACE_REVISION_CONFLICT', initialProof, 5, '/output');

    const template = parsed.values['--template'];
    const checkOnly = parsed.flags.has('--check');
    const output = path.resolve(cwd, parsed.values['--output']!);
    const published = await platformTools.exportProject(
      {
        project,
        projectRoot: root,
        profileId: profile.id,
        outputDirectory: output,
        ...(template ? { templateToken: parsePlatformTemplateToken(template) } : {}),
        checkOnly,
        force: parsed.flags.has('--force'),
        sign,
        allowUntrustedTemplate: parsed.flags.has('--allow-untrusted-template'),
        allowIdentityChange: parsed.flags.has('--allow-identity-change'),
        allowLocalizationWarnings: parsed.flags.has('--allow-localization-warnings'),
        runtimeOptions:
          parsed.flags.has('--include-unused-assets') ||
          parsed.flags.has('--include-shader-sources')
            ? {
                ...(parsed.flags.has('--include-unused-assets')
                  ? { excludeUnusedAssets: false }
                  : {}),
                ...(parsed.flags.has('--include-shader-sources')
                  ? { includeShaderSources: true }
                  : {}),
              }
            : undefined,
        localState,
      },
      (event) => options.onProgress?.(event.stage, event.message),
      options.abortSignal,
      prove,
      {
        project,
        diagnostics: admittedDiagnostics(preparation),
        contributions: [],
        runtimeAssetReferences: preparation.referencedAssetIds,
        shaderSourceOverlays: preparation.sourceOverlays,
      },
    );
    const diagnostics = [...ownerDiagnostics, ...platformDiagnostics(published.diagnostics)];
    if (!published.success)
      return result(
        false,
        diagnostics,
        {
          operationId: published.operationId,
          cancelled: published.cancelled,
        },
        published.cancelled
          ? 4
          : diagnostics.some((item) => item.code.startsWith('native.'))
            ? 6
            : 4,
      );

    if (checkOnly) {
      const postProof = await prove();
      if (postProof) return fail('WORKSPACE_REVISION_CONFLICT', postProof, 5, '/output');
    } else {
      try {
        if (!(await acceptLocalIdentity(fileSystem, root, local.text, identity)))
          diagnostics.push(
            cliDiagnostic(
              'platform.local_state_changed',
              '/.noveltea/editor/state.json',
              'Platform export succeeded, but editor-local state changed concurrently; identity metadata was not replaced.',
              'warning',
            ),
          );
      } catch (error) {
        diagnostics.push(
          cliDiagnostic(
            'platform.local_state_write_failed',
            '/.noveltea/editor/state.json',
            `Platform export succeeded, but local identity metadata could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
            'warning',
          ),
        );
      }
    }
    return result(
      true,
      diagnostics,
      {
        operationId: published.operationId,
        checked: checkOnly,
        profileId: profile.id,
        templateId: published.templateToken ?? template,
        output: published.outputDirectory,
        artifacts: published.artifacts ?? [],
        deployment: published.deployment,
        manifest: published.manifest,
        signingRequested: published.signingRequested,
        signingApplied: published.signingApplied,
      },
      0,
      checkOnly
        ? `Platform export preflight succeeded for profile '${profile.id}'.`
        : `Exported profile '${profile.id}' to ${published.outputDirectory ?? output}.`,
    );
  } catch (error) {
    return fail('CLI_INTERNAL', error instanceof Error ? error.message : String(error), 70);
  }
}
