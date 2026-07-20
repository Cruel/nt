import type { CompiledRuntimeExportBuildResult } from '../../shared/project-schema/compiled-runtime-export';
import type { LastSuccessfulPlatformExportIdentity } from '../../shared/project-schema/editor-project-state';
import { applicationIdPattern } from '../../shared/project-schema/authoring-project-settings';
import type { PlatformExportProfile } from '../../shared/project-schema/platform-export-contracts';
import {
  collectProjectValidationDiagnostics,
  createPlatformExportValidationDiagnostic,
  projectValidationBlocksBoundary,
  type ProjectValidationDiagnostic,
} from '../../shared/project-schema/project-validation';

export interface PlatformExportCommonIdentity {
  displayName: string;
  applicationId: string;
  saveNamespace: string;
  versionName: string;
  iconSourcePath?: string;
  diagnostics?: readonly ProjectValidationDiagnostic[];
}

export interface PlatformExportTargetMetadata {
  diagnostics?: readonly ProjectValidationDiagnostic[];
}

export interface PlatformExportTemplateState {
  templateToken?: string;
  diagnostics?: readonly ProjectValidationDiagnostic[];
}

export interface PlatformExportToolchainState {
  androidSdk?: string;
  androidNdk?: string;
  javaHome?: string;
  cmake?: string;
  diagnostics?: readonly ProjectValidationDiagnostic[];
}

export interface PlatformExportSigningState {
  windows?: unknown;
  macos?: unknown;
  android?: unknown;
  diagnostics?: readonly ProjectValidationDiagnostic[];
}

export interface PlatformExportReadinessGroups {
  runtimePackage: ProjectValidationDiagnostic[];
  commonIdentity: ProjectValidationDiagnostic[];
  targetMetadata: ProjectValidationDiagnostic[];
  environment: ProjectValidationDiagnostic[];
}

export interface PlatformExportReadinessResult {
  ok: boolean;
  readinessFingerprint: string;
  groups: PlatformExportReadinessGroups;
  diagnostics: ProjectValidationDiagnostic[];
  blockers: ProjectValidationDiagnostic[];
  identityChangeDiagnostics: ProjectValidationDiagnostic[];
  requiresIdentityConfirmation: boolean;
}

export interface EvaluatePlatformExportReadinessOptions {
  runtimeExport: CompiledRuntimeExportBuildResult;
  commonIdentity: PlatformExportCommonIdentity;
  profile: PlatformExportProfile;
  targetMetadata?: PlatformExportTargetMetadata;
  templateState?: PlatformExportTemplateState;
  toolchainState?: PlatformExportToolchainState;
  signingState?: PlatformExportSigningState;
  outputDirectory?: string;
  lastSuccessfulIdentity?: LastSuccessfulPlatformExportIdentity;
}

function diagnostic(
  code: string,
  path: string,
  message: string,
  ownerPaths: readonly string[] = [path],
  severity: ProjectValidationDiagnostic['severity'] = 'error',
): ProjectValidationDiagnostic {
  return createPlatformExportValidationDiagnostic({
    code,
    severity,
    category: 'Platform export readiness',
    path,
    message,
    ownerPaths,
  });
}

function platformOnlyDiagnostics(
  diagnostics: readonly ProjectValidationDiagnostic[],
): ProjectValidationDiagnostic[] {
  return diagnostics.filter(
    (item) =>
      item.boundaries.includes('platform-export') && !item.boundaries.includes('runtime-package'),
  );
}

function isTargetPath(path: string, target: PlatformExportProfile['target']): boolean {
  if (path.startsWith('/settings/platformExport')) return true;
  if (target === 'android') return path.startsWith('/settings/app/android');
  if (target === 'web') return path.startsWith('/settings/app/web');
  return path.startsWith('/settings/app/desktop');
}

function isAnyTargetPath(path: string): boolean {
  return (
    path.startsWith('/settings/app/desktop') ||
    path.startsWith('/settings/app/web') ||
    path.startsWith('/settings/app/android')
  );
}

function identityChangeDiagnostics(
  current: PlatformExportCommonIdentity,
  previous: LastSuccessfulPlatformExportIdentity | undefined,
): ProjectValidationDiagnostic[] {
  if (!previous) return [];
  const diagnostics: ProjectValidationDiagnostic[] = [];
  if (previous.applicationId !== current.applicationId) {
    diagnostics.push(
      diagnostic(
        'authoring.settings.app.application-id.changed-after-export',
        '/settings/app/applicationId',
        `Application ID changed after export from '${previous.applicationId}'; installed-app identity will change.`,
        ['/settings/app/applicationId'],
        'warning',
      ),
    );
  }
  if (previous.saveNamespace !== current.saveNamespace) {
    diagnostics.push(
      diagnostic(
        'authoring.settings.app.save-namespace.changed-after-export',
        '/settings/app/saveNamespace',
        `Save namespace changed after export from '${previous.saveNamespace}'; existing save data will not move automatically.`,
        ['/settings/app/saveNamespace'],
        'warning',
      ),
    );
  }
  return diagnostics;
}

