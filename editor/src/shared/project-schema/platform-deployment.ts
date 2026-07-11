import type { PlatformCapabilityMetadata, PlatformDeploymentModel, PlatformStageDiagnostic, PlatformStageRequest, TemplateDescriptor } from './platform-export-contracts';
import { applicationIdPattern } from './authoring-project-settings';

const mapping: Record<string, Partial<PlatformCapabilityMetadata>> = {
  'network.client': { androidPermissions: ['android.permission.INTERNET'], webRequirements: ['network'] },
  'external-url': { androidPermissions: ['android.permission.INTERNET'], webRequirements: ['external-navigation'] },
  'clipboard.read': { webRequirements: ['clipboard-read'], desktopFeatures: ['clipboard'] },
  'clipboard.write': { webRequirements: ['clipboard-write'], desktopFeatures: ['clipboard'] },
  gamepad: { androidFeatures: ['android.hardware.gamepad'], webRequirements: ['gamepad'], desktopFeatures: ['gamepad'] },
  vibration: { androidPermissions: ['android.permission.VIBRATE'], webRequirements: ['vibration'] },
  microphone: { androidPermissions: ['android.permission.RECORD_AUDIO'], androidFeatures: ['android.hardware.microphone'], webRequirements: ['microphone'] },
  notifications: { androidPermissions: ['android.permission.POST_NOTIFICATIONS'], webRequirements: ['notifications'] },
  'custom-url-scheme': { webRequirements: ['custom-url-scheme'], desktopFeatures: ['custom-url-scheme'] },
  billing: { androidPermissions: ['com.android.vending.BILLING'], desktopFeatures: ['billing'] },
};
const sorted = (values: string[]) => [...new Set(values)].sort();
export function capabilityMetadata(capabilities: string[]): PlatformCapabilityMetadata {
  const result: PlatformCapabilityMetadata = { androidPermissions: [], androidFeatures: [], webRequirements: [], desktopFeatures: [] };
  for (const capability of capabilities) for (const key of Object.keys(result) as Array<keyof PlatformCapabilityMetadata>) result[key].push(...(mapping[capability]?.[key] ?? []));
  for (const key of Object.keys(result) as Array<keyof PlatformCapabilityMetadata>) result[key] = sorted(result[key]);
  return result;
}

export function buildPlatformDeployment(request: PlatformStageRequest, descriptor: TemplateDescriptor): { model?: PlatformDeploymentModel; diagnostics: PlatformStageDiagnostic[] } {
  const diagnostics: PlatformStageDiagnostic[] = [];
  const error = (code: string, path: string, message: string) => diagnostics.push({ severity: 'error' as const, code, path, message });
  if (!applicationIdPattern.test(request.identity.applicationId)) error('invalid-app-identity', '/identity/applicationId', 'Application ID must be a stable reverse-DNS identifier.');
  if (!request.identity.displayName.trim()) error('invalid-app-identity', '/identity/displayName', 'Display name is required.');
  if (!request.iconSourcePath) error('missing-icon', '/iconSourcePath', 'A canonical application icon is required.');
  if (descriptor.platform !== request.profile.target || descriptor.architecture !== request.profile.architecture) error('incompatible-template', '/template', 'Template target or architecture does not match the export profile.');
  if (descriptor.buildFlavor !== request.profile.buildFlavor) error('incompatible-template', '/template/buildFlavor', 'Template build flavor does not match the export profile.');
  if (request.runtimePackageApi < descriptor.runtimePackageApi.minimum || request.runtimePackageApi > descriptor.runtimePackageApi.maximum) error('incompatible-package-api', '/runtimePackageApi', 'Runtime package API is not supported by the template.');
  if (request.host && descriptor.host.assembly !== 'any' && descriptor.host.assembly !== request.host.platform) error('unsupported-host', '/host/platform', `Template assembly requires a ${descriptor.host.assembly} host.`);
  if (request.host && descriptor.host.requiresToolchain) for (const tool of descriptor.host.tools) if (!request.host.availableTools.includes(tool)) error('missing-toolchain', '/host/availableTools', `Required tool '${tool}' is unavailable.`);
  const capabilities = sorted([...(request.capabilities ?? []), ...request.profile.capabilityOverrides]);
  for (const capability of capabilities) if (!descriptor.capabilities.includes(capability as never)) error('unsupported-capability', '/capabilities', `Template does not support capability '${capability}'.`);
  if (diagnostics.some((item) => item.severity === 'error')) return { diagnostics };
  return { diagnostics, model: { target: request.profile.target, architecture: request.profile.architecture, buildFlavor: request.profile.buildFlavor, applicationId: request.identity.applicationId, displayName: request.identity.displayName, versionName: request.identity.versionName, saveNamespace: request.identity.saveNamespace, capabilities: capabilities as PlatformDeploymentModel['capabilities'], capabilityMetadata: capabilityMetadata(capabilities), display: request.display, packageAccess: request.profile.packageAccess, templateId: descriptor.templateId, buildId: descriptor.buildId, runtimePackageApi: request.runtimePackageApi } };
}
