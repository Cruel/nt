import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import { createNodeNovelTeaCliPlatformToolService } from '../../cli/platform-tool-service-node';
import { materializePlatformExportAcceptanceFixture } from '../../main/services/platform-export-acceptance-fixture-service';
import {
  configureTemplateRegistryRoot,
  installPlayerTemplate,
} from '../../main/services/template-registry-service';
import type { ExportPlatform } from '../../shared/project-schema/platform-export-contracts';

const target = process.env.NOVELTEA_CANONICAL_EXPORT_TARGET as ExportPlatform | undefined;
const archive = process.env.NOVELTEA_CANONICAL_TEMPLATE_ARCHIVE;
const enabled = Boolean(target && archive);
const suite = enabled ? describe : describe.skip;
let root = '';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

suite('canonical platform export integration', () => {
  beforeAll(async () => {
    root =
      process.env.NOVELTEA_CANONICAL_INTEGRATION_ROOT ??
      (await mkdtemp(path.join(os.tmpdir(), 'noveltea-canonical-export-')));
    await mkdir(root, { recursive: true });
    configureTemplateRegistryRoot(path.join(root, 'registry'));
  });

  afterAll(async () => {
    if (root && !process.env.NOVELTEA_CANONICAL_INTEGRATION_ROOT) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    'materializes the canonical authoring fixture and exports it through the headless project/profile workflow',
    async () => {
      const installed = await installPlayerTemplate({
        archivePath: archive!,
        origin: 'canonical-integration',
      });
      expect(installed.success, JSON.stringify(installed.diagnostics, null, 2)).toBe(true);
      expect(installed.entry).toBeDefined();

      const fixture = await materializePlatformExportAcceptanceFixture({
        root: path.join(root, 'Project ü space'),
        target: target!,
        architecture:
          target === 'web'
            ? 'wasm32'
            : target === 'macos'
              ? 'arm64'
              : target === 'android'
                ? process.env.NOVELTEA_ANDROID_ABI === 'arm64-v8a'
                  ? 'arm64'
                  : 'x86_64'
                : 'x64',
        buildFlavor:
          (process.env.NOVELTEA_ANDROID_FLAVOR as 'debug' | 'release' | undefined) ?? 'release',
        androidAbi: process.env.NOVELTEA_ANDROID_ABI as 'arm64-v8a' | 'x86_64' | undefined,
        androidArtifact: process.env.NOVELTEA_ANDROID_ARTIFACT as
          | 'apk'
          | 'aab'
          | 'both'
          | undefined,
        webBasePath: process.env.NOVELTEA_WEB_BASE_PATH,
        webThreaded: process.env.NOVELTEA_WEB_THREADED !== 'false',
        fontSourcePath: path.resolve(
          process.cwd(),
          '../engine/assets/system/fonts/LiberationSans.ttf',
        ),
      });
      const outputDirectory =
        process.env.NOVELTEA_CANONICAL_EXPORT_OUTPUT ?? path.join(root, 'Output ü space');
      let configPath: string | undefined;
      if (target === 'android') {
        const localConfig = {
          format: 'noveltea.editor-export-local-state',
          templateRoots: [],
          toolchains: {
            androidSdk: process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME,
            androidNdk: process.env.ANDROID_NDK_ROOT,
            javaHome: process.env.JAVA_HOME,
            cmake: process.env.ANDROID_CMAKE_ROOT,
          },
          signing: {},
        };
        configPath = path.join(root, 'export-local-state.json');
        await writeFile(configPath, `${JSON.stringify(localConfig)}\n`);
      }
      const templateId = `${installed.entry!.templateId}@${installed.entry!.buildId}`;
      const command = await runNovelTeaCli(
        [
          '--project',
          fixture.projectRoot,
          '--json',
          'platform',
          'export',
          '--profile',
          fixture.profile.id,
          '--template',
          templateId,
          '--allow-untrusted-template',
          '--output',
          outputDirectory,
          ...(configPath ? ['--config', configPath] : []),
        ],
        {
          platformTools: createNodeNovelTeaCliPlatformToolService(),
        },
      );
      expect(command.exitCode, command.stderr || command.stdout).toBe(0);
      expect(command.envelope.success, JSON.stringify(command.envelope.diagnostics, null, 2)).toBe(
        true,
      );
      const manifest = command.envelope.manifest as
        | { files: Array<{ origin: string; sha256: string }> }
        | undefined;
      const deployment = command.envelope.deployment as
        | {
            templateId?: string;
            buildId?: string;
            compiledProjectFormatVersion?: number;
            playerRuntimeApiVersion?: number;
          }
        | undefined;
      const packageEntry = manifest?.files.find((entry) => entry.origin === 'runtime-package');
      expect(packageEntry?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(deployment?.compiledProjectFormatVersion).toBeTypeOf('number');
      expect(deployment?.playerRuntimeApiVersion).toBeTypeOf('number');

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
        compiledProjectFormatVersion: deployment!.compiledProjectFormatVersion!,
        playerRuntimeApiVersion: deployment!.playerRuntimeApiVersion!,
        packageAccessMode: fixture.profile.packageAccess,
        webBasePath: fixture.profile.target === 'web' ? fixture.profile.web.basePath : undefined,
        webThreaded: fixture.profile.target === 'web' ? fixture.profile.web.threaded : undefined,
        templateId: deployment?.templateId,
        templateBuildId: deployment?.buildId,
        outputManifestSha256: sha256(Buffer.from(JSON.stringify(manifest))),
      };
      const evidencePath =
        process.env.NOVELTEA_CANONICAL_EVIDENCE_OUTPUT ??
        path.join(root, `canonical-${target}-fixture-evidence.json`);
      await mkdir(path.dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      expect(JSON.parse(await readFile(evidencePath, 'utf8'))).toMatchObject({
        fixtureRevision: fixture.fixtureRevision,
        target,
        runtimePackageSha256: packageEntry!.sha256,
      });
    },
    15 * 60_000,
  );
});
