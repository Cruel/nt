import path from 'node:path';
import { rm } from 'node:fs/promises';
import { compileShaders, exportPackage, openProject } from './editor-tool-service';
import {
  checkPlatformExportCancelled,
  clearPlatformExportCancellation,
  stagePlatformExport,
} from './platform-staging-service';
import {
  resolvePlayerTemplate,
  templateRootForToken,
  verifyTemplateToken,
} from './template-registry-service';
import { exportAndroidPlatform } from './android-export-service';
import { resolveSigningSecret, signingFailure } from './export-signing-service';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import { parseAuthoringProject } from '../../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../../shared/project-schema/authoring-project-settings';
import { selectedExportProfile } from '../../shared/project-schema/authoring-export';
import {
  buildCompiledRuntimeExport,
  hasAuthoringShadersOrMaterials,
} from '../../shared/project-schema/compiled-runtime-export';
import { buildShaderMaterialProject } from '../../shared/project-schema/shader-material-project';
import { parseShaderData } from '../../shared/project-schema/authoring-shaders';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import {
  parseProjectPlatformExportSettings,
  type ProjectPlatformExportRequest,
  type PlatformExportProgressEvent,
  type PlatformStageDiagnostic,
  type PlatformStageResult,
} from '../../shared/project-schema/platform-export-contracts';
import type { OpenProjectResponse, PackageExportResponse } from '../../shared/editor-tooling';

function failure(operationId: string, diagnostics: PlatformStageDiagnostic[]): PlatformStageResult {
  return { ok: false, success: false, cancelled: false, operationId, diagnostics };
}

function diagnostic(code: string, pathValue: string, message: string): PlatformStageDiagnostic {
  return { severity: 'error', code, path: pathValue, message };
}

function cancelled(operationId: string): PlatformStageResult {
  return {
    ok: false,
    success: false,
    cancelled: true,
    operationId,
    diagnostics: [
      {
        severity: 'warning',
        code: 'export-cancelled',
        path: '/',
        message: 'Platform export was cancelled.',
      },
    ],
  };
}

function iconPath(project: ReturnType<typeof parseAuthoringProject>, projectRoot: string) {
  const icon = projectSettingsFromProject(project).app.icon;
  if (!icon) return undefined;
  const data = parseAssetData(project.assets[icon.$ref.id]?.data);
  return data ? path.join(projectRoot, data.source.path) : undefined;
}

