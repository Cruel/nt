import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { probeAndroidToolchain } from '../../main/services/android-toolchain-service';

const roots: string[] = [];
async function executable(file: string, output: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\necho '${output}'\n`);
  await chmod(file, 0o755);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Android toolchain probe', () => {
  it('reports missing and wrong-version tools individually before Gradle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nt-android-tools-'));
    roots.push(root);
    const sdk = path.join(root, 'sdk');
    const ndk = path.join(root, 'ndk');
    const javaHome = path.join(root, 'jdk');
    await executable(path.join(javaHome, 'bin', 'java'), 'openjdk version "17.0.12"');
    await executable(path.join(root, 'gradlew'), 'Gradle 8.7');
    await mkdir(path.join(sdk, 'platforms', 'android-35'), { recursive: true });
    await writeFile(path.join(sdk, 'platforms', 'android-35', 'android.jar'), 'jar');
    for (const name of ['aapt2', 'zipalign', 'apksigner'])
      await executable(path.join(sdk, 'build-tools', '35.0.0', name), name);
    await executable(
      path.join(ndk, 'toolchains', 'llvm', 'prebuilt', 'linux-x86_64', 'bin', 'clang'),
      'clang',
    );
    await writeFile(path.join(ndk, 'source.properties'), 'Pkg.Revision = 28.2.13676358\n');
    await executable(path.join(root, 'cmake'), 'cmake version 3.31.6');
    await writeFile(path.join(root, 'bundletool-1.18.1.jar'), 'jar');
    const result = await probeAndroidToolchain({
      javaHome,
      androidSdk: sdk,
      androidNdk: ndk,
      cmake: path.join(root, 'cmake'),
      gradleWrapper: path.join(root, 'gradlew'),
      bundletool: path.join(root, 'bundletool-1.18.1.jar'),
      compileSdk: 35,
      buildToolsVersion: '35.0.0',
      expectedVersions: {
        java: '21',
        gradle: '8.7',
        'ndk-clang': '28.2.13676358',
        cmake: '3.31.6',
        bundletool: '1.18.1',
      },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/toolchain/java', code: 'android-tool-required' }),
        expect.objectContaining({ path: '/toolchain/adb', code: 'android-tool-optional' }),
      ]),
    );
    expect(result.tools.find((tool) => tool.name === 'gradle')?.ok).toBe(true);
  });
});
