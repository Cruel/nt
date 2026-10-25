import type { ParsedGlobalArguments } from './bootstrap';
import { novelTeaCliUsageFailure } from './bootstrap';
import { cliDiagnostic, formatCliResult, NOVELTEA_CLI_EXIT_CODES } from './contracts';
import { nativeProjectRoot, type NativeProjectCommandCall } from './native-project-lifecycle-cli';
import { nativeProjectDiagnostics } from './native-project-results';
import { profileRows } from './platform-profile-rows';
import type { NovelTeaCliPlatformToolService } from './platform-tool-service';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import type { CliScopedReadAuthority } from './cli-options';
import type { AuthoringProject } from '../shared/project-schema/authoring-project';

/** Native-only scoped read: unrelated invalid records do not block profile enumeration. */
export async function runNativeProjectProfilesCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
  platformTools: NovelTeaCliPlatformToolService,
  fileSystem?: ProjectWorkspaceFileSystem,
  scopedAuthority?: CliScopedReadAuthority,
) {
  if (globals.command[0] !== 'platform' || globals.command[1] !== 'profiles') return null;
  if (globals.command.length !== 2)
    return novelTeaCliUsageFailure('platform profiles does not accept arguments.', globals.json);
  const root = await nativeProjectRoot(cwd, globals.project, fileSystem);
  if (!root)
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
        diagnostics: [
          cliDiagnostic(
            'WORKSPACE_NOT_FOUND',
            '/project.yaml',
            'No NovelTea project.yaml was found from the current directory upward.',
          ),
        ],
      },
      globals.json,
    );
  const requirements = ['/project', '/export'];
  const token = await scopedAuthority?.captureScopedReadAuthority(root, requirements);
  let response: Awaited<ReturnType<NativeProjectCommandCall>>;
  try {
    response = await native({ action: 'platform-profiles-preparation', projectRoot: root });
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const diagnostics = nativeProjectDiagnostics({ cliDiagnostics: response.diagnostics });
  if (!response.ok) {
    const message = response.error ?? 'Native platform profile preparation failed.';
    return formatCliResult(
      {
        success: false,
        exitCode: diagnostics.some((diagnostic) => diagnostic.code.startsWith('WORKSPACE_'))
          ? NOVELTEA_CLI_EXIT_CODES.workspace
          : NOVELTEA_CLI_EXIT_CODES.semantic,
        diagnostics: diagnostics.length
          ? diagnostics
          : [cliDiagnostic('WORKSPACE_SOURCE_READ', '/project.yaml', message)],
        projectRoot: root,
      },
      globals.json,
      { failure: message },
    );
  }
  if (!response.exportSettings || typeof response.exportSettings !== 'object')
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
        diagnostics: [
          cliDiagnostic(
            'WORKSPACE_SOURCE_READ',
            '/export',
            'Native Project preparation omitted export settings.',
          ),
        ],
        projectRoot: root,
      },
      globals.json,
    );
  const exportSettings = response.exportSettings as AuthoringProject['export'];
  const profiles = await profileRows(
    { export: exportSettings },
    exportSettings.profiles,
    await platformTools.listTemplates(),
  );
  if (
    token &&
    (token.relevantDeltaPaths.length > 0 ||
      !(await scopedAuthority!.verifyScopedReadAuthority(token)))
  )
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
        diagnostics: [
          cliDiagnostic(
            'WORKSPACE_REVISION_CONFLICT',
            '/',
            'Project authority changed during native profile enumeration.',
          ),
        ],
        projectRoot: root,
      },
      globals.json,
    );
  const humanSuccess =
    profiles.length === 0
      ? 'No platform export profiles are configured. Create one in the editor.'
      : profiles
          .map(
            (profile) =>
              `${profile.id}  ${profile.label}  ${profile.target}/${profile.architecture}  ${profile.artifact}`,
          )
          .join('\n');
  return formatCliResult(
    {
      success: true,
      exitCode: NOVELTEA_CLI_EXIT_CODES.success,
      diagnostics,
      projectRoot: root,
      profiles,
    },
    globals.json,
    { success: humanSuccess },
  );
}