export async function exportProjectToPlatform(
  request: ProjectPlatformExportRequest,
  onProgress: (event: PlatformExportProgressEvent) => void = () => undefined,
): Promise<PlatformStageResult> {
  const operationId = request.operationId ?? `cli-${Date.now()}`;
  const progress = (stage: PlatformExportProgressEvent['stage'], message: string) =>
    onProgress({ operationId, stage, message });
  try {
    checkPlatformExportCancelled(operationId);
    progress('validating', 'Validating project and export profile');
    const loaded = request.project
      ? ({
          success: true,
          project: request.project,
          projectPath: request.projectRoot ?? '',
        } as OpenProjectResponse)
      : request.projectPath
        ? ((await openProject(request.projectPath)) as unknown as OpenProjectResponse)
        : null;
    if (!loaded?.success || !loaded.project || !loaded.projectPath) {
      return failure(
        operationId,
        (loaded?.diagnostics ?? [])
          .map((item) => diagnostic('project-load-failed', item.path ?? '/', item.message))
          .concat(
            loaded
              ? []
              : [
                  diagnostic(
                    'project-load-failed',
                    '/projectPath',
                    'A project path or in-memory project with projectRoot is required.',
                  ),
                ],
          ),
      );
    }

    let project;
    try {
      project = parseAuthoringProject(loaded.project);
    } catch (error) {
      return failure(operationId, [
        diagnostic('invalid-project', '/', error instanceof Error ? error.message : String(error)),
      ]);
    }

    const projectRoot = loaded.projectPath;
    const profiles = parseProjectPlatformExportSettings(
      (project.settings as Record<string, unknown>).platformExport,
    );
    const profile = profiles.profiles.find((item) => item.id === request.profileId);
    if (!profile)
      return failure(operationId, [
        diagnostic(
          'profile-missing',
          '/profileId',
          `Platform export profile '${request.profileId}' does not exist.`,
        ),
      ]);

    const validation = validateAuthoringProject(project);
    const validationErrors = validation.filter((item) => item.severity === 'error');
    if (validationErrors.length > 0) {
      return failure(
        operationId,
        validationErrors.map((item) =>
          diagnostic('project-validation-failed', item.path, item.message),
        ),
      );
    }

    const runtimeProfile = selectedExportProfile(project);
    const targetShaderVariants =
      profile.target === 'android' || profile.target === 'web'
        ? runtimeProfile.shaderVariants.filter((variant) => variant === 'essl-300')
        : runtimeProfile.shaderVariants;
    const targetRuntimeProfile = {
      ...runtimeProfile,
      shaderVariants: targetShaderVariants.length
        ? targetShaderVariants
        : profile.target === 'android' || profile.target === 'web'
          ? ['essl-300' as const]
          : runtimeProfile.shaderVariants,
    };
    const resolvedIconPath = iconPath(project, projectRoot);
    if (!resolvedIconPath) {
      return failure(operationId, [
        diagnostic(
          'icon-missing',
          '/settings/app/icon',
          'A valid project icon is required for playable platform export.',
        ),
      ]);
    }
    let exportProject = project;
    if (
      targetRuntimeProfile.compileShadersBeforeExport &&
      hasAuthoringShadersOrMaterials(project)
    ) {
      checkPlatformExportCancelled(operationId);
      progress('compiling-shaders', 'Compiling required shader variants');
      const shaderProject = buildShaderMaterialProject(project);
      const response = (await compileShaders(shaderProject.project, {
        shaderc: request.localState?.shaderc,
        bgfxShaderIncludeDir: request.localState?.bgfxShaderIncludeDir,
        projectRoot,
        outputRoot: path.join(projectRoot, '.noveltea', 'build'),
        cacheRoot: path.join(projectRoot, '.noveltea', 'cache'),
        shaderVariants: targetRuntimeProfile.shaderVariants,
      })) as {
        success?: boolean;
        diagnostics?: Array<{ severity: string; message: string; path?: string }>;
        outputs?: Array<{ shader: string; stage: string; variant: string; runtimePath: string }>;
      };
      if (!response.success || response.diagnostics?.some((item) => item.severity === 'error')) {
        return failure(
          operationId,
          (response.diagnostics ?? []).map((item) =>
            diagnostic('shader-compilation-failed', item.path ?? '/shaders', item.message),
          ),
        );
      }
      exportProject = structuredClone(project);
      for (const output of response.outputs ?? []) {
        const record = exportProject.shaders[output.shader];
        const shader = parseShaderData(record?.data);
        if (!record || !shader) continue;
        const stage = shader.stages.find((item) => item.stage === output.stage);
        if (!stage) continue;
        stage.compiled = { ...(stage.compiled ?? {}), [output.variant]: output.runtimePath };
        record.data = shader;
      }
    }
    progress('compiling-project', 'Compiling the project artifact');
    checkPlatformExportCancelled(operationId);
    const built = buildCompiledRuntimeExport(exportProject, {
      projectRoot,
      profile: targetRuntimeProfile,
    });
    if (!built.ok || !built.compiledProject) {
      return failure(
        operationId,
        built.diagnostics.map((item) =>
          diagnostic(item.category ?? 'runtime-conversion-failed', item.path, item.message),
        ),
      );
    }

    const localState = request.localState ?? {};
    let androidSigning:
      | { keystorePath: string; keyAlias: string; storePassword: string; keyPassword: string }
      | undefined;
    const signing = localState.signing;
    if (profile.target === 'android' && signing?.android) {
      try {
        androidSigning = {
          keystorePath: signing.android.keystorePath,
          keyAlias: signing.android.keyAlias,
          storePassword: resolveSigningSecret(
            signing.android.storePasswordReference,
            'Android keystore password',
          ),
          keyPassword: resolveSigningSecret(
            signing.android.keyPasswordReference,
            'Android key password',
          ),
        };
      } catch (error) {
        return failure(operationId, [
          signingFailure(
            'android-signing-configuration-invalid',
            error instanceof Error ? error.message : String(error),
          ),
        ]);
      }
    }
    const availableTools = [
      localState.androidSdk && 'android-sdk',
      localState.androidNdk && 'android-ndk',
      localState.javaHome && 'java',
      localState.cmake && 'cmake',
    ].filter((item): item is string => Boolean(item));
    const host = {
      platform:
        process.platform === 'win32'
          ? ('windows' as const)
          : process.platform === 'darwin'
            ? ('macos' as const)
            : ('linux' as const),
      availableTools,
    };
    progress('resolving-template', 'Resolving and verifying the player template');
    checkPlatformExportCancelled(operationId);
    const resolved = request.templateToken
      ? { success: true, token: request.templateToken, diagnostics: [] }
      : await resolvePlayerTemplate({
          requirements: {
            profile,
            runtimePackageApi: 1,
            playerConfigApi: 1,
            shaderVariants: targetRuntimeProfile.shaderVariants,
            graphicsBackends: [],
            capabilities: profile.capabilityOverrides,
            requiredFeatures: [],
            host,
          },
        });
    if (!resolved.success || !resolved.token) {
      return failure(
        operationId,
        resolved.diagnostics.map((item) => diagnostic(item.code, item.path, item.message)),
      );
    }
    const verifiedTemplate = resolved.template ?? (await verifyTemplateToken(resolved.token));

    const packagePath = `${path.resolve(request.outputDirectory)}.game.ntpkg`;
    try {
      progress('writing-package', 'Writing game.ntpkg');
      checkPlatformExportCancelled(operationId);
      const packaged = (await exportPackage(built.compiledProject, packagePath, {
        ...built.packageOptions,
        shaderAssetRoot:
          (built.packageOptions.shaderVariants?.length ?? 0) > 0
            ? path.join(projectRoot, '.noveltea', 'build')
            : built.packageOptions.shaderAssetRoot,
      })) as PackageExportResponse;
      if (!packaged.success) {
        return failure(
          operationId,
          (packaged.diagnostics ?? []).map((item) =>
            diagnostic(item.category ?? 'runtime-package-failed', item.path, item.message),
          ),
        );
      }

      const settings = projectSettingsFromProject(project);
      progress('generating-metadata', 'Generating icons and platform metadata');
      checkPlatformExportCancelled(operationId);
      progress('staging', 'Staging player, package, assets, and dependencies');
      const stageRequest = {
        operationId,
        profile,
        templateToken: resolved.token,
        outputDirectory: path.resolve(request.outputDirectory),
        packagePath,
        iconSourcePath: resolvedIconPath,
        runtimePackageReadiness: { validated: true, blockingDiagnosticCount: 0 },
        identity: {
          displayName: settings.app.displayName,
          shortName: settings.app.shortName,
          applicationId: settings.app.android.applicationId ?? settings.app.applicationId,
          saveNamespace: settings.app.saveNamespace,
          versionName: settings.app.versionName,
          defaultLocale: settings.app.defaultLocale,
          themeColor: settings.app.themeColor,
          backgroundColor: settings.app.launchBackgroundColor,
          webManifestId: settings.app.web.manifestId,
          linuxDesktopId: settings.app.desktop.linuxDesktopId,
          androidVersionCode: settings.app.android.versionCode ?? settings.app.buildNumber,
          androidAllowBackup: settings.app.android.allowBackup,
          androidIsGame: settings.app.android.isGame,
          localized: settings.app.localized,
        },
        display: settings.display,
        capabilities: profile.capabilityOverrides,
        runtimePackageApi: 1,
        host,
        windowsSigning: profile.target === 'windows' ? signing?.windows : undefined,
        macosSigning:
          profile.target === 'macos' && signing?.macos
            ? { identity: signing.macos.identity, entitlementsPath: signing.macos.entitlementsPath }
            : undefined,
        macosNotarization:
          profile.target === 'macos' && signing?.macos?.notarizationCommand
            ? {
                command: signing.macos.notarizationCommand,
                args: signing.macos.notarizationArgs ?? [],
              }
            : undefined,
        androidToolchain: request.localState,
        androidSigning,
      } satisfies Parameters<typeof stagePlatformExport>[0];
      const result =
        profile.target === 'android'
          ? await exportAndroidPlatform(
              stageRequest,
              verifiedTemplate.descriptor,
              templateRootForToken(resolved.token),
            )
          : await stagePlatformExport(stageRequest);
      progress('finalizing', 'Finalizing platform artifacts');
      progress('verifying', 'Verifying generated artifacts and manifests');
      return result;
    } finally {
      await rm(packagePath, { force: true });
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'NOVELTEA_EXPORT_CANCELLED')
      return cancelled(operationId);
    throw error;
  } finally {
    clearPlatformExportCancellation(operationId);
  }
}
