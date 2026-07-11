import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { stagePlatformExport } from '../../main/services/platform-staging-service';
import { PLATFORM_EXPORT_PROFILE_FORMAT, TEMPLATE_DESCRIPTOR_FORMAT, type PlatformStageRequest } from '../../shared/project-schema/platform-export-contracts';
import { configureTemplateRegistryRoot, templateRootForToken } from '../../main/services/template-registry-service';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as ResEdit from 'resedit';
import { installPlayerTemplate } from '../../main/services/template-registry-service';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-stage-')); roots.push(root);
  configureTemplateRegistryRoot(path.join(root, 'registry')); const templateToken = 'linux-x64/build-1'; const templateRoot = templateRootForToken(templateToken); fs.mkdirSync(path.join(templateRoot, 'bin'), { recursive: true }); fs.writeFileSync(path.join(templateRoot, 'bin/player'), 'player');
  const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex'); const player = fs.readFileSync(path.join(templateRoot, 'bin/player')); const mode = fs.statSync(path.join(templateRoot, 'bin/player')).mode & 0o777;
  const descriptor = { format: TEMPLATE_DESCRIPTOR_FORMAT, formatVersion: 1, templateId: 'linux-x64', buildId: 'build-1', engineVersion: '1', platform: 'linux', architecture: 'x64', minimumPlatformVersion: 'provisional', graphicsBackends: ['opengl'], shaderVariants: ['glsl-120'], runtimePackageApi: { minimum: 1, maximum: 1 }, playerConfigApi: { minimum: 1, maximum: 1 }, compiledFeatures: [], capabilities: [], buildFlavor: 'release', packageAccessModes: ['sidecar'], files: [{ path: 'bin/player', size: player.length, mode, sha256: sha(player) }], runtimeDependencies: [], artifacts: { archive: 'linux.tar.gz', symbols: 'linux-symbols.tar.gz', sbom: 'SBOM.cdx.json', notices: 'THIRD_PARTY_NOTICES.txt' }, provenance: { provider: 'local', source: 'test' }, host: { assembly: 'any', requiresToolchain: false, tools: [] } }; const descriptorData = Buffer.from(JSON.stringify(descriptor));
  fs.writeFileSync(path.join(templateRoot, 'template.json'), descriptorData); fs.writeFileSync(path.join(templateRoot, '.noveltea-template.json'), JSON.stringify({ format: 'noveltea.template-registry', formatVersion: 1, templateId: 'linux-x64', buildId: 'build-1', descriptorSha256: sha(descriptorData), archiveSha256: 'a'.repeat(64), installedAt: new Date().toISOString(), origin: 'test', trust: 'local-untrusted', verified: true }));
  const packagePath = path.join(root, 'game.ntpkg'); fs.writeFileSync(packagePath, 'package'); const iconSourcePath = path.join(root, 'icon.png'); await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#ff0000' } }).png().toFile(iconSourcePath);
  const request: PlatformStageRequest = { operationId: 'one', profile: { format: PLATFORM_EXPORT_PROFILE_FORMAT, formatVersion: 1, id: 'linux', label: 'Linux', target: 'linux', architecture: 'x64', packageAccess: 'sidecar', buildFlavor: 'release', compression: 'default', includeDebugSymbols: false, capabilityOverrides: [], desktop: { artifact: 'tar', executableName: 'game' } }, templateToken, outputDirectory: path.join(root, 'out'), packagePath, iconSourcePath, runtimePackageReadiness: { validated: true, blockingDiagnosticCount: 0 }, identity: { displayName: 'Game', applicationId: 'com.example.game', saveNamespace: 'com.example.game', versionName: '1', defaultLocale: 'en-US' }, display: { aspectRatio: { width: 16, height: 9 }, orientation: 'landscape', barColor: '#000000' }, runtimePackageApi: 1 };
  return { root, request, templateRoot };
}

function outputBytes(root: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix.split(path.sep).join('/'), entry.name);
    if (entry.isDirectory()) Object.assign(result, outputBytes(root, relative));
    else result[relative] = fs.readFileSync(path.join(root, relative)).toString('base64');
  }
  return result;
}

