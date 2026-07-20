import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  buildAndroidManifest,
  publishAndroidArtifactSet,
} from '../../main/services/android-export-service';
import {
  parsePlatformExportProfile,
  parseTemplateDescriptor,
  type PlatformStageRequest,
} from '../../shared/project-schema/platform-export-contracts';

const sha = 'a'.repeat(64);
const profile = parsePlatformExportProfile({
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
const descriptor = parseTemplateDescriptor({
  format: 'noveltea.player-template',
  formatVersion: 1,
  templateId: 'android',
  buildId: 'one',
  engineVersion: '1',
  platform: 'android',
  architecture: 'arm64',
  abi: 'arm64-v8a',
  minimumPlatformVersion: '24',
  graphicsBackends: ['opengles'],
  shaderVariants: ['essl-300'],
  runtimePackageApi: { minimum: 1, maximum: 1 },
  playerConfigApi: { minimum: 1, maximum: 1 },
  compiledFeatures: [],
  capabilities: ['network.client', 'microphone'],
  buildFlavor: 'release',
  packageAccessModes: ['android-private-copy'],
  files: [{ path: 'source/android/gradlew', size: 1, mode: 493, sha256: sha }],
  runtimeDependencies: [],
  artifacts: {
    archive: 'template.zip',
    symbols: 'symbols.zip',
    sbom: 'SBOM.cdx.json',
    notices: 'NOTICE.txt',
  },
  provenance: { provider: 'local', source: 'test' },
  host: { assembly: 'any', requiresToolchain: true, tools: [] },
  android: {
    gradleProjectRoot: 'source/android',
    applicationModule: 'app',
    gradleWrapperPath: 'source/android/gradlew',
    bundletoolPath: 'source/android/bundletool.jar',
    insertionRoots: {
      generatedSource: 'generated/java',
      resources: 'generated/res',
      assets: 'generated/assets',
    },
    namespace: 'org.noveltea.player',
    activityClass: 'org.noveltea.player.MainActivity',
    nativeLibraryName: 'noveltea-player',
    supportedAbis: ['arm64-v8a'],
    artifactKinds: ['apk', 'aab'],
    packageAccessModes: ['android-private-copy'],
    minimumSdk: { minimum: 24, maximum: 35 },
    targetSdk: 35,
    compileSdk: 35,
    toolchain: {
      gradle: '8.7',
      androidGradlePlugin: '8.5.1',
      java: '17',
      buildTools: '35.0.0',
      ndk: '28.2',
      cmake: '3.31.6',
      bundletool: '1.18.1',
    },
    roles: { manifest: [], nativeLibraries: [], runtimeAssets: [], notices: [], supportFiles: [] },
  },
});
const request = (capabilities: PlatformStageRequest['capabilities']): PlatformStageRequest => ({
  operationId: 'op',
  profile,
  templateToken: 'android/one',
  outputDirectory: '/out',
  packagePath: '/game.ntpkg',
  iconSourcePath: '/icon.png',
  runtimePackageEvidence: {
    sourceFingerprint: 'fnv1a:12345678',
    packageSha256: 'a'.repeat(64),
  },
  identity: {
    displayName: 'A & B',
    applicationId: 'org.example.game',
    saveNamespace: 'org.example.game',
    versionName: '1',
    androidAllowBackup: false,
    androidIsGame: true,
  },
  display: { aspectRatio: { width: 16, height: 9 }, orientation: 'portrait', barColor: '#000000' },
  capabilities,
  runtimePackageApi: 1,
});

describe('Android generated manifest', () => {
  it('has minimal default closure and stable player identity', () => {
    const manifest = buildAndroidManifest(request([]), descriptor);
    expect(manifest).not.toContain('<uses-permission');
    expect(manifest).toContain('android:glEsVersion="0x00030000"');
    expect(manifest).toContain('org.noveltea.player.MainActivity');
    expect(manifest).toContain('android:value="noveltea-player"');
    expect(manifest).toContain('android:screenOrientation="sensorPortrait"');
    expect(manifest).toContain('android:allowBackup="false"');
  });

  it('adds only capability-derived permissions and features', () => {
    const manifest = buildAndroidManifest(request(['network.client', 'microphone']), descriptor);
    expect(manifest.match(/<uses-permission/g)).toHaveLength(2);
    expect(manifest).toContain('android.permission.INTERNET');
    expect(manifest).toContain('android.permission.RECORD_AUDIO');
    expect(manifest).toContain('android.hardware.microphone');
  });

  it('restores the prior complete artifact set when grouped publication fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nt-android-publish-'));
    const output = path.join(root, 'output');
    await mkdir(output);
    await writeFile(path.join(output, 'old.apk'), 'old');
    await expect(
      publishAndroidArtifactSet(path.join(root, 'missing-stage'), output, 'op'),
    ).rejects.toThrow();
    expect(await readFile(path.join(output, 'old.apk'), 'utf8')).toBe('old');
    await rm(root, { recursive: true, force: true });
  });
});
