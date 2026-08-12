import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { invokeNovelTeaNativeOperation } from '../../shared/noveltea-cli-subprocess';
import { createNodeProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';
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
import {
  deriveProjectDisplayGeometry,
  projectSettingsFromProject,
} from '../../shared/project-schema/authoring-project-settings';
import { runtimeExportProfileForPlatform } from '../../shared/project-schema/authoring-export';
import {
  prepareRuntimeArtifact,
  verifyPreparedRuntimeArtifact,
  type PreparedRuntimeArtifact,
} from '../../shared/runtime-artifact-preparation';
import { stripEditorProjectState } from '../../shared/project-schema/editor-project-state';
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
  type TemplateResolveResult,
} from '../../shared/project-schema/platform-export-contracts';
import { evaluateTemplateCompatibility } from '../../shared/project-schema/template-compatibility';
import type { OpenProjectResponse, PackageExportResponse } from '../../shared/editor-tooling';
import type { ShaderCompileResponse } from '../../shared/editor-tooling';
import {
  nodeRuntimeArtifactPaths,
  nodeShaderCompilerAdapter,
} from './node-runtime-artifact-adapters';

async function openProjectForPlatformExport(projectPath: string): Promise<OpenProjectResponse> {
  const opened = await createNodeProjectWorkspaceService().open(projectPath);
  if (!opened.ok)
    return {
      ok: true,
      success: false,
      diagnostics: [...opened.diagnostics],
      projectPath: opened.projectRoot,
      projectFilePath: opened.manifestPath,
    } as unknown as OpenProjectResponse;
  return {
    ok: true,
    success: true,
    diagnostics: [...opened.diagnostics],
    contentProject: opened.contentProject,
    editorState: opened.editorState,
    projectPath: opened.snapshot.projectRoot,
    projectFilePath: opened.snapshot.manifestPath,
  } as unknown as OpenProjectResponse;
}

const defaultNativeTools = {
  compileShaders(
    shaderProject: unknown,
    options?: Parameters<typeof invokeNovelTeaNativeOperation>[1],
  ) {
    return invokeNovelTeaNativeOperation('compile-shaders', {
      shaderProject,
      options: options ?? {},
    });
  },
  exportPackage(project: unknown, outputPath: string, options?: unknown) {
    return invokeNovelTeaNativeOperation('export-package', {
      project,
      outputPath,
      options: options ?? {},
    });
  },
};

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

function plannedPlatformArtifactPaths(
  outputDirectory: string,
  profile: ReturnType<typeof parseProjectPlatformExportSettings>['profiles'][number],
): string[] {
  const output = path.resolve(outputDirectory);
  const paths = [output];
  if (profile.target === 'web' || profile.target === 'windows') paths.push(`${output}.zip`);
  if (profile.target === 'linux') {
    paths.push(`${output}.tar.gz`);
    if (profile.desktop.artifact === 'appimage') paths.push(`${output}.AppImage`);
  }
  if (profile.target === 'macos') {
    const base = output.replace(/\.app$/i, '');
    paths.push(`${base}.zip`, `${base}.dmg`, `${base}-signing-report.json`);
  }
  if (profile.includeDebugSymbols)
    paths.push(`${output}-symbols.${profile.target === 'linux' ? 'tar.gz' : 'zip'}`);
  return [...new Set(paths)];
}

