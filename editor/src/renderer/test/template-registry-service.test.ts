import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  configureTemplateRegistryRoot,
  installPlayerTemplate,
  listPlayerTemplates,
  removePlayerTemplate,
  resolvePlayerTemplate,
  templateRootForToken,
} from '../../main/services/template-registry-service';
import { parsePlatformExportProfile } from '../../shared/project-schema/platform-export-contracts';

const roots: string[] = [];
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function archiveFixture(kind: 'tar' | 'zip' = 'tar') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-template-'));
  roots.push(root);
  const content = path.join(root, 'content');
  fs.mkdirSync(path.join(content, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(content, 'bin/player'), 'player', { mode: 0o755 });
  const player = fs.readFileSync(path.join(content, 'bin/player'));
  const descriptor = {
    format: 'noveltea.player-template',
    formatVersion: 1,
    templateId: 'linux-x64-release',
    buildId: 'build-1',
    engineVersion: '1',
    platform: 'linux',
    architecture: 'x64',
    minimumPlatformVersion: 'glibc 2.35',
    graphicsBackends: ['opengl'],
    shaderVariants: ['glsl-120'],
    runtimePackageApi: { minimum: 2, maximum: 2 },
    playerConfigApi: { minimum: 2, maximum: 2 },
    compiledFeatures: ['lua'],
    capabilities: [],
    buildFlavor: 'release',
    packageAccessModes: ['sidecar'],
    files: [
      {
        path: 'bin/player',
        size: player.length,
        mode: fs.statSync(path.join(content, 'bin/player')).mode & 0o777,
        sha256: hash(player),
      },
    ],
    runtimeDependencies: [{ path: 'bin/player', kind: 'library' }],
    artifacts: {
      archive: 'template.tar.gz',
      symbols: 'symbols.tar.gz',
      sbom: 'SBOM.cdx.json',
      notices: 'NOTICE.txt',
    },
    provenance: { provider: 'local', source: 'test' },
    host: { assembly: 'any', requiresToolchain: false, tools: [] },
  };
  fs.writeFileSync(path.join(content, 'template.json'), JSON.stringify(descriptor));
  const archive = path.join(root, kind === 'zip' ? 'template.zip' : 'template.tar.gz');
  if (kind === 'zip') execFileSync('zip', ['-qr', archive, '.'], { cwd: content });
  else
    execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', archive, '.'], {
      cwd: content,
    });
  configureTemplateRegistryRoot(path.join(root, 'registry'));
  return { root, archive };
}
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
describe('template registry service', () => {
  it('rejects template tokens that contain dot path segments', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-template-token-'));
    roots.push(root);
    const registry = path.join(root, 'registry');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    configureTemplateRegistryRoot(registry);

    expect(() => templateRootForToken('../outside')).toThrow('Invalid installed-template token');
    expect(() => templateRootForToken('template/..')).toThrow('Invalid installed-template token');
    await expect(removePlayerTemplate('..', 'outside')).rejects.toThrow(
      'Invalid installed-template token',
    );
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });
  it('installs, discovers, resolves, and removes verified local templates', async () => {
    const { archive } = archiveFixture();
    const installed = await installPlayerTemplate({ archivePath: archive, origin: 'test' });
    expect(installed.success).toBe(true);
    expect(installed.entry?.trust).toBe('local-untrusted');
    expect(await listPlayerTemplates()).toHaveLength(1);
    const resolved = await resolvePlayerTemplate({
      requirements: {
        profile,
        runtimePackageApi: 2,
        playerConfigApi: 2,
        shaderVariants: ['glsl-120'],
        graphicsBackends: ['opengl'],
        capabilities: [],
        requiredFeatures: ['lua'],
      },
    });
    expect(resolved.success).toBe(true);
    expect(resolved.diagnostics[0]?.code).toBe('template-untrusted');
    expect((await removePlayerTemplate('linux-x64-release', 'build-1')).removed).toBe(true);
  });
  it.skipIf(process.platform === 'win32')('installs ZIP templates without CMake', async () => {
    const { archive } = archiveFixture('zip');
    const installed = await installPlayerTemplate({ archivePath: archive, origin: 'zip-test' });
    expect(installed.success, JSON.stringify(installed.diagnostics)).toBe(true);
  });
  it.skipIf(process.platform === 'win32')(
    'installs a template without invoking CMake',
    async () => {
      const { archive, root } = archiveFixture();
      const marker = path.join(root, 'cmake-invoked');
      const fakeBin = path.join(root, 'fake-bin');
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(path.join(fakeBin, 'cmake'), `#!/bin/sh\ntouch '${marker}'\nexit 99\n`, {
        mode: 0o755,
      });
      const previousPath = process.env.PATH;
      const previousTar = process.env.NOVELTEA_TAR;
      process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ''}`;
      process.env.NOVELTEA_TAR = execFileSync('command', ['-v', 'tar'], {
        encoding: 'utf8',
        shell: true,
        env: { ...process.env, PATH: previousPath },
      }).trim();
      try {
        expect(
          (await installPlayerTemplate({ archivePath: archive, origin: 'no-cmake-test' })).success,
        ).toBe(true);
        expect(fs.existsSync(marker)).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousTar === undefined) delete process.env.NOVELTEA_TAR;
        else process.env.NOVELTEA_TAR = previousTar;
      }
    },
  );
  it('rejects a corrupted archive checksum and provenance mismatch', async () => {
    const { archive } = archiveFixture();
    expect(
      (await installPlayerTemplate({ archivePath: archive, archiveSha256: 'a'.repeat(64) }))
        .success,
    ).toBe(false);
    const actual = hash(fs.readFileSync(archive));
    const result = await installPlayerTemplate({
      archivePath: archive,
      officialProvenance: {
        archiveSha256: actual,
        descriptorSha256: 'b'.repeat(64),
        source: 'release',
      },
    });
    expect(result.success).toBe(false);
  });
});
