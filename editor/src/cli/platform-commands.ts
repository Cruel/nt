import path from 'node:path';
import { runtimeExportProfileForPlatform } from '../shared/project-schema/authoring-export';
import type { AuthoringProject } from '../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../shared/project-schema/authoring-project-settings';
import { editorProjectStateSchema } from '../shared/project-schema/editor-project-state';
import {
  parseEditorExportLocalState,
  parseProjectPlatformExportSettings,
  projectPlatformExportSettingsSchema,
  userSigningProfileToExportSigningState,
  type InstalledTemplate,
  type PlatformExportProfile,
  type PlatformStageDiagnostic,
  type ProjectPlatformExportRequest,
} from '../shared/project-schema/platform-export-contracts';
import { evaluateTemplateCompatibility } from '../shared/project-schema/template-compatibility';
import { derivedPlatformCapabilities } from '../shared/project-schema/platform-deployment';
import { cliDiagnostic, NOVELTEA_CLI_EXIT_CODES } from './contracts';
import type { NovelTeaCliPlatformToolService } from './platform-tool-service';
import type { CliSemanticResult } from './semantic-project';
import type { CliCommandDefinition, CliCommandInvocation } from './commands/types';
import { CliCommandUsageError } from './commands/types';

type ParsedOptions = Readonly<{
  values: Readonly<Record<string, string>>;
  flags: ReadonlySet<string>;
}>;

function parseOptions(
  arguments_: readonly string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[],
): ParsedOptions {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index]!;
    if (valueOptions.includes(option)) {
      if (values[option] !== undefined)
        throw new CliCommandUsageError(`Option '${option}' may be supplied only once.`);
      const value = arguments_[index + 1];
      if (!value || value.startsWith('--'))
        throw new CliCommandUsageError(`Option '${option}' requires a value.`);
      values[option] = value;
      index += 1;
    } else if (flagOptions.includes(option)) {
      if (flags.has(option))
        throw new CliCommandUsageError(`Option '${option}' may be supplied only once.`);
      flags.add(option);
    } else {
      throw new CliCommandUsageError(`Unknown command option '${option}'.`);
    }
  }
  return { values, flags };
}

function externalToken(template: InstalledTemplate): string {
  return `${template.descriptor.templateId}@${template.descriptor.buildId}`;
}

