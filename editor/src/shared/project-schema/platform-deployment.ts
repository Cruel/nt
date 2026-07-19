import type {
  PlatformCapabilityMetadata,
  PlatformDeploymentModel,
  PlatformStageDiagnostic,
  PlatformStageRequest,
  TemplateDescriptor,
} from './platform-export-contracts';
import { applicationIdPattern } from './authoring-project-settings';
import { evaluateTemplateCompatibility } from './template-compatibility';

const mapping: Record<string, Partial<PlatformCapabilityMetadata>> = {
  'network.client': {
    androidPermissions: ['android.permission.INTERNET'],
    webRequirements: ['network'],
  },
  'external-url': {
    androidPermissions: ['android.permission.INTERNET'],
    webRequirements: ['external-navigation'],
  },
  'clipboard.read': { webRequirements: ['clipboard-read'], desktopFeatures: ['clipboard'] },
  'clipboard.write': { webRequirements: ['clipboard-write'], desktopFeatures: ['clipboard'] },
  gamepad: {
    androidFeatures: ['android.hardware.gamepad'],
    webRequirements: ['gamepad'],
    desktopFeatures: ['gamepad'],
  },
  vibration: { androidPermissions: ['android.permission.VIBRATE'], webRequirements: ['vibration'] },
  microphone: {
    androidPermissions: ['android.permission.RECORD_AUDIO'],
    androidFeatures: ['android.hardware.microphone'],
    webRequirements: ['microphone'],
  },
  notifications: {
    androidPermissions: ['android.permission.POST_NOTIFICATIONS'],
    webRequirements: ['notifications'],
  },
  'custom-url-scheme': {
    webRequirements: ['custom-url-scheme'],
    desktopFeatures: ['custom-url-scheme'],
  },
  billing: { androidPermissions: ['com.android.vending.BILLING'], desktopFeatures: ['billing'] },
};
const sorted = (values: string[]) => [...new Set(values)].sort();
export function capabilityMetadata(capabilities: string[]): PlatformCapabilityMetadata {
  const result: PlatformCapabilityMetadata = {
    androidPermissions: [],
    androidFeatures: [],
    webRequirements: [],
    desktopFeatures: [],
  };
  for (const capability of capabilities)
    for (const key of Object.keys(result) as Array<keyof PlatformCapabilityMetadata>)
      result[key].push(...(mapping[capability]?.[key] ?? []));
  for (const key of Object.keys(result) as Array<keyof PlatformCapabilityMetadata>)
    result[key] = sorted(result[key]);
  return result;
}

export function buildPlatformDeployment(
  request: PlatformStageRequest,
  descriptor: TemplateDescriptor,
): { model?: PlatformDeploymentModel; diagnostics: PlatformStageDiagnostic[] } {
  const diagnostics: PlatformStageDiagnostic[] = [];
  const error = (code: string, path: string, message: string) =>
    diagnostics.push({ severity: 'error' as const, code, path, message });
  if (!applicationIdPattern.test(request.identity.applicationId))
    error(
      'invalid-app-identity',
      '/identity/applicationId',
      'Application ID must be a stable reverse-DNS identifier.',
    );
  if (!request.identity.displayName.trim())
    error('invalid-app-identity', '/identity/displayName', 'Display name is required.');
  if (!request.iconSourcePath)
    error('missing-icon', '/iconSourcePath', 'A canonical application icon is required.');
  const capabilities = sorted([
    ...(request.capabilities ?? []),
    ...request.profile.capabilityOverrides,
  ]);
  const compatibility = evaluateTemplateCompatibility(descriptor, {
    profile: request.profile,
    runtimePackageApi: request.runtimePackageApi,
    playerConfigApi: 1,
    shaderVariants: [],
    graphicsBackends: [],
    capabilities: capabilities as never,
    requiredFeatures: [],
    host: request.host,
  });
  for (const item of compatibility.diagnostics)
    error(item.code, `/template${item.path}`, item.message);
  if (diagnostics.some((item) => item.severity === 'error')) return { diagnostics };
  const android =
    request.profile.target === 'android' && descriptor.android
      ? {
          applicationId: request.identity.applicationId,
          versionCode: request.identity.androidVersionCode ?? 1,
          versionName: request.identity.versionName,
          allowBackup: request.identity.androidAllowBackup ?? false,
          isGame: request.identity.androidIsGame ?? true,
          minSdk: request.profile.android.minSdk,
          targetSdk: descriptor.android.targetSdk,
          compileSdk: descriptor.android.compileSdk,
          abi: request.profile.android.abi,
          artifacts:
            request.profile.android.artifact === 'both'
              ? (['apk', 'aab'] as Array<'apk' | 'aab'>)
              : [request.profile.android.artifact],
          packageAccess: request.profile.packageAccess,
          orientation: request.display.orientation,
        }
      : undefined;
  return {
    diagnostics,
    model: {
      target: request.profile.target,
      architecture: request.profile.architecture,
      buildFlavor: request.profile.buildFlavor,
      applicationId: request.identity.applicationId,
      displayName: request.identity.displayName,
      versionName: request.identity.versionName,
      saveNamespace: request.identity.saveNamespace,
      capabilities: capabilities as PlatformDeploymentModel['capabilities'],
      capabilityMetadata: capabilityMetadata(capabilities),
      display: request.display,
      packageAccess: request.profile.packageAccess,
      templateId: descriptor.templateId,
      buildId: descriptor.buildId,
      runtimePackageApi: request.runtimePackageApi,
      android,
    },
  };
}