describe('platform staging service', () => {
  it('builds deterministic provenance and replaces a previous output', async () => {
    const { request } = await fixture(); fs.mkdirSync(request.outputDirectory); fs.writeFileSync(path.join(request.outputDirectory, 'old'), 'old');
    const first = await stagePlatformExport(request); expect(first.success).toBe(true); expect(fs.existsSync(path.join(request.outputDirectory, 'old'))).toBe(false);
    expect(first.manifest?.files.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
    const firstBytes = outputBytes(request.outputDirectory);
    const second = await stagePlatformExport({ ...request, operationId: 'two' }); expect(second.manifest).toEqual(first.manifest);
    expect(outputBytes(request.outputDirectory)).toEqual(firstBytes);
    expect(JSON.parse(fs.readFileSync(path.join(request.outputDirectory, 'export-manifest.json'), 'utf8')).deployment.applicationId).toBe('com.example.game');
    expect(JSON.parse(fs.readFileSync(path.join(request.outputDirectory, 'player.json'), 'utf8')).defaultLocale).toBe('en-US');
  });

  it('rejects sandbox content without touching previous output', async () => {
    const { request, templateRoot } = await fixture(); fs.writeFileSync(path.join(templateRoot, 'bin/player'), 'tampered'); fs.mkdirSync(request.outputDirectory); fs.writeFileSync(path.join(request.outputDirectory, 'keep'), 'yes');
    const result = await stagePlatformExport(request); expect(result.success).toBe(false); expect(result.diagnostics.some((item) => item.code === 'invalid-installed-template')).toBe(true); expect(fs.readFileSync(path.join(request.outputDirectory, 'keep'), 'utf8')).toBe('yes');
  });

  it('rejects missing icons and packages without successful runtime readiness', async () => {
    const { request } = await fixture();
    const notReady = await stagePlatformExport({
      ...request,
      runtimePackageReadiness: { validated: true, blockingDiagnosticCount: 1 },
    });
    expect(notReady.success).toBe(false);
    expect(notReady.diagnostics.some((item) => item.code === 'runtime-package-not-ready')).toBe(true);

    const missingIcon = await stagePlatformExport({ ...request, operationId: 'missing-icon', iconSourcePath: undefined });
    expect(missingIcon.success).toBe(false);
    expect(missingIcon.diagnostics.some((item) => item.code === 'missing-icon')).toBe(true);
  });

  it('emits an isolated, content-hashed Web directory and ZIP', async () => {
    const { root, request } = await fixture();
    const registry = path.join(root, 'web-registry'); configureTemplateRegistryRoot(registry);
    const templateToken = 'web-wasm32/build-1'; const templateRoot = templateRootForToken(templateToken); fs.mkdirSync(templateRoot, { recursive: true });
    fs.writeFileSync(path.join(templateRoot, 'player.js'), 'console.log("release player")');
    fs.writeFileSync(path.join(templateRoot, 'player.wasm'), Buffer.from([0, 97, 115, 109]));
    fs.writeFileSync(path.join(templateRoot, 'player.data'), 'system assets');
    const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
    const entries = ['player.js', 'player.wasm', 'player.data'].map((file) => { const data = fs.readFileSync(path.join(templateRoot, file)); return { path: file, size: data.length, mode: fs.statSync(path.join(templateRoot, file)).mode & 0o777, sha256: sha(data) }; });
    const descriptor = { format: TEMPLATE_DESCRIPTOR_FORMAT, formatVersion: 1, templateId: 'web-wasm32', buildId: 'build-1', engineVersion: '1', platform: 'web', architecture: 'wasm32', minimumPlatformVersion: 'modern', graphicsBackends: ['webgl2'], shaderVariants: ['essl-300'], runtimePackageApi: { minimum: 1, maximum: 1 }, playerConfigApi: { minimum: 1, maximum: 1 }, compiledFeatures: ['web-single-threaded'], capabilities: [], buildFlavor: 'release', packageAccessModes: ['web-fetch'], files: entries, runtimeDependencies: [{ path: 'player.data', kind: 'asset' }], artifacts: { archive: 'web.zip', symbols: 'web-symbols.zip', sbom: 'SBOM.cdx.json', notices: 'THIRD_PARTY_NOTICES.txt' }, provenance: { provider: 'local', source: 'test' }, host: { assembly: 'any', requiresToolchain: false, tools: [] } };
    const descriptorData = Buffer.from(JSON.stringify(descriptor)); fs.writeFileSync(path.join(templateRoot, 'template.json'), descriptorData);
    fs.writeFileSync(path.join(templateRoot, '.noveltea-template.json'), JSON.stringify({ format: 'noveltea.template-registry', formatVersion: 1, templateId: 'web-wasm32', buildId: 'build-1', descriptorSha256: sha(descriptorData), archiveSha256: 'a'.repeat(64), installedAt: new Date().toISOString(), origin: 'test', trust: 'local-untrusted', verified: true }));
    const webRequest: PlatformStageRequest = { ...request, operationId: 'web', templateToken, outputDirectory: path.join(root, 'web-out'), profile: { format: PLATFORM_EXPORT_PROFILE_FORMAT, formatVersion: 1, id: 'web', label: 'Web', target: 'web', architecture: 'wasm32', packageAccess: 'web-fetch', buildFlavor: 'release', compression: 'default', includeDebugSymbols: false, capabilityOverrides: [], web: { artifact: 'directory-zip', threaded: false, pwa: true, display: 'standalone', basePath: '/games/tea/', serviceWorker: 'offline' } }, identity: { ...request.identity, shortName: 'Tea', themeColor: '#112233', backgroundColor: '#000000' } };
    const result = await stagePlatformExport(webRequest);
    expect(result.success).toBe(true); expect(result.archivePath && fs.existsSync(result.archivePath)).toBe(true);
    const names = fs.readdirSync(webRequest.outputDirectory); expect(names.some((name) => /^player\.[0-9a-f]{16}\.js$/.test(name))).toBe(true); expect(names.some((name) => /^game\.[0-9a-f]{16}\.ntpkg$/.test(name))).toBe(true);
    expect(names.some((name) => /^player\.[0-9a-f]{16}\.data$/.test(name))).toBe(true);
    const player = JSON.parse(fs.readFileSync(path.join(webRequest.outputDirectory, 'player.json'), 'utf8')); expect(player.package.path).toMatch(/^game\.[0-9a-f]{16}\.ntpkg$/);
    const manifest = JSON.parse(fs.readFileSync(path.join(webRequest.outputDirectory, 'manifest.webmanifest'), 'utf8')); expect(manifest.start_url).toBe('/games/tea/'); expect(manifest.id).toBe('/com.example.game'); expect(manifest.icons.every((icon: { src: string }) => /\.[0-9a-f]{16}\.png$/.test(icon.src))).toBe(true);
    const worker = fs.readFileSync(path.join(webRequest.outputDirectory, 'service-worker.js'), 'utf8'); expect(worker).toContain('noveltea-com.example.game-');
    expect(fs.readFileSync(path.join(webRequest.outputDirectory, 'DEPLOYMENT.md'), 'utf8')).toContain('Cross-origin isolation: not required');
    expect(result.webMetrics?.uncompressedPackageBytes).toBeGreaterThan(0);
  });

  it('finalizes a Windows GUI player and publishes symbols separately', async () => {
    const { root, request } = await fixture();
    const registry = path.join(root, 'windows-registry'); configureTemplateRegistryRoot(registry);
    const templateToken = 'windows-x64/build-1'; const templateRoot = templateRootForToken(templateToken); fs.mkdirSync(path.join(templateRoot, 'bin'), { recursive: true });
    const executable = ResEdit.NtExecutable.createEmpty(false, false); fs.writeFileSync(path.join(templateRoot, 'bin/player.exe'), Buffer.from(executable.generate()));
    fs.writeFileSync(path.join(templateRoot, 'bin/runtime.dll'), 'declared dependency'); fs.writeFileSync(path.join(templateRoot, 'player.pdb'), 'symbols');
    const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
    const entries = [
      { path: 'bin/player.exe', role: 'player' },
      { path: 'bin/runtime.dll', role: 'native-dependency' },
      { path: 'player.pdb', role: 'symbol' },
    ].map(({ path: file, role }) => { const data = fs.readFileSync(path.join(templateRoot, file)); return { path: file, role, size: data.length, mode: fs.statSync(path.join(templateRoot, file)).mode & 0o777, sha256: sha(data) }; });
    const descriptor = { format: TEMPLATE_DESCRIPTOR_FORMAT, formatVersion: 1, templateId: 'windows-x64', buildId: 'build-1', engineVersion: '1', platform: 'windows', architecture: 'x64', minimumPlatformVersion: '10', graphicsBackends: ['direct3d11'], shaderVariants: ['glsl-120'], runtimePackageApi: { minimum: 1, maximum: 1 }, playerConfigApi: { minimum: 1, maximum: 1 }, compiledFeatures: [], capabilities: [], buildFlavor: 'release', packageAccessModes: ['sidecar'], files: entries, runtimeDependencies: [{ path: 'bin/runtime.dll', kind: 'library' }], windowsImports: ['kernel32.dll', 'runtime.dll'], artifacts: { archive: 'windows.zip', symbols: 'windows-symbols.zip', sbom: 'SBOM.cdx.json', notices: 'THIRD_PARTY_NOTICES.txt' }, provenance: { provider: 'local', source: 'test' }, host: { assembly: 'any', requiresToolchain: false, tools: [] } };
    const descriptorData = Buffer.from(JSON.stringify(descriptor)); fs.writeFileSync(path.join(templateRoot, 'template.json'), descriptorData);
    fs.writeFileSync(path.join(templateRoot, '.noveltea-template.json'), JSON.stringify({ format: 'noveltea.template-registry', formatVersion: 1, templateId: 'windows-x64', buildId: 'build-1', descriptorSha256: sha(descriptorData), archiveSha256: 'a'.repeat(64), installedAt: new Date().toISOString(), origin: 'test', trust: 'local-untrusted', verified: true }));
    const windowsRequest: PlatformStageRequest = { ...request, operationId: 'windows', templateToken, outputDirectory: path.join(root, 'windows out Ω'), profile: { format: PLATFORM_EXPORT_PROFILE_FORMAT, formatVersion: 1, id: 'windows', label: 'Windows', target: 'windows', architecture: 'x64', packageAccess: 'sidecar', buildFlavor: 'release', compression: 'default', includeDebugSymbols: true, capabilityOverrides: [], desktop: { artifact: 'zip', executableName: 'Tea Game' } }, identity: { ...request.identity, displayName: 'Tea Game', versionName: '1.2.3' }, windowsSigning: { command: process.execPath, args: ['-e', "require('fs').appendFileSync(process.argv[1], 'SIGNED')", '{executable}'] } };
    const result = await stagePlatformExport(windowsRequest);
    expect(result.success).toBe(true); expect(result.archivePath && fs.existsSync(result.archivePath)).toBe(true); expect(result.symbolArchivePath && fs.existsSync(result.symbolArchivePath)).toBe(true);
    expect(fs.existsSync(path.join(windowsRequest.outputDirectory, 'Tea Game.exe'))).toBe(true); expect(fs.existsSync(path.join(windowsRequest.outputDirectory, 'player.pdb'))).toBe(false);
    const outputExe = ResEdit.NtExecutable.from(fs.readFileSync(path.join(windowsRequest.outputDirectory, 'Tea Game.exe'))); const resources = ResEdit.NtExecutableResource.from(outputExe);
    expect(outputExe.newHeader.optionalHeader.subsystem).toBe(2);
    expect(ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries).length).toBeGreaterThan(0);
    expect(ResEdit.Resource.VersionInfo.fromEntries(resources.entries)[0]?.getStringValues({ lang: 1033, codepage: 1200 }).ProductName).toBe('Tea Game');
    expect(resources.getResourceEntriesAsString(24, 1)[0]?.[1]).toContain('longPathAware');
    expect(fs.readFileSync(path.join(windowsRequest.outputDirectory, 'Tea Game.exe')).subarray(-6).toString()).toBe('SIGNED');
    const metadata = JSON.parse(fs.readFileSync(path.join(windowsRequest.outputDirectory, 'WINDOWS_METADATA.json'), 'utf8')); expect(metadata.resourceMutationComplete).toBe(true); expect(metadata.signingCommandHook.configured).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(windowsRequest.outputDirectory, 'export-manifest.json'), 'utf8')); const executableEntry = manifest.files.find((entry: { path: string }) => entry.path === 'Tea Game.exe');
    expect(executableEntry.sha256).toBe(createHash('sha256').update(fs.readFileSync(path.join(windowsRequest.outputDirectory, 'Tea Game.exe'))).digest('hex'));
  });
});

