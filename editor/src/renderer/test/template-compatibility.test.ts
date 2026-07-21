import { describe, expect, it } from 'vite-plus/test';
import { evaluateTemplateCompatibility } from '../../shared/project-schema/template-compatibility';
import {
  parsePlatformExportProfile,
  parseTemplateDescriptor,
} from '../../shared/project-schema/platform-export-contracts';

const sha = 'a'.repeat(64);
const descriptor = parseTemplateDescriptor({
  format: 'noveltea.player-template',
  formatVersion: 1,
  templateId: 'linux-x64-release',
  buildId: 'one',
  engineVersion: '1',
  platform: 'linux',
  architecture: 'x64',
  minimumPlatformVersion: 'glibc 2.35',
  graphicsBackends: ['opengl'],
  shaderVariants: ['glsl-120'],
  runtimePackageApi: { minimum: 2, maximum: 2 },
  playerConfigApi: { minimum: 2, maximum: 2 },
  compiledFeatures: ['lua'],
  capabilities: ['gamepad'],
  buildFlavor: 'release',
  packageAccessModes: ['sidecar'],
  files: [{ path: 'bin/player', size: 1, mode: 493, sha256: sha }],
  runtimeDependencies: [{ path: 'bin/player', kind: 'library' }],
  artifacts: {
    archive: 'player.tar.gz',
    symbols: 'symbols.tar.gz',
    sbom: 'SBOM.cdx.json',
    notices: 'NOTICE.txt',
  },
  provenance: { provider: 'local', source: 'test' },
  host: { assembly: 'any', requiresToolchain: false, tools: [] },
});
const profile = parsePlatformExportProfile({
  format: 'noveltea.platform-export-profile',
  formatVersion: 1,
  id: 'linux',
  label: 'Linux',
  target: 'linux',
  architecture: 'x64',
  buildFlavor: 'release',
  packageAccess: 'sidecar',
  desktop: { artifact: 'tar', executableName: 'game' },
});

describe('template compatibility', () => {
  it('accepts a complete match', () =>
    expect(
      evaluateTemplateCompatibility(descriptor, {
        profile,
        runtimePackageApi: 2,
        playerConfigApi: 2,
        shaderVariants: ['glsl-120'],
        graphicsBackends: ['opengl'],
        capabilities: ['gamepad'],
        requiredFeatures: ['lua'],
      }).compatible,
    ).toBe(true));
  it('reports each incompatible contract dimension', () => {
    const incompatibleProfile = parsePlatformExportProfile({
      ...profile,
      architecture: 'arm64',
      buildFlavor: 'debug',
      packageAccess: 'bundle-resource',
    });
    const result = evaluateTemplateCompatibility(descriptor, {
      profile: incompatibleProfile,
      runtimePackageApi: 3,
      playerConfigApi: 3,
      shaderVariants: ['essl-300'],
      graphicsBackends: ['vulkan'],
      capabilities: ['microphone'],
      requiredFeatures: ['rmlui'],
      host: { platform: 'windows', availableTools: [] },
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'template-architecture-mismatch',
        'template-flavor-mismatch',
        'template-package-access-mismatch',
        'template-runtime-package-api-mismatch',
        'template-player-config-api-mismatch',
        'template-shader-variant-mismatch',
        'template-renderer-mismatch',
        'template-capability-mismatch',
        'template-feature-mismatch',
      ]),
    );
  });
  it('checks every Android template contract dimension', () => {
    const androidProfile = parsePlatformExportProfile({
      format: 'noveltea.platform-export-profile',
      formatVersion: 1,
      id: 'android',
      label: 'Android',
      target: 'android',
      architecture: 'arm64',
      buildFlavor: 'release',
      packageAccess: 'android-private-copy',
      android: { artifact: 'both', abi: 'arm64-v8a', minSdk: 24 },
    });
    const androidDescriptor = parseTemplateDescriptor({
      ...descriptor,
      templateId: 'android',
      platform: 'android',
      architecture: 'arm64',
      abi: 'arm64-v8a',
      minimumPlatformVersion: '24',
      packageAccessModes: ['android-private-copy'],
      android: {
        gradleProjectRoot: 'gradle',
        applicationModule: 'app',
        gradleWrapperPath: 'gradle/gradlew',
        bundletoolPath: 'gradle/tools/bundletool.jar',
        insertionRoots: {
          generatedSource: 'app/generated',
          resources: 'app/res',
          assets: 'app/assets',
        },
        namespace: 'org.noveltea.player',
        activityClass: 'org.noveltea.player.MainActivity',
        nativeLibraryName: 'noveltea-player',
        supportedAbis: ['x86_64'],
        artifactKinds: ['apk'],
        packageAccessModes: ['android-asset'],
        minimumSdk: { minimum: 26, maximum: 35 },
        targetSdk: 35,
        compileSdk: 35,
        toolchain: {
          gradle: '8.10',
          androidGradlePlugin: '8.5.1',
          java: '17',
          buildTools: '35.0.0',
          ndk: '28.0',
          cmake: '3.31',
          bundletool: '1.18',
        },
        roles: {
          manifest: ['app/AndroidManifest.xml'],
          nativeLibraries: [],
          runtimeAssets: [],
          notices: [],
          supportFiles: ['gradle/gradlew'],
        },
      },
    });
    const result = evaluateTemplateCompatibility(androidDescriptor, {
      profile: androidProfile,
      runtimePackageApi: 2,
      playerConfigApi: 2,
      shaderVariants: [],
      graphicsBackends: [],
      capabilities: [],
      requiredFeatures: [],
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'template-android-abi-mismatch',
        'template-android-artifact-mismatch',
        'template-android-package-access-mismatch',
        'template-android-sdk-mismatch',
      ]),
    );
  });
});
