import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runExportCommand } from '../../cli/export-command';
import { materializePlatformExportAcceptanceFixture } from '../../main/services/platform-export-acceptance-fixture-service';
import { configureTemplateRegistryRoot, installPlayerTemplate } from '../../main/services/template-registry-service';
import type { ExportPlatform } from '../../shared/project-schema/platform-export-contracts';

const target = process.env.NOVELTEA_CANONICAL_EXPORT_TARGET as ExportPlatform | undefined;
const archive = process.env.NOVELTEA_CANONICAL_TEMPLATE_ARCHIVE;
const enabled = Boolean(target && archive);
const suite = enabled ? describe : describe.skip;
let root = '';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

suite('canonical platform export integration', () => {
  beforeAll(async () => {
    root = process.env.NOVELTEA_CANONICAL_INTEGRATION_ROOT
      ?? await mkdtemp(path.join(os.tmpdir(), 'noveltea-canonical-export-'));
    await mkdir(root, { recursive: true });
    configureTemplateRegistryRoot(path.join(root, 'registry'));
  });

  afterAll(async () => {
    if (root && !process.env.NOVELTEA_CANONICAL_INTEGRATION_ROOT) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('materializes the canonical authoring fixture and exports it through the headless project/profile workflow', async () => {
    const installed = await installPlayerTemplate({ archivePath: archive!, origin: 'canonical-integration' });
    expect(installed.success, JSON.stringify(installed.diagnostics, null, 2)).toBe(true);

    const fixture = await materializePlatformExportAcceptanceFixture({
      root: path.join(root, 'Project ü space'),
      target: target!,
      architecture: target === 'web' ? 'wasm32' : target === 'macos' ? 'arm64' : target === 'android'
        ? (process.env.NOVELTEA_ANDROID_ABI === 'arm64-v8a' ? 'arm64' : 'x86_64')
        : 'x64',
      buildFlavor: (process.env.NOVELTEA_ANDROID_FLAVOR as 'debug' | 'release' | undefined) ?? 'release',
      androidAbi: (process.env.NOVELTEA_ANDROID_ABI as 'arm64-v8a' | 'x86_64' | undefined),
      androidArtifact: (process.env.NOVELTEA_ANDROID_ARTIFACT as 'apk' | 'aab' | 'both' | undefined),
      webBasePath: process.env.NOVELTEA_WEB_BASE_PATH,
      fontSourcePath: path.resolve(process.cwd(), '../apps/sandbox/assets/rmlui/LiberationSans.ttf'),
    });
    const outputDirectory = process.env.NOVELTEA_CANONICAL_EXPORT_OUTPUT ?? path.join(root, 'Output ü space');
    let configPath: string | undefined;
    const localConfig = {
      shaderc: process.env.NOVELTEA_SHADERC,
      bgfxShaderIncludeDir: process.env.NOVELTEA_BGFX_SHADER_INCLUDE_DIR,
      ...(target === 'android' ? {
        androidSdk: process.env.ANDROID_SDK_ROOT,
        androidNdk: process.env.ANDROID_NDK_ROOT,
        javaHome: process.env.JAVA_HOME,
        cmake: process.env.ANDROID_CMAKE_ROOT,
      } : {}),
    };
    if (localConfig.shaderc || localConfig.bgfxShaderIncludeDir || target === 'android') {
      configPath = path.join(root, 'export-local-state.json');
      await writeFile(configPath, `${JSON.stringify(localConfig)}\n`);
    }
    const command = await runExportCommand({
      projectPath: fixture.projectPath,
      profileId: fixture.profile.id,
      outputDirectory,
      configPath,
      json: true,
    });
    expect(command.exitCode, command.output).toBe(0);
    expect(command.result.success, JSON.stringify(command.result.diagnostics, null, 2)).toBe(true);
    const packageEntry = command.result.manifest?.files.find((entry) => entry.origin === 'runtime-package');
    expect(packageEntry?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const evidence = {
      format: 'noveltea-canonical-export-fixture',
      formatVersion: 1,
      fixtureRevision: fixture.fixtureRevision,
      sourceRevision: process.env.GITHUB_SHA ?? 'local',
      target,
      architecture: fixture.profile.architecture,
      buildFlavor: fixture.profile.buildFlavor,
      profileId: fixture.profile.id,
      profileSha256: fixture.profileSha256,
      projectSha256: fixture.projectSha256,
      runtimePackageSha256: packageEntry!.sha256,
      templateId: command.result.deployment?.templateId,
      templateBuildId: command.result.deployment?.buildId,
      outputManifestSha256: sha256(Buffer.from(JSON.stringify(command.result.manifest))),
    };
    const evidencePath = process.env.NOVELTEA_CANONICAL_EVIDENCE_OUTPUT
      ?? path.join(root, `canonical-${target}-fixture-evidence.json`);
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    expect(JSON.parse(await readFile(evidencePath, 'utf8'))).toMatchObject({
      fixtureRevision: fixture.fixtureRevision,
      target,
      runtimePackageSha256: packageEntry!.sha256,
    });
  }, 15 * 60_000);
});