const windowsTemplateArchive = process.env.NOVELTEA_WINDOWS_TEMPLATE_ARCHIVE;
const windowsRuntimePackage = process.env.NOVELTEA_WINDOWS_RUNTIME_PACKAGE;

describe.runIf(process.platform === 'win32' && !!windowsTemplateArchive && !!windowsRuntimePackage)(
  'Windows portable export native smoke',
  () => {
    it('launches the real finalized export from Unicode/space paths and an unrelated working directory', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NovelTea Windows export 茶 '));
      roots.push(root);
      const registryRoot = path.join(root, 'template registry');
      configureTemplateRegistryRoot(registryRoot);
      const installed = await installPlayerTemplate({
        archivePath: windowsTemplateArchive!,
        origin: 'release-ci-smoke',
      });
      expect(installed.success, installed.diagnostics.map((item) => item.message).join('\n')).toBe(true);
      expect(installed.entry).toBeDefined();

      const iconSourcePath = path.join(root, 'icon source.png');
      await sharp({
        create: { width: 1024, height: 1024, channels: 4, background: '#553399' },
      }).png().toFile(iconSourcePath);
      const saveNamespace = `com.noveltea.windows-smoke-${Date.now()}`;
      const outputDirectory = path.join(root, 'Exported Game 茶');
      const result = await stagePlatformExport({
        operationId: 'windows-native-smoke',
        profile: {
          format: PLATFORM_EXPORT_PROFILE_FORMAT,
          formatVersion: 1,
          id: 'windows-native-smoke',
          label: 'Windows native smoke',
          target: 'windows',
          architecture: 'x64',
          packageAccess: 'sidecar',
          buildFlavor: 'release',
          compression: 'default',
          includeDebugSymbols: true,
          capabilityOverrides: [],
          desktop: { artifact: 'zip', executableName: 'Tea Game 茶' },
        },
        templateToken: `${installed.entry!.templateId}/${installed.entry!.buildId}`,
        outputDirectory,
        packagePath: windowsRuntimePackage!,
        iconSourcePath,
        runtimePackageReadiness: { validated: true, blockingDiagnosticCount: 0 },
        identity: {
          displayName: 'Tea Game 茶',
          applicationId: 'com.noveltea.windows-smoke',
          saveNamespace,
          versionName: '1.0.0',
          defaultLocale: 'en-US',
        },
        display: {
          aspectRatio: { width: 16, height: 9 },
          orientation: 'landscape',
          barColor: '#000000',
        },
        runtimePackageApi: 1,
      });
      expect(result.success, result.diagnostics.map((item) => item.message).join('\n')).toBe(true);
      expect(result.archivePath && fs.existsSync(result.archivePath)).toBe(true);
      expect(result.symbolArchivePath && fs.existsSync(result.symbolArchivePath)).toBe(true);

      const executable = path.join(outputDirectory, 'Tea Game 茶.exe');
      const unrelatedWorkingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'NovelTea unrelated cwd '));
      roots.push(unrelatedWorkingDirectory);
      const child = spawn(executable, [], {
        cwd: unrelatedWorkingDirectory,
        windowsHide: false,
        stdio: 'ignore',
      });
      const logPath = path.join(process.env.APPDATA!, 'NovelTea', saveNamespace, 'logs', 'player.log');
      try {
        const deadline = Date.now() + 20_000;
        let log = '';
        while (Date.now() < deadline) {
          if (fs.existsSync(logPath)) {
            log = fs.readFileSync(logPath, 'utf8');
            if (log.includes('NovelTea player starting')) break;
          }
          if (child.exitCode !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(log).toContain('NovelTea player starting Tea Game 茶 1.0.0');
        expect(log).not.toContain('Engine initialization failed');
        expect(child.exitCode).toBeNull();
      } finally {
        if (child.exitCode === null) {
          child.kill();
          await Promise.race([
            new Promise<void>((resolve) => child.once('exit', () => resolve())),
            new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
          ]);
        }
        fs.rmSync(path.join(process.env.APPDATA!, 'NovelTea', saveNamespace), { recursive: true, force: true });
      }
    }, 30_000);
  },
);