async function publicationCollisions(
  outputDirectory: string,
  profile: ReturnType<typeof parseProjectPlatformExportSettings>['profiles'][number],
): Promise<{ collisions: string[]; symlinks: string[] }> {
  const collisions: string[] = [];
  const symlinks: string[] = [];
  for (const candidate of plannedPlatformArtifactPaths(outputDirectory, profile)) {
    try {
      const info = await lstat(candidate);
      collisions.push(candidate);
      if (info.isSymbolicLink()) symlinks.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { collisions, symlinks };
}

export async function exportProjectToPlatform(
  requestValue: ProjectPlatformExportRequest,
  onProgress: (event: PlatformExportProgressEvent) => void = () => undefined,
  nativeTools: Readonly<{
    compileShaders: typeof defaultNativeTools.compileShaders;
    exportPackage: typeof defaultNativeTools.exportPackage;
  }> = defaultNativeTools,
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
        ? await openProjectForPlatformExport(request.projectPath)
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

    const signingRequested = request.sign ?? false;
    const signing = request.localState?.signing;
    const signingConfigured =
      (profile.target === 'windows' && Boolean(signing?.windows)) ||
      (profile.target === 'macos' && Boolean(signing?.macos)) ||
      (profile.target === 'android' && Boolean(signing?.android));
    if (signingRequested && !signingConfigured) {
      return failure(operationId, [
        diagnostic(
          'platform-signing-required',
          '/sign',
          `${profile.target} export cannot apply signing without a configured signing profile.`,
        ),
      ]);
    }

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
    let artifact: PreparedRuntimeArtifact;
    if (request.preparedRuntimeArtifact) {
      progress('compiling-project', 'Verifying the prepared current-revision runtime artifact');
      const verified = verifyPreparedRuntimeArtifact(request.preparedRuntimeArtifact, {
        project,
        projectRoot,
        profile: targetRuntimeProfile,
        recoveryFingerprint: request.preparedRuntimeArtifact.recoveryFingerprint,
        paths: nodeRuntimeArtifactPaths,
      });
      if (verified.status === 'rejected')
        return failure(operationId, collectProjectValidationDiagnostics(verified.diagnostics));
      artifact = verified.verified.artifact;
      const blocking = artifact.diagnostics.filter(
        (item) => item.severity === 'error' && item.boundaries.includes('platform-export'),
      );
      if (blocking.length > 0)
        return failure(operationId, collectProjectValidationDiagnostics(blocking));
    } else {
      const prepared = await prepareRuntimeArtifact({
        project,
        projectRoot,
        profile: targetRuntimeProfile,
        intent: request.checkOnly ? 'platform-preflight' : 'platform-export',
        shaderCompiler: nodeShaderCompilerAdapter(
          (shaderProject, options) =>
            nativeTools.compileShaders(shaderProject, options) as Promise<ShaderCompileResponse>,
        ),
        paths: nodeRuntimeArtifactPaths,
        isCancelled: () => {
          try {
            checkPlatformExportCancelled(operationId);
            return false;
          } catch {
            return true;
          }
        },
        onStage: (stage) =>
          progress(
            stage,
            stage === 'compiling-project'
              ? 'Compiling the project artifact'
              : 'Compiling required shader variants',
          ),
      });
      if (prepared.status === 'cancelled') return cancelled(operationId);
      if (prepared.status === 'blocked')
        return failure(operationId, collectProjectValidationDiagnostics(prepared.diagnostics));
      artifact = prepared.artifact;
    }

    const localState = request.localState ?? {};
    let androidSigning:
      | { keystorePath: string; keyAlias: string; storePassword: string; keyPassword: string }
      | undefined;
    const localSigning = localState.signing;
    if (signingRequested && profile.target === 'android' && localSigning?.android) {
      try {
        androidSigning = {
          keystorePath: localSigning.android.keystorePath,
          keyAlias: localSigning.android.keyAlias,
          storePassword: resolveSigningSecret(
            localSigning.android.storePasswordReference,
            'Android keystore password',
          ),
          keyPassword: resolveSigningSecret(
            localSigning.android.keyPasswordReference,
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
    const templateRequirements = {
      profile,
      runtimePackageApi: 2,
      playerConfigApi: 2,
      shaderVariants: targetRuntimeProfile.shaderVariants,
      graphicsBackends: [],
      capabilities: profile.capabilityOverrides,
      requiredFeatures: [],
      host,
    };
    let resolved: TemplateResolveResult;
    if (request.templateToken) {
      const template = await verifyTemplateToken(request.templateToken);
      const compatibility = evaluateTemplateCompatibility(
        template.descriptor,
        templateRequirements,
      );
      if (!compatibility.compatible)
        return failure(
          operationId,
          compatibility.diagnostics.map((item) =>
            diagnostic(item.code, `/template${item.path}`, item.message),
          ),
        );
      resolved = {
        success: true,
        token: request.templateToken,
        template: {
          ...template,
          status: template.entry.trust === 'official' ? 'installed' : 'untrusted',
          compatibility,
        },
        diagnostics: [],
      };
    } else {
      resolved = await resolvePlayerTemplate({ requirements: templateRequirements });
    }
    if (!resolved.success || !resolved.token) {
      return failure(
        operationId,
        resolved.diagnostics.map((item) => diagnostic(item.code, item.path, item.message)),
      );
    }
    const verifiedTemplate = resolved.template ?? (await verifyTemplateToken(resolved.token));
    if (verifiedTemplate.entry.trust !== 'official' && !request.allowUntrustedTemplate) {
      return failure(operationId, [
        diagnostic(
          'template-untrusted-acknowledgement-required',
          '/template',
          `Template '${verifiedTemplate.descriptor.templateId}@${verifiedTemplate.descriptor.buildId}' is locally sourced; pass --allow-untrusted-template to use it.`,
        ),
      ]);
    }

    const publication = await publicationCollisions(request.outputDirectory, profile);
    if (publication.symlinks.length > 0) {
      return failure(operationId, [
        diagnostic(
          'platform-output-symlink-forbidden',
          '/outputDirectory',
          `Export refuses symbolic-link artifact paths: ${publication.symlinks.join(', ')}.`,
        ),
      ]);
    }
    if (publication.collisions.length > 0 && !request.force) {
      return failure(operationId, [
        diagnostic(
          'platform-output-exists',
          '/outputDirectory',
          `Export would replace existing artifacts; pass --force to continue: ${publication.collisions.join(', ')}.`,
        ),
      ]);
    }
    if (request.checkOnly) {
      return {
        ok: true,
        success: true,
        cancelled: false,
        operationId,
        signingRequested,
        signingApplied: false,
        templateToken: resolved.token.replace('/', '@'),
        outputDirectory: path.resolve(request.outputDirectory),
        diagnostics: resolved.diagnostics.map((item) =>
          createPlatformExportValidationDiagnostic({
            severity: 'warning',
            code: item.code,
            path: item.path,
            message: item.message,
          }),
        ),
      };
    }

    const packageRoot = await mkdtemp(path.join(os.tmpdir(), 'noveltea-platform-export-'));
    const packagePath = path.join(packageRoot, 'game.ntpkg');
    try {
      progress('writing-package', 'Writing game.ntpkg');
      checkPlatformExportCancelled(operationId);
      const packaged = (await nativeTools.exportPackage(artifact.compiledProject, packagePath, {
        ...artifact.packageOptions,
        shaderAssetRoot:
          (artifact.packageOptions.shaderVariants?.length ?? 0) > 0
            ? path.join(projectRoot, '.noveltea', 'build')
            : artifact.packageOptions.shaderAssetRoot,
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
      const runtimeDisplay = artifact.packageOptions.display;
      const accessibility = artifact.packageOptions.accessibility;
      const displayGeometry = runtimeDisplay
        ? deriveProjectDisplayGeometry(runtimeDisplay.reference_resolution)
        : null;
      if (!runtimeDisplay || !displayGeometry || !accessibility) {
        return failure(operationId, [
          diagnostic(
            'platform-export.runtime-settings.missing',
            !runtimeDisplay || !displayGeometry
              ? '/settings/display/referenceResolution'
              : '/settings/accessibility',
            !runtimeDisplay || !displayGeometry
              ? 'Compiled runtime export must publish a valid reference resolution.'
              : 'Compiled runtime export must publish accessibility policies.',
          ),
        ]);
      }
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
          sourceFingerprint: artifact.sourceFingerprint,
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
        display: { ...displayGeometry, barColor: runtimeDisplay.bar_color },
        runtimeDisplay: {
          referenceResolution: { ...runtimeDisplay.reference_resolution },
          worldRasterPolicy: runtimeDisplay.world_raster_policy,
          barColor: runtimeDisplay.bar_color,
        },
        accessibility: {
          uiScale: { ...accessibility.ui_scale },
          textScale: { ...accessibility.text_scale },
        },
        capabilities: profile.capabilityOverrides,
        runtimePackageApi: 2,
        host,
        windowsSigning:
          signingRequested && profile.target === 'windows' ? localSigning?.windows : undefined,
        macosSigning:
          signingRequested && profile.target === 'macos' && localSigning?.macos
            ? {
                identity: localSigning.macos.identity,
                entitlementsPath: localSigning.macos.entitlementsPath,
              }
            : undefined,
        macosNotarization:
          signingRequested && profile.target === 'macos' && localSigning?.macos?.notarizationCommand
            ? {
                command: localSigning.macos.notarizationCommand,
                args: localSigning.macos.notarizationArgs ?? [],
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
      return result.success
        ? {
            ...result,
            signingRequested,
            signingApplied: signingRequested,
          }
        : result;
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'NOVELTEA_EXPORT_CANCELLED')
      return cancelled(operationId);
    throw error;
  } finally {
    clearPlatformExportCancellation(operationId);
  }
}
