// Standalone C++ platform contract certification. No TypeScript CLI oracle.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { createTemplateLicenseFixture } from './player-template-license-fixture';

const executable = process.env.NOVELTEA_NATIVE_CLI_BINARY;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-native-platform-'));
  roots.push(root);
  const registry = path.join(root, 'registry');
  const env = {
    ...process.env,
    NOVELTEA_TEMPLATE_REGISTRY_ROOT: registry,
    NOVELTEA_USER_CONFIG_ROOT: path.join(root, 'user'),
    HOME: root,
  };
  function run(...args: string[]) {
    const result = spawnSync(executable!, ['--no-daemon', '--json', ...args], {
      cwd: root,
      env,
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
  return { root, registry, run };
}

function archive(root: string, playerVariant = 'standard') {
  const source = path.join(root, 'source-' + playerVariant);
  fs.mkdirSync(source);
  const licenses = createTemplateLicenseFixture(source);
  const entries = [
    ['player.js', Buffer.from('globalThis.Module = {};\n')],
    ['player.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
    ['player.data', Buffer.from('assets\n')],
  ] as const;
  const files: Array<{
    path: string;
    size: number;
    mode: number;
    sha256: string;
    role: 'notice' | 'support' | 'player';
  }> = [...licenses.files];
  for (const [name, bytes] of entries) {
    fs.writeFileSync(path.join(source, name), bytes);
    files.push({
      path: name,
      size: bytes.length,
      mode: 0o644,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      role: (name === 'player.js' ? 'player' : 'support') as 'player' | 'support',
    });
  }
  fs.writeFileSync(
    path.join(source, 'template.json'),
    JSON.stringify({
      format: 'noveltea.player-template',
      formatVersion: 1,
      templateId: 'native-platform-test',
      buildId: 'build-1',
      engineVersion: '0.1.0',
      platform: 'web',
      architecture: 'wasm32',
      buildFlavor: 'debug',
      playerVariant,
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
      provenance: { provider: 'local', source: 'native-contract' },
      host: { assembly: 'any', requiresToolchain: false, tools: [] },
    }),
  );
  const output = path.join(root, playerVariant + '.tar.gz');
  const packed = spawnSync('cmake', ['-E', 'tar', 'czf', output, '.'], {
    cwd: source,
    encoding: 'utf8',
  });
  expect(packed.status, packed.stderr).toBe(0);
  return output;
}

describe.runIf(Boolean(executable))('installed native platform commands', () => {
  it('certifies template installation, inspection, corruption, removal and configuration', () => {
    const { root, registry, run } = setup();
    expect(run('platform', 'template', 'list').templates).toEqual([]);
    const missing = run('platform', 'template', 'inspect', 'missing@v1');
    expect(missing.success).toBe(false);
    expect(missing.exitCode).toBe(4);

    const file = archive(root);
    const installed = run('platform', 'template', 'install', file);
    expect(installed.success, JSON.stringify(installed)).toBe(true);
    expect(installed.id).toBe('native-platform-test@build-1');
    const reinstalled = run('platform', 'template', 'install', file, '--force');
    expect(reinstalled.success).toBe(true);
    expect(reinstalled.id).toBe(installed.id);
    const listed = run('platform', 'template', 'list');
    expect(listed.success).toBe(true);
    expect((listed.templates as unknown[]).length).toBe(1);
    const inspected = run('platform', 'template', 'inspect', 'native-platform-test@build-1');
    expect(inspected.success).toBe(true);

    const config = path.join(root, 'config.json');
    const initialized = run('platform', 'config', 'init', config);
    expect(initialized.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual(initialized.config);
    const forced = run('platform', 'config', 'init', config, '--force');
    expect(forced.success).toBe(true);
    expect(forced.config).toEqual(initialized.config);

    fs.writeFileSync(
      path.join(registry, 'native-platform-test/build-1/licenses/fixture-dependency--license.txt'),
      'tampered',
    );
    const corrupted = run('platform', 'template', 'inspect', 'native-platform-test@build-1');
    expect(corrupted.template).toEqual({
      ...(inspected.template as Record<string, unknown>),
      status: 'corrupted',
    });
    expect(
      run('platform', 'template', 'remove', 'native-platform-test@build-1', '--force').removed,
    ).toBe(true);
    expect(run('platform', 'template', 'list').templates).toEqual([]);
    expect(run('platform', 'template', 'inspect', 'native-platform-test@build-1').success).toBe(
      false,
    );
    expect(
      run('platform', 'template', 'remove', 'native-platform-test@build-1', '--force').success,
    ).toBe(false);
    expect(run('platform', 'template', 'install', path.join(root, 'missing.tar.gz')).success).toBe(
      false,
    );
  }, 120_000);

  it('rejects unsupported template descriptor variants using the native error contract', () => {
    const { root, run } = setup();
    const result = run('platform', 'template', 'install', archive(root, 'unsupported'));
    expect(result.success).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'template-install-failed',
          path: '/archive',
          severity: 'error',
          message: expect.stringContaining('not supported'),
        }),
      ]),
    );
  }, 120_000);
});
