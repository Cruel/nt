import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runExportCommand } from '../../cli/export-command';
import { materializePlatformExportAcceptanceFixture } from '../../main/services/platform-export-acceptance-fixture-service';
import { configureTemplateRegistryRoot, installPlayerTemplate } from '../../main/services/template-registry-service';

const enabled = process.env.NOVELTEA_ANDROID_EXPORT_INTEGRATION === '1';
const suite = enabled ? describe : describe.skip;
let root = '';

suite('Android player template integration', () => {
  beforeAll(async () => { root = process.env.NOVELTEA_ANDROID_INTEGRATION_ROOT ?? await mkdtemp(path.join(os.tmpdir(), 'noveltea-android-export-')); await mkdir(root, { recursive: true }); configureTemplateRegistryRoot(path.join(root, 'registry')); }, 30_000);
  afterAll(async () => { if (root && !process.env.NOVELTEA_ANDROID_INTEGRATION_ROOT) await rm(root, { recursive: true, force: true }); });

  it('installs an immutable template and exports a verified APK through the headless export command', async () => {
    const archive = process.env.NOVELTEA_ANDROID_TEMPLATE_ARCHIVE!;
    const installed = await installPlayerTemplate({ archivePath: archive, origin: 'integration-test' });
    expect(installed.success, JSON.stringify(installed.diagnostics)).toBe(true);
    const revision = Number(process.env.NOVELTEA_ANDROID_FIXTURE_REVISION ?? '1');
    const abi = (process.env.NOVELTEA_ANDROID_ABI ?? 'x86_64') as 'x86_64' | 'arm64-v8a';
    const flavor = (process.env.NOVELTEA_ANDROID_FLAVOR ?? 'debug') as 'debug' | 'release';
    const artifact = (process.env.NOVELTEA_ANDROID_ARTIFACT ?? 'apk') as 'apk' | 'aab' | 'both';
    const fixture = await materializePlatformExportAcceptanceFixture({
      root: path.join(root, `Project ü space ${revision}`),
      target: 'android',
      architecture: abi === 'arm64-v8a' ? 'arm64' : 'x86_64',
      buildFlavor: flavor,
      androidAbi: abi,
      androidArtifact: artifact,
      contentRevision: revision,
      fontSourcePath: path.resolve(process.cwd(), '../apps/sandbox/assets/rmlui/LiberationSans.ttf'),
    });
    const output = process.env.NOVELTEA_ANDROID_EXPORT_OUTPUT ?? path.join(root, 'Output ü space');
    const configPath = path.join(fixture.projectRoot, 'android-toolchain.json');
    await writeFile(configPath, `${JSON.stringify({
      androidSdk: process.env.ANDROID_SDK_ROOT!,
      androidNdk: process.env.ANDROID_NDK_ROOT!,
      javaHome: process.env.JAVA_HOME!,
      cmake: process.env.ANDROID_CMAKE_ROOT!,
      shaderc: process.env.NOVELTEA_SHADERC!,
      bgfxShaderIncludeDir: process.env.NOVELTEA_BGFX_SHADER_INCLUDE_DIR!,
    })}\n`);
    const command = await runExportCommand({ projectPath: fixture.projectPath, profileId: fixture.profile.id, outputDirectory: output, configPath, json: true });
    const result = command.result;
    expect(command.exitCode, command.output).toBe(0);
    expect(result.success, JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    const expectedKinds = artifact === 'both' ? ['apk', 'aab'] : [artifact];
    expect(result.artifacts?.map((item) => item.kind)).toEqual(expect.arrayContaining(expectedKinds));
    expect(result.deployment?.android).toMatchObject({ applicationId: 'org.noveltea.platformexportacceptance', versionCode: revision, abi, artifacts: expectedKinds });
    expect(result.manifest?.files.find((entry) => entry.origin === 'runtime-package')?.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 15 * 60_000);
});
