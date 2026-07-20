import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
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
import { runtimeExportProfileForPlatform } from '../../shared/project-schema/authoring-export';
import {
  buildCompiledRuntimeExport,
  compiledRuntimeExportSourceFingerprint,
  hasAuthoringShadersOrMaterials,
  stableStringify,
} from '../../shared/project-schema/compiled-runtime-export';
import { stripEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { buildShaderMaterialProject } from '../../shared/project-schema/shader-material-project';
import { parseShaderData } from '../../shared/project-schema/authoring-shaders';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import {
  classifyProjectValidationDiagnostics,
  collectProjectValidationDiagnostics,
  createPlatformExportValidationDiagnostic,
} from '../../shared/project-schema/project-validation';
import {
  parseProjectPlatformExportSettings,
  parseProjectPlatformExportRequest,
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
  return createPlatformExportValidationDiagnostic({
    severity: 'error',
    code,
    path: pathValue,
    message,
  });
}

function cancelled(operationId: string): PlatformStageResult {
  return {
    ok: false,
    success: false,
    cancelled: true,
    operationId,
    diagnostics: [
      createPlatformExportValidationDiagnostic({
        severity: 'warning',
        code: 'export-cancelled',
        path: '/',
        message: 'Platform export was cancelled.',
      }),
    ],
  };
}

function iconPath(project: ReturnType<typeof parseAuthoringProject>, projectRoot: string) {
  const icon = projectSettingsFromProject(project).app.icon;
  if (!icon) return undefined;
  const data = parseAssetData(project.assets[icon.$ref.id]?.data);
  return data ? path.join(projectRoot, data.source.path) : undefined;
}

function isAnyTargetMetadataPath(pathValue: string) {
  return (
    pathValue.startsWith('/settings/app/desktop') ||
    pathValue.startsWith('/settings/app/web') ||
    pathValue.startsWith('/settings/app/android')
  );
}

function isSelectedTargetMetadataPath(
  pathValue: string,
  target: 'windows' | 'linux' | 'macos' | 'web' | 'android',
) {
  if (target === 'android') return pathValue.startsWith('/settings/app/android');
  if (target === 'web') return pathValue.startsWith('/settings/app/web');
  return pathValue.startsWith('/settings/app/desktop');
}

export async function exportProjectToPlatform(
  requestValue: ProjectPlatformExportRequest,
  onProgress: (event: PlatformExportProgressEvent) => void = () => undefined,
): Promise<PlatformStageResult> {
  let request: ProjectPlatformExportRequest;
  try {
    request = parseProjectPlatformExportRequest(requestValue);
  } catch (error) {
    const operationId = requestValue?.operationId ?? `invalid-${Date.now()}`;
    return failure(operationId, [
      diagnostic(
        'platform-export-request-invalid',
        '/request',
        error instanceof Error ? error.message : 'Platform export request is invalid.',
      ),
    ]);
  }
  const operationId = request.operationId ?? `cli-${Date.now()}`;
  const progress = (stage: PlatformExportProgressEvent['stage'], message: string) =>
    onProgress({ operationId, stage, message });
  try {
    checkPlatformExportCancelled(operationId);
    progress('validating', 'Validating project and export profile');
    const loaded = request.project
      ? ({
          success: true,
          contentProject: request.project,
          projectPath: request.projectRoot ?? '',
        } as OpenProjectResponse)
      : request.projectPath
        ? ((await openProject(request.projectPath)) as unknown as OpenProjectResponse)
        : null;
    if (!loaded?.success || !loaded.contentProject || !loaded.projectPath) {
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
      project = parseAuthoringProject({
        ...(stripEditorProjectState(loaded.contentProject) as Record<string, unknown>),
        ...(loaded.editorState ? { editor: loaded.editorState } : {}),
      });
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
    const validationErrors = validation.filter(
      (item) =>
        item.severity === 'error' &&
        (!isAnyTargetMetadataPath(item.path) ||
          isSelectedTargetMetadataPath(item.path, profile.target)),
    );
    if (validationErrors.length > 0) {
      return failure(operationId, collectProjectValidationDiagnostics(validationErrors));
    }

    const targetRuntimeProfile = runtimeExportProfileForPlatform(project, profile.target);
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
    let built;
    if (request.preparedRuntimeExport) {
      progress('compiling-project', 'Verifying the prepared current-revision runtime artifact');
      const prepared = request.preparedRuntimeExport;
      if (stableStringify(prepared.profile) !== stableStringify(targetRuntimeProfile)) {
        return failure(operationId, [
          diagnostic(
            'runtime-package-profile-mismatch',
            '/preparedRuntimeExport/profile',
            'The prepared runtime package profile does not match the selected platform target.',
          ),
        ]);
      }
      const expectedFingerprint = compiledRuntimeExportSourceFingerprint(
        project,
        prepared.profile,
        prepared.recoveryFingerprint ?? null,
      );
      if (prepared.sourceFingerprint !== expectedFingerprint) {
        return failure(operationId, [
          createPlatformExportValidationDiagnostic({
            severity: 'error',
            code: 'runtime-package-fingerprint-stale',
            category: 'Runtime package readiness',
            path: '/preparedRuntimeExport/sourceFingerprint',
            message:
              'The prepared runtime package belongs to an older or different project revision.',
            ownerPaths: ['/project', '/preparedRuntimeExport/sourceFingerprint'],
          }),
        ]);
      }
      const blocking = prepared.diagnostics.filter(
        (item) => item.severity === 'error' && item.boundaries.includes('platform-export'),
      );
      if (blocking.length > 0) {
        return failure(operationId, collectProjectValidationDiagnostics(blocking));
      }
      built = {
        ok: true,
        compiledProject: prepared.compiledProject,
        packageOptions: prepared.packageOptions,
        sourceFingerprint: prepared.sourceFingerprint,
        diagnostics: prepared.diagnostics,
      };
    } else {
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
          diagnostics?: Array<{
            severity: 'info' | 'warning' | 'error';
            code?: string;
            message: string;
            path?: string;
          }>;
          outputs?: Array<{ shader: string; stage: string; variant: string; runtimePath: string }>;
        };
        if (!response.success || response.diagnostics?.some((item) => item.severity === 'error')) {
          const shaderDiagnostics = classifyProjectValidationDiagnostics(
            (response.diagnostics ?? []).map((item) => ({
              ...item,
              path: item.path ?? '/shaders',
              category: 'shader',
            })),
            { producer: 'shader-compile' },
          );
          return failure(operationId, collectProjectValidationDiagnostics(shaderDiagnostics));
        }
        exportProject = structuredClone(project);
        for (const output of response.outputs ?? []) {
          const record = exportProject.shaders[output.shader];
          const shader = parseShaderData(record?.data);
          if (!record || !shader) continue;
          const stage = shader.stages.find((item) => item.stage === output.stage);
          if (!stage) continue;
          stage.compiled = { ...stage.compiled, [output.variant]: output.runtimePath };
          record.data = shader;
        }
      }
      progress('compiling-project', 'Compiling the project artifact');
      checkPlatformExportCancelled(operationId);
      built = buildCompiledRuntimeExport(exportProject, {
        projectRoot,
        profile: targetRuntimeProfile,
      });
      if (!built.ok || !built.compiledProject) {
        return failure(operationId, collectProjectValidationDiagnostics(built.diagnostics));
      }
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
        const signingDiagnostic = signingFailure(
          'android-signing-configuration-invalid',
          error instanceof Error ? error.message : String(error),
        );
        return failure(operationId, [createPlatformExportValidationDiagnostic(signingDiagnostic)]);
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
        const packageDiagnostics = classifyProjectValidationDiagnostics(
          packaged.diagnostics ?? [],
          { producer: 'package-publication' },
        );
        return failure(operationId, collectProjectValidationDiagnostics(packageDiagnostics));
      }
      const packageSha256 = createHash('sha256')
        .update(await readFile(packagePath))
        .digest('hex');

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
        runtimePackageEvidence: {
          sourceFingerprint: built.sourceFingerprint,
          packageSha256,
        },
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
