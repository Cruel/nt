import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

type ExportManifestFile = { path: string; origin: string; sha256: string };

async function inspectActualExportLicenseViewer(
  outputDirectory: string,
  files: readonly ExportManifestFile[],
  packageEntry: ExportManifestFile,
  projectRoot: string,
) {
  const indexEntry = files.find((file) => file.path.endsWith('assets/system/licenses/index.json'));
  expect(indexEntry, 'Final export is missing player-readable engine licenses').toBeDefined();
  const systemPrefix = indexEntry!.path.slice(0, -'licenses/index.json'.length);
  const systemAssetsRoot = path.join(outputDirectory, systemPrefix);
  const indexBytes = await readFile(path.join(outputDirectory, indexEntry!.path));
  expect(sha256(indexBytes)).toBe(indexEntry!.sha256);
  const index = JSON.parse(indexBytes.toString('utf8')) as {
    components: Array<{
      displayName: string;
      version: string;
      files: Array<{ path: string; sha256: string; size: number }>;
    }>;
  };
  const expectedEngine = index.components.flatMap((component) =>
    component.files.map((file) => ({
      group: 'engine',
      label: `${component.displayName} (${component.version})`,
      path: `system:/${file.path}`,
      sha256: file.sha256,
      size: file.size,
    })),
  );
  expect(expectedEngine.length).toBeGreaterThan(0);
  const actualEngineEntries = files.filter((file) =>
    file.path.startsWith(`${systemPrefix}licenses/`),
  );
  expect(actualEngineEntries.length).toBe(expectedEngine.length + 1);
  for (const entry of expectedEngine) {
    const published = files.find(
      (file) => file.path === `${systemPrefix}${entry.path.slice('system:/'.length)}`,
    );
    expect(published?.sha256, entry.path).toBe(entry.sha256);
    expect(sha256(await readFile(path.join(outputDirectory, published!.path)))).toBe(entry.sha256);
  }

  const name =
    process.platform === 'win32' ? 'noveltea-ui-test-runner.exe' : 'noveltea-ui-test-runner';
  const repository = path.resolve(process.cwd(), '..');
  const preset =
    process.platform === 'win32'
      ? 'windows-release'
      : process.platform === 'darwin'
        ? 'macos-release'
        : 'linux-release';
  const cliHost =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const candidates = [
    process.env.NOVELTEA_LICENSE_VIEWER_RUNNER,
    path.join(repository, 'build/cli', cliHost, name),
    path.join(repository, 'build', preset, 'tools/editor_tool', name),
    path.join(repository, 'build/linux-debug/tools/editor_tool', name),
  ].filter((value): value is string => Boolean(value));
  let runner: string | null = null;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      runner = candidate;
      break;
    } catch {
      // The standalone CLI is installed under different build presets on CI hosts.
    }
  }
  expect(
    runner,
    'Cross-platform acceptance requires the native Licenses viewer runner',
  ).not.toBeNull();

  const requestPath = path.join(projectRoot, '.license-acceptance-input.json');
  const responsePath = path.join(projectRoot, '.license-acceptance-output.json');
  await writeFile(
    requestPath,
    JSON.stringify({
      operation: 'license-export-acceptance',
      systemAssetsRoot,
      packagePath: path.join(outputDirectory, packageEntry.path),
    }),
  );
  const result = spawnSync(runner!, [requestPath, responsePath], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  expect(result.error, result.stderr).toBeUndefined();
  const response = JSON.parse(await readFile(responsePath, 'utf8')) as {
    ok?: boolean;
    error?: string;
    viewer?: string;
    notices?: Array<{
      group: string;
      label: string;
      path: string;
      sha256: string;
      size: number;
    }>;
  };
  expect(result.status, result.stderr || response.error).toBe(0);
  expect(response.ok, response.error).toBe(true);
  expect(response.viewer).toBe('runtime_licenses');
  const expectedProject = [
    ['Shared Font License', 'support/licenses/shared-font.txt'],
    ['Localized Artwork', 'support/licenses/localized-art.txt'],
    ['Project-wide Credits', 'support/licenses/project.md'],
  ];
  const project = await Promise.all(
    expectedProject.map(async ([label, source]) => ({
      group: 'project',
      label,
      sha256: sha256(await readFile(path.join(projectRoot, source))),
    })),
  );
  const notices = response.notices ?? [];
  expect(notices.filter((notice) => notice.group === 'engine')).toEqual(
    expect.arrayContaining(expectedEngine),
  );
  expect(notices.filter((notice) => notice.group === 'engine')).toHaveLength(expectedEngine.length);
  expect(notices.filter((notice) => notice.group === 'project')).toHaveLength(3);
  for (const notice of project) {
    expect(notices).toEqual(expect.arrayContaining([expect.objectContaining(notice)]));
  }
  // Exercise the real native catalog failure path against a byte-tampered *finalized*
  // export, not a synthetic malformed index. Restore the published artifact afterward.
  const engineFile = expectedEngine[0]!;
  const originalPath = path.join(
    outputDirectory,
    `${systemPrefix}${engineFile.path.slice('system:/'.length)}`,
  );
  const originalBytes = await readFile(originalPath);
  const tampered = Buffer.from(originalBytes);
  tampered[0] = tampered[0] === 65 ? 66 : 65;
  const rejectedPath = path.join(projectRoot, '.license-acceptance-rejected.json');
  try {
    await writeFile(originalPath, tampered);
    const rejected = spawnSync(runner!, [requestPath, rejectedPath], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    const rejectedResponse = JSON.parse(await readFile(rejectedPath, 'utf8')) as {
      ok: boolean;
      error?: string;
    };
    expect(rejected.status).not.toBe(0);
    expect(rejectedResponse.ok).toBe(false);
    expect(rejectedResponse.error).toMatch(/notice bytes failed.*validation/u);
  } finally {
    await writeFile(originalPath, originalBytes);
  }
  return {
    viewer: response.viewer,
    engineNotices: expectedEngine.length,
    projectNotices: project.length,
    catalogSha256: sha256(Buffer.from(JSON.stringify(notices))),
  };
}

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
          '--allow-localization-warnings',
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
      const manifest = command.envelope.manifest as { files: ExportManifestFile[] } | undefined;
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
      // Android's finalized player/runtime acceptance is delegated to Android CI.
      const licenseViewer =
        target === 'android'
          ? undefined
          : await inspectActualExportLicenseViewer(
              outputDirectory,
              manifest!.files,
              packageEntry!,
              fixture.projectRoot,
            );

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
        ...(licenseViewer ? { licenseViewer } : {}),
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