function commonOperationDiagnostics(identity: PlatformExportCommonIdentity) {
  const diagnostics: ProjectValidationDiagnostic[] = [];
  if (!identity.displayName.trim()) {
    diagnostics.push(
      diagnostic(
        'platform-export.identity.display-name.required',
        '/settings/app/displayName',
        'Application display name is required for platform export.',
        ['/settings/app/displayName'],
      ),
    );
  }
  if (!applicationIdPattern.test(identity.applicationId)) {
    diagnostics.push(
      diagnostic(
        'platform-export.identity.application-id.invalid',
        '/settings/app/applicationId',
        'Application ID must be a stable reverse-DNS identifier.',
        ['/settings/app/applicationId'],
      ),
    );
  }
  if (!identity.saveNamespace.trim()) {
    diagnostics.push(
      diagnostic(
        'platform-export.identity.save-namespace.required',
        '/settings/app/saveNamespace',
        'Save namespace is required for platform export.',
        ['/settings/app/saveNamespace'],
      ),
    );
  }
  if (!identity.versionName.trim()) {
    diagnostics.push(
      diagnostic(
        'platform-export.identity.version-name.required',
        '/settings/app/versionName',
        'Application version name is required for platform export.',
        ['/settings/app/versionName'],
      ),
    );
  }
  if (!identity.iconSourcePath) {
    diagnostics.push(
      diagnostic(
        'platform-export.identity.icon.missing',
        '/settings/app/icon',
        'A valid project icon is required for playable platform export.',
        ['/settings/app/icon'],
      ),
    );
  }
  return diagnostics;
}

function environmentDiagnostics(options: EvaluatePlatformExportReadinessOptions) {
  const diagnostics: ProjectValidationDiagnostic[] = [];
  if (!options.outputDirectory?.trim()) {
    diagnostics.push(
      diagnostic(
        'platform-export.output-directory.required',
        '/export/outputDirectory',
        'Choose an output directory before exporting.',
        ['/export/outputDirectory'],
      ),
    );
  }
  if (!options.templateState?.templateToken) {
    diagnostics.push(
      diagnostic(
        'platform-export.template.required',
        '/export/template',
        'A compatible installed player template is required.',
        ['/export/template'],
      ),
    );
  }
  if (options.profile.target === 'android') {
    const requiredTools: Array<[keyof PlatformExportToolchainState, string]> = [
      ['androidSdk', 'Android SDK'],
      ['androidNdk', 'Android NDK'],
      ['javaHome', 'Java'],
      ['cmake', 'CMake'],
    ];
    for (const [field, label] of requiredTools) {
      if (!options.toolchainState?.[field]) {
        diagnostics.push(
          diagnostic(
            `platform-export.toolchain.${field}.required`,
            `/editor/export/toolchains/${field}`,
            `${label} is required for Android export.`,
            [`/editor/export/toolchains/${field}`],
          ),
        );
      }
    }
  }
  if (options.profile.signingProfileId) {
    const signing = options.signingState;
    const configured =
      options.profile.target === 'windows'
        ? signing?.windows
        : options.profile.target === 'macos'
          ? signing?.macos
          : options.profile.target === 'android'
            ? signing?.android
            : true;
    if (!configured) {
      diagnostics.push(
        diagnostic(
          'platform-export.signing.configuration.required',
          `/editor/export/signing/${options.profile.target}`,
          `The selected ${options.profile.target} signing profile is not configured.`,
          [`/editor/export/signing/${options.profile.target}`],
        ),
      );
    }
  }
  return diagnostics;
}

export function evaluatePlatformExportReadiness(
  options: EvaluatePlatformExportReadinessOptions,
): PlatformExportReadinessResult {
  const platformDiagnostics = platformOnlyDiagnostics(options.runtimeExport.diagnostics);
  const targetDiagnostics = platformDiagnostics.filter((item) =>
    isTargetPath(item.path, options.profile.target),
  );
  const commonProjectDiagnostics = platformDiagnostics.filter(
    (item) => !isTargetPath(item.path, options.profile.target) && !isAnyTargetPath(item.path),
  );
  const changedIdentity = identityChangeDiagnostics(
    options.commonIdentity,
    options.lastSuccessfulIdentity,
  );
  const groups: PlatformExportReadinessGroups = {
    runtimePackage: collectProjectValidationDiagnostics(options.runtimeExport.runtimeDiagnostics),
    commonIdentity: collectProjectValidationDiagnostics(
      commonProjectDiagnostics,
      options.commonIdentity.diagnostics ?? [],
      commonOperationDiagnostics(options.commonIdentity),
      changedIdentity,
    ),
    targetMetadata: collectProjectValidationDiagnostics(
      targetDiagnostics,
      options.targetMetadata?.diagnostics ?? [],
    ),
    environment: collectProjectValidationDiagnostics(
      options.templateState?.diagnostics ?? [],
      options.toolchainState?.diagnostics ?? [],
      options.signingState?.diagnostics ?? [],
      environmentDiagnostics(options),
    ),
  };
  const diagnostics = collectProjectValidationDiagnostics(
    groups.runtimePackage,
    groups.commonIdentity,
    groups.targetMetadata,
    groups.environment,
  );
  const blockers = diagnostics.filter((item) =>
    projectValidationBlocksBoundary(item, 'platform-export'),
  );
  return {
    ok: blockers.length === 0,
    readinessFingerprint: options.runtimeExport.sourceFingerprint,
    groups,
    diagnostics,
    blockers,
    identityChangeDiagnostics: changedIdentity,
    requiresIdentityConfirmation: changedIdentity.length > 0,
  };
}
