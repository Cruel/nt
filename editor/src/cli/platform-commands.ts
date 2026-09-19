import path from 'node:path';
import { runtimeExportProfileForPlatform } from '../shared/project-schema/authoring-export';
import type { AuthoringProject } from '../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../shared/project-schema/authoring-project-settings';
import { editorProjectStateSchema } from '../shared/project-schema/editor-project-state';
import {
  PLAYER_RUNTIME_API_VERSION,
  parseEditorExportLocalState,
  parseProjectPlatformExportSettings,
  projectPlatformExportSettingsSchema,
  userSigningProfileToExportSigningState,
  type InstalledTemplate,
  type PlatformExportProfile,
  type PlatformStageDiagnostic,
  type ProjectPlatformExportRequest,
} from '../shared/project-schema/platform-export-contracts';
import { COMPILED_PROJECT_FORMAT_VERSION } from '../shared/project-schema/compiled-project';
import { evaluateTemplateCompatibility } from '../shared/project-schema/template-compatibility';
import { derivedPlatformCapabilities } from '../shared/project-schema/platform-deployment';
import { CliCommandUsageError } from './commands/errors';
import type {
  CliCommandDefinition,
  CliCommandInvocation,
  CliScopedCommandInvocation,
} from './commands/types';
import { cliDiagnostic, NOVELTEA_CLI_EXIT_CODES } from './contracts';
import { parsePlatformOptions, parsePlatformTemplateToken } from './platform-command-helpers';
import { platformProfilesProjectPreparationIntent } from './project-preparation';

function stageDiagnostics(diagnostics: readonly PlatformStageDiagnostic[]) {
  return diagnostics.map((item) => {
    const native = /toolchain|signing|host/.test(item.code);
    return cliDiagnostic(
      native ? `native.${item.code}` : item.code,
      item.path,
      item.message,
      item.severity,
    );
  });
}

function exactPlatformSettings(project: Pick<AuthoringProject, 'export'>) {
  const parsed = projectPlatformExportSettingsSchema.safeParse({
    profiles: project.export.profiles,
  });
  return parsed.success ? parsed.data : parseProjectPlatformExportSettings(undefined);
}

function hostPlatform(): 'windows' | 'linux' | 'macos' {
  return process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos'
      : 'linux';
}

async function profileRows(
  project: Pick<AuthoringProject, 'export'>,
  profiles: readonly PlatformExportProfile[],
  templates: readonly InstalledTemplate[],
) {
  return profiles.map((profile) => {
    const runtimeProfile = runtimeExportProfileForPlatform(
      project,
      profile.target,
      profile.localization,
    );
    const compatibleTemplate = templates.some((template) => {
      if (template.status === 'corrupted') return false;
      return evaluateTemplateCompatibility(template.descriptor, {
        profile,
        compiledProjectFormatVersion: COMPILED_PROJECT_FORMAT_VERSION,
        playerRuntimeApiVersion: PLAYER_RUNTIME_API_VERSION,
        shaderVariants: runtimeProfile.shaderVariants,
        graphicsBackends: [],
        capabilities: derivedPlatformCapabilities(profile.target),
        requiredFeatures: [],
        host: { platform: hostPlatform(), availableTools: [] },
      }).compatible;
    });
    const artifact =
      profile.target === 'web'
        ? profile.web.artifact
        : profile.target === 'android'
          ? profile.android.artifact
          : profile.desktop.artifact;
    return {
      id: profile.id,
      label: profile.label,
      target: profile.target,
      architecture: profile.architecture,
      buildFlavor: profile.buildFlavor,
      artifact,
      hostCompatible: compatibleTemplate,
    };
  });
}

export const platformProfilesCommand: CliCommandDefinition = {
  path: ['platform', 'profiles'],
  parse(arguments_): CliScopedCommandInvocation {
    if (arguments_.length > 0)
      throw new CliCommandUsageError('platform profiles does not accept arguments.');
    return {
      dryRun: true,
      mutation: false,
      projectPreparation: platformProfilesProjectPreparationIntent,
      async run(context) {
        const exportSettings = context.preparation.exportSettings;
        if (!exportSettings)
          throw new Error('Platform profile preparation did not provide export settings.');
        const project = { export: exportSettings };
        const settings = exactPlatformSettings(project);
        const rows = await profileRows(
          project,
          settings.profiles,
          await context.platformTools.listTemplates(),
        );
        const humanSuccess =
          rows.length === 0
            ? 'No platform export profiles are configured. Create one in the editor.'
            : rows
                .map(
                  (profile) =>
                    `${profile.id}  ${profile.label}  ${profile.target}/${profile.architecture}  ${profile.artifact}`,
                )
                .join('\n');
        return { ok: true, diagnostics: [], fields: { profiles: rows }, humanSuccess };
      },
    };
  },
};

