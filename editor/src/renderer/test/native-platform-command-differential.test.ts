import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { runProjectIndependentPlatformCommand } from '../../cli/platform-independent-commands';
import { createNovelTeaCliPlatformToolService } from '../../cli/platform-tool-service-node';
import { configureTemplateRegistryRoot } from '../../main/services/template-registry-service';
import { createTemplateLicenseFixture } from './player-template-license-fixture';

const binary = process.env.NOVELTEA_NATIVE_CLI_BINARY;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-platform-differential-'));
  roots.push(root);
  const referenceRegistry = path.join(root, 'reference-registry');
  configureTemplateRegistryRoot(referenceRegistry);
  const nativeRegistry = path.join(root, 'native-registry');
  const environment = {
    ...process.env,
    NOVELTEA_TEMPLATE_REGISTRY_ROOT: nativeRegistry,
    NOVELTEA_USER_CONFIG_ROOT: path.join(root, 'native-user'),
    HOME: root,
  };

  function native(...command: string[]) {
    const result = spawnSync(binary!, ['--json', ...command], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      timeout: 90_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stdout, result.stderr).not.toBe('');
    const response = JSON.parse(result.stdout) as {
      success: boolean;
      exitCode: number;
      diagnostics: Array<{ code: string; severity: string; path: string; message: string }>;
      [key: string]: unknown;
    };
    expect(result.status).toBe(response.exitCode);
    return response;
  }

  async function compare(command: string[], nativeCommand = command) {
    const reference = await runProjectIndependentPlatformCommand({
      command,
      cwd: root,
      platformTools: createNovelTeaCliPlatformToolService(),
    });
    expect(reference).not.toBeNull();
    const actual = native(...nativeCommand);
    expect(actual.success, JSON.stringify({ nativeCommand, actual, reference })).toBe(
      reference!.ok,
    );
    expect(
      actual.diagnostics.map(({ code, severity, path, message }) => ({
        code,
        severity,
        path,
        message,
      })),
    ).toEqual(
      reference!.diagnostics.map(({ code, severity, path, message }) => ({
        code,
        severity,
        path,
        message,
      })),
    );
    return { actual, reference: reference! };
  }

  return { root, referenceRegistry, nativeRegistry, native, compare };
}

function webTemplate(root: string) {
  const source = path.join(root, 'template-source');
  fs.mkdirSync(source);
  const licenses = createTemplateLicenseFixture(source);
  const playerFiles = [
    ['player.js', Buffer.from('globalThis.Module = {};\n')],
    ['player.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
    ['player.data', Buffer.from('assets\n')],
  ] as const;
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const files: Array<{
    path: string;
    size: number;
    mode: number;
    sha256: string;
    role: 'notice' | 'support' | 'player';
  }> = [...licenses.files];
  for (const [name, contents] of playerFiles) {
    fs.writeFileSync(path.join(source, name), contents);
    files.push({
      path: name,
      size: contents.length,
      mode: 0o644,
      sha256: digest(contents),
      role: name === 'player.js' ? 'player' : 'support',
    });
  }
  fs.writeFileSync(
    path.join(source, 'template.json'),
    JSON.stringify({
      format: 'noveltea.player-template',
      formatVersion: 1,
      templateId: 'differential-web',
      buildId: 'build-1',
      engineVersion: '0.1.0',
      platform: 'web',
      architecture: 'wasm32',
      buildFlavor: 'debug',
      minimumPlatformVersion: 'test',
      graphicsBackends: ['webgl2'],
      shaderVariants: ['essl-300'],
      compiledProjectFormatVersion: 1,
      playerRuntimeApiVersion: 1,
      compiledFeatures: ['web-single-threaded'],
      capabilities: ['external-url'],
      packageAccessModes: ['web-fetch'],
      files,
      runtimeDependencies: licenses.runtimeDependencies,
      artifacts: {
        archive: 'template.tar.gz',
        symbols: 'symbols.tar.gz',
        sbom: 'SBOM.cdx.json',
        notices: 'licenses/index.json',
      },
      provenance: { provider: 'local', source: 'differential' },
      host: { assembly: 'any', requiresToolchain: false, tools: [] },
    }),
  );
  const archive = path.join(root, 'template.tar.gz');
  const packed = spawnSync('cmake', ['-E', 'tar', 'czf', archive, '.'], {
    cwd: source,
    encoding: 'utf8',
  });
  expect(packed.status, packed.stderr).toBe(0);
  return archive;
}

describe.runIf(Boolean(binary))(
  'installed native / established TypeScript platform commands',
  () => {
    it('compares isolated template lifecycle and configuration results', async () => {
      const { root, referenceRegistry, nativeRegistry, native, compare } = fixture();
      expect((await compare(['platform', 'template', 'list'])).actual.templates).toEqual([]);
      const missing = await compare(['platform', 'template', 'inspect', 'missing@v1']);
      expect(missing.actual.exitCode).toBe(4);

      const archive = webTemplate(root);
      const installed = await compare(['platform', 'template', 'install', archive]);
      expect(installed.actual.id).toBe(installed.reference.fields?.id);
      const reinstalled = await compare(['platform', 'template', 'install', archive, '--force']);
      expect(reinstalled.actual.id).toBe(installed.actual.id);
      const listed = await compare(['platform', 'template', 'list']);
      expect(listed.actual.templates).toEqual(listed.reference.fields?.templates);
      const inspected = await compare([
        'platform',
        'template',
        'inspect',
        'differential-web@build-1',
      ]);
      expect(inspected.actual.template).toEqual(inspected.reference.fields?.template);

      const settings = path.join(root, 'native-settings.json');
      const initialized = await compare(
        ['platform', 'config', 'init', path.join(root, 'reference-settings.json')],
        ['platform', 'config', 'init', settings],
      );
      expect(initialized.actual.config).toEqual(initialized.reference.fields?.config);
      expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual(initialized.actual.config);
      const forced = await compare(
        ['platform', 'config', 'init', path.join(root, 'reference-settings.json'), '--force'],
        ['platform', 'config', 'init', settings, '--force'],
      );
      expect(forced.actual.config).toEqual(initialized.actual.config);

      // Corruption must change the status in both independently installed registries.
      for (const registry of [referenceRegistry, nativeRegistry])
        fs.writeFileSync(
          path.join(registry, 'differential-web/build-1/licenses/fixture-dependency--license.txt'),
          'tampered',
        );
      const corrupted = await compare([
        'platform',
        'template',
        'inspect',
        'differential-web@build-1',
      ]);
      expect(corrupted.actual.template).toEqual({
        ...(inspected.actual.template as Record<string, unknown>),
        status: 'corrupted',
      });

      expect(
        (await compare(['platform', 'template', 'remove', 'differential-web@build-1', '--force']))
          .actual.removed,
      ).toBe(true);
      expect((await compare(['platform', 'template', 'list'])).actual.templates).toEqual([]);
      expect(
        (await compare(['platform', 'template', 'inspect', 'differential-web@build-1'])).actual
          .success,
      ).toBe(false);
      expect(
        (await compare(['platform', 'template', 'remove', 'differential-web@build-1', '--force']))
          .actual.success,
      ).toBe(false);
      expect(
        native('platform', 'template', 'install', path.join(root, 'missing.tar.gz')).success,
      ).toBe(false);
    }, 120_000);
  },
);
