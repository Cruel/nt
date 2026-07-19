import type {
  TemplateCompatibilityRequirements,
  TemplateCompatibilityResult,
  TemplateDescriptor,
} from './platform-export-contracts';

export function evaluateTemplateCompatibility(
  descriptor: TemplateDescriptor,
  requirements: TemplateCompatibilityRequirements,
): TemplateCompatibilityResult {
  const diagnostics: TemplateCompatibilityResult['diagnostics'] = [];
  const add = (code: string, path: string, message: string) =>
    diagnostics.push({ code, path, message });
  const profile = requirements.profile;
  if (descriptor.platform !== profile.target)
    add(
      'template-platform-mismatch',
      '/platform',
      `Template targets ${descriptor.platform}, not ${profile.target}.`,
    );
  if (descriptor.architecture !== profile.architecture)
    add(
      'template-architecture-mismatch',
      '/architecture',
      `Template architecture ${descriptor.architecture} does not match ${profile.architecture}.`,
    );
  if (descriptor.buildFlavor !== profile.buildFlavor)
    add(
      'template-flavor-mismatch',
      '/buildFlavor',
      `Template flavor ${descriptor.buildFlavor} does not match ${profile.buildFlavor}.`,
    );
  if (!descriptor.packageAccessModes.includes(profile.packageAccess))
    add(
      'template-package-access-mismatch',
      '/packageAccessModes',
      `Template does not support package access mode '${profile.packageAccess}'.`,
    );
  const range = (value: number, minimum: number, maximum: number) =>
    value >= minimum && value <= maximum;
  if (
    !range(
      requirements.runtimePackageApi,
      descriptor.runtimePackageApi.minimum,
      descriptor.runtimePackageApi.maximum,
    )
  )
    add(
      'template-runtime-package-api-mismatch',
      '/runtimePackageApi',
      'Template does not support this runtime package API.',
    );
  if (
    !range(
      requirements.playerConfigApi,
      descriptor.playerConfigApi.minimum,
      descriptor.playerConfigApi.maximum,
    )
  )
    add(
      'template-player-config-api-mismatch',
      '/playerConfigApi',
      'Template does not support this player config API.',
    );
  for (const value of requirements.shaderVariants)
    if (!descriptor.shaderVariants.includes(value))
      add(
        'template-shader-variant-mismatch',
        '/shaderVariants',
        `Template is missing shader variant '${value}'.`,
      );
  for (const value of requirements.graphicsBackends)
    if (!descriptor.graphicsBackends.includes(value))
      add(
        'template-renderer-mismatch',
        '/graphicsBackends',
        `Template is missing graphics backend '${value}'.`,
      );
  for (const value of requirements.capabilities)
    if (!descriptor.capabilities.includes(value))
      add(
        'template-capability-mismatch',
        '/capabilities',
        `Template does not support capability '${value}'.`,
      );
  for (const value of requirements.requiredFeatures)
    if (!descriptor.compiledFeatures.includes(value))
      add(
        'template-feature-mismatch',
        '/compiledFeatures',
        `Template is missing compiled feature '${value}'.`,
      );
  if (profile.target === 'web') {
    const requiredThreadingFeature = profile.web.threaded ? 'web-threads' : 'web-single-threaded';
    if (!descriptor.compiledFeatures.includes(requiredThreadingFeature))
      add(
        'template-web-threading-mismatch',
        '/compiledFeatures',
        `Template is missing required Web build feature '${requiredThreadingFeature}'.`,
      );
  }
  if (profile.target === 'android') {
    const android = descriptor.android;
    if (!android)
      add(
        'template-android-contract-missing',
        '/android',
        'Android template is missing its platform contract.',
      );
    else {
      if (!android.supportedAbis.includes(profile.android.abi))
        add(
          'template-android-abi-mismatch',
          '/android/supportedAbis',
          `Template does not support ABI '${profile.android.abi}'.`,
        );
      const artifacts =
        profile.android.artifact === 'both'
          ? (['apk', 'aab'] as const)
          : [profile.android.artifact];
      for (const artifact of artifacts)
        if (!android.artifactKinds.includes(artifact))
          add(
            'template-android-artifact-mismatch',
            '/android/artifactKinds',
            `Template does not support Android artifact '${artifact}'.`,
          );
      if (!android.packageAccessModes.includes(profile.packageAccess))
        add(
          'template-android-package-access-mismatch',
          '/android/packageAccessModes',
          `Android template does not support package access mode '${profile.packageAccess}'.`,
        );
      if (
        profile.android.minSdk < android.minimumSdk.minimum ||
        profile.android.minSdk > android.minimumSdk.maximum
      )
        add(
          'template-android-sdk-mismatch',
          '/android/minimumSdk',
          `Requested minimum SDK ${profile.android.minSdk} is outside the template range ${android.minimumSdk.minimum}-${android.minimumSdk.maximum}.`,
        );
    }
  }
  if (
    requirements.host &&
    descriptor.host.assembly !== 'any' &&
    descriptor.host.assembly !== requirements.host.platform
  )
    add(
      'template-host-mismatch',
      '/host/assembly',
      `Template assembly requires a ${descriptor.host.assembly} host.`,
    );
  if (requirements.host && descriptor.host.requiresToolchain && profile.target !== 'android')
    for (const tool of descriptor.host.tools)
      if (!requirements.host.availableTools.includes(tool))
        add('template-toolchain-missing', '/host/tools', `Required tool '${tool}' is unavailable.`);
  return { compatible: diagnostics.length === 0, diagnostics };
}