export const platformExportCommand: CliCommandDefinition = {
  path: ['platform', 'export'],
  parse(arguments_): CliCommandInvocation {
    const parsed = parsePlatformOptions(
      arguments_,
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
    const output = parsed.values['--output'];
    if (!output) throw new CliCommandUsageError("platform export requires '--output <path>'.");
    const template = parsed.values['--template'];
    if (template) parsePlatformTemplateToken(template);
    return {
      dryRun: parsed.flags.has('--check'),
      mutation: !parsed.flags.has('--check'),
      mutationEffect: parsed.flags.has('--check') ? undefined : 'opaque',
      async run(context) {
        const settings = exactPlatformSettings(context.snapshot.project);
        const requestedProfile = parsed.values['--profile'];
        const profile = requestedProfile
          ? settings.profiles.find((candidate) => candidate.id === requestedProfile)
          : settings.profiles.length === 1
            ? settings.profiles[0]
            : undefined;
        if (!profile)
          return {
            ok: false,
            diagnostics: [
              cliDiagnostic(
                'platform.profile_missing',
                '/export/profiles',
                requestedProfile
                  ? `Platform export profile '${requestedProfile}' does not exist.`
                  : settings.profiles.length === 0
                    ? 'No platform export profiles are configured.'
                    : "Multiple platform export profiles are configured; pass '--profile <id>'.",
              ),
            ],
          };

        const projectSettings = projectSettingsFromProject(context.snapshot.project);
        const applicationId =
          profile.target === 'android'
            ? (projectSettings.app.android.applicationId ?? projectSettings.app.applicationId)
            : projectSettings.app.applicationId;
        const previousIdentity =
          context.snapshot.project.editor.lastSuccessfulPlatformExportIdentity;
        const identityChanged =
          previousIdentity !== undefined &&
          (previousIdentity.applicationId !== applicationId ||
            previousIdentity.saveNamespace !== projectSettings.app.saveNamespace);
        if (identityChanged && !parsed.flags.has('--allow-identity-change'))
          return {
            ok: false,
            diagnostics: [
              cliDiagnostic(
                'platform.identity_change_acknowledgement_required',
                '/settings/app',
                `Application identity changed from '${previousIdentity.applicationId}'/'${previousIdentity.saveNamespace}' to '${applicationId}'/'${projectSettings.app.saveNamespace}'; pass --allow-identity-change to continue.`,
              ),
            ],
          };

        let localState: ProjectPlatformExportRequest['localState'];
        const configPath = parsed.values['--config'];
        const requestedSigningProfileId = parsed.values['--signing-profile'];
        const signingRequested =
          parsed.flags.has('--sign') || requestedSigningProfileId !== undefined;
        if (configPath) {
          if (requestedSigningProfileId)
            throw new CliCommandUsageError(
              '--signing-profile cannot be combined with --config; select signing inside the explicit config instead.',
            );
          const resolved = path.resolve(context.cwd, configPath);
          try {
            const config = parseEditorExportLocalState(
              JSON.parse(await context.fileSystem.readText(resolved)) as unknown,
            );
            localState = { ...config.toolchains, signing: config.signing };
          } catch (error) {
            return {
              ok: false,
              diagnostics: [
                cliDiagnostic(
                  'platform.config_invalid',
                  '/config',
                  error instanceof Error ? error.message : String(error),
                ),
              ],
            };
          }
        } else {
          const userConfig = await context.platformTools.loadUserConfig();
          localState = { ...userConfig.toolchains };
          if (signingRequested) {
            const matching = userConfig.signingProfiles.filter(
              (item) => item.target === profile.target,
            );
            const selected = requestedSigningProfileId
              ? matching.find((item) => item.id === requestedSigningProfileId)
              : matching.length === 1
                ? matching[0]
                : undefined;
            if (!selected) {
              return {
                ok: false,
                diagnostics: [
                  cliDiagnostic(
                    'platform.signing_profile_required',
                    '/signingProfile',
                    requestedSigningProfileId
                      ? `Signing profile '${requestedSigningProfileId}' is not configured for ${profile.target}.`
                      : matching.length === 0
                        ? `No signing profile is configured for ${profile.target}.`
                        : `Multiple signing profiles are configured for ${profile.target}; pass --signing-profile <id>.`,
                  ),
                ],
              };
            }
            localState.signing = userSigningProfileToExportSigningState(selected);
          }
        }
        const result = await context.platformTools.exportProject(
          {
            project: context.snapshot.project,
            projectRoot: context.snapshot.projectRoot,
            profileId: profile.id,
            outputDirectory: path.resolve(context.cwd, output),
            templateToken: template ? parsePlatformTemplateToken(template) : undefined,
            checkOnly: parsed.flags.has('--check'),
            force: parsed.flags.has('--force'),
            sign: signingRequested,
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
          (event) => context.onPlatformProgress?.(event.stage, event.message),
        );
        const diagnostics = stageDiagnostics(result.diagnostics);
        if (!result.success)
          return {
            ok: false,
            diagnostics,
            fields: { operationId: result.operationId, cancelled: result.cancelled },
            exitCode: result.cancelled ? NOVELTEA_CLI_EXIT_CODES.mutation : undefined,
          };
        if (!parsed.flags.has('--check')) {
          const editorState = editorProjectStateSchema.parse({
            ...context.snapshot.project.editor,
            lastSuccessfulPlatformExportIdentity: {
              applicationId,
              saveNamespace: projectSettings.app.saveNamespace,
              completedAt: new Date().toISOString(),
            },
          });
          await context.workspace.writeEditorLocalState(context.snapshot.projectRoot, editorState);
        }
        return {
          ok: true,
          diagnostics,
          fields: {
            operationId: result.operationId,
            checked: parsed.flags.has('--check'),
            profileId: profile.id,
            templateId: result.templateToken ?? template,
            output: result.outputDirectory,
            artifacts: result.artifacts ?? [],
            deployment: result.deployment,
            manifest: result.manifest,
            signingRequested: result.signingRequested,
            signingApplied: result.signingApplied,
          },
          humanSuccess: parsed.flags.has('--check')
            ? `Platform export preflight succeeded for profile '${profile.id}'.`
            : `Exported profile '${profile.id}' to ${result.outputDirectory ?? path.resolve(context.cwd, output)}.`,
        };
      },
    };
  },
};