function internalToken(token: string): string {
  const match = /^([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+)$/.exec(token);
  if (!match)
    throw new CliCommandUsageError(`Invalid template identity '${token}'; expected <id>@<build>.`);
  return `${match[1]}/${match[2]}`;
}

function templateFields(template: InstalledTemplate) {
  return {
    id: externalToken(template),
    templateId: template.descriptor.templateId,
    buildId: template.descriptor.buildId,
    target: template.descriptor.platform,
    architecture: template.descriptor.architecture,
    buildFlavor: template.descriptor.buildFlavor,
    trust: template.entry.trust,
    status: template.status,
  };
}

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

function exactPlatformSettings(project: AuthoringProject) {
  const parsed = projectPlatformExportSettingsSchema.safeParse({
    profiles: project.export.profiles,
  });
  return parsed.success ? parsed.data : parseProjectPlatformExportSettings(undefined);
}

export async function runProjectIndependentPlatformCommand(
  options: Readonly<{
    command: readonly string[];
    projectOption?: string;
    cwd: string;
    platformTools: NovelTeaCliPlatformToolService;
  }>,
): Promise<CliSemanticResult | null> {
  if (options.command[0] !== 'platform') return null;
  const family = options.command[1];
  if (family !== 'template' && family !== 'config') return null;
  if (options.projectOption)
    throw new CliCommandUsageError(
      `Global option '--project' is not supported by project-independent platform commands.`,
    );

  if (family === 'template') {
    const operation = options.command[2];
    const arguments_ = options.command.slice(3);
    if (operation === 'list') {
      if (arguments_.length > 0)
        throw new CliCommandUsageError('platform template list does not accept arguments.');
      const templates = (await options.platformTools.listTemplates()).map(templateFields);
      const humanSuccess =
        templates.length === 0
          ? 'No player templates are installed.'
          : templates
              .map(
                (item) =>
                  `${item.id}  ${item.target}/${item.architecture}  ${item.buildFlavor}  ${item.status}`,
              )
              .join('\n');
      return { ok: true, diagnostics: [], fields: { templates }, humanSuccess };
    }
    if (operation === 'inspect') {
      if (arguments_.length !== 1)
        throw new CliCommandUsageError('Usage: noveltea platform template inspect <id>@<build>.');
      const token = arguments_[0]!;
      internalToken(token);
      const template = await options.platformTools.inspectTemplate(token);
      if (!template)
        return {
          ok: false,
          diagnostics: [
            cliDiagnostic(
              'platform.template_missing',
              '/template',
              `Template '${token}' is not installed.`,
            ),
          ],
        };
      const fields = templateFields(template);
      return {
        ok: true,
        diagnostics: [],
        fields: { template: fields },
        humanSuccess: `${fields.id}  ${fields.status}`,
      };
    }
    if (operation === 'install') {
      if (arguments_.length < 1 || arguments_.length > 2)
        throw new CliCommandUsageError(
          'Usage: noveltea platform template install <archive> [--force].',
        );
      const archive = arguments_[0]!;
      const parsed = parseOptions(arguments_.slice(1), [], ['--force']);
      const result = await options.platformTools.installTemplate(
        path.resolve(options.cwd, archive),
        parsed.flags.has('--force'),
      );
      const diagnostics = result.diagnostics.map((item) =>
        cliDiagnostic(item.code, item.path, item.message),
      );
      if (!result.success || !result.entry) return { ok: false, diagnostics };
      const id = `${result.entry.templateId}@${result.entry.buildId}`;
      return {
        ok: true,
        diagnostics,
        fields: { id, entry: result.entry },
        humanSuccess: `Installed ${id}.`,
      };
    }
    if (operation === 'remove') {
      if (arguments_.length !== 2 || arguments_[1] !== '--force')
        throw new CliCommandUsageError(
          'Usage: noveltea platform template remove <id>@<build> --force.',
        );
      const token = arguments_[0]!;
      internalToken(token);
      const result = await options.platformTools.removeTemplate(token);
      if (!result.removed)
        return {
          ok: false,
          diagnostics: [
            cliDiagnostic(
              'platform.template_missing',
              '/template',
              `Template '${token}' is not installed.`,
            ),
          ],
        };
      return {
        ok: true,
        diagnostics: [],
        fields: { id: token, removed: true },
        humanSuccess: `Removed ${token}.`,
      };
    }
    throw new CliCommandUsageError(`Unknown platform template command '${operation ?? ''}'.`);
  }

  if (options.command[2] !== 'init')
    throw new CliCommandUsageError(
      `Unknown platform config command '${options.command[2] ?? ''}'.`,
    );
  const arguments_ = options.command.slice(3);
  if (arguments_.length < 1 || arguments_.length > 2)
    throw new CliCommandUsageError('Usage: noveltea platform config init <path> [--force].');
  const destination = path.resolve(options.cwd, arguments_[0]!);
  const parsed = parseOptions(arguments_.slice(1), [], ['--force']);
  const config = await options.platformTools.initializeConfig(
    destination,
    parsed.flags.has('--force'),
  );
  return {
    ok: true,
    diagnostics: [],
    fields: { path: destination, config },
    humanSuccess: `Created ${destination}.`,
  };
}

function hostPlatform(): 'windows' | 'linux' | 'macos' {
  return process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos'
      : 'linux';
}

async function profileRows(
  project: AuthoringProject,
  profiles: readonly PlatformExportProfile[],
  templates: readonly InstalledTemplate[],
) {
  return profiles.map((profile) => {
    const runtimeProfile = runtimeExportProfileForPlatform(project, profile.target);
    const compatibleTemplate = templates.some((template) => {
      if (template.status === 'corrupted') return false;
      return evaluateTemplateCompatibility(template.descriptor, {
        profile,
        runtimePackageApi: 2,
        playerConfigApi: 2,
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
  parse(arguments_): CliCommandInvocation {
    if (arguments_.length > 0)
      throw new CliCommandUsageError('platform profiles does not accept arguments.');
    return {
      dryRun: true,
      mutation: false,
      async run(context) {
        const settings = exactPlatformSettings(context.snapshot.project);
        const rows = await profileRows(
          context.snapshot.project,
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
    const parsed = parseOptions(
      arguments_,
      ['--output', '--profile', '--template', '--config', '--signing-profile'],
      [
        '--check',
        '--force',
        '--sign',
        '--allow-untrusted-template',
        '--allow-identity-change',
        '--include-unused-assets',
        '--include-shader-sources',
      ],
    );
    const output = parsed.values['--output'];
    if (!output) throw new CliCommandUsageError("platform export requires '--output <path>'.");
    const template = parsed.values['--template'];
    if (template) internalToken(template);
    return {
      dryRun: parsed.flags.has('--check'),
      mutation: !parsed.flags.has('--check'),
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
            templateToken: template ? internalToken(template) : undefined,
            checkOnly: parsed.flags.has('--check'),
            force: parsed.flags.has('--force'),
            sign: signingRequested,
            allowUntrustedTemplate: parsed.flags.has('--allow-untrusted-template'),
            allowIdentityChange: parsed.flags.has('--allow-identity-change'),
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
          await context.workspace.writeEditorLocalState(
            context.snapshot.projectRoot,
            context.snapshot.workspaceRevision,
            editorState,
          );
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
