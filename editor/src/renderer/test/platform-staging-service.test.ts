import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { stagePlatformExport } from '../../main/services/platform-staging-service';
import { PLATFORM_EXPORT_PROFILE_FORMAT, TEMPLATE_DESCRIPTOR_FORMAT, type PlatformStageRequest } from '../../shared/project-schema/platform-export-contracts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-stage-')); roots.push(root);
  const templateRoot = path.join(root, 'template'); fs.mkdirSync(path.join(templateRoot, 'bin'), { recursive: true }); fs.writeFileSync(path.join(templateRoot, 'bin/player'), 'player');
  fs.writeFileSync(path.join(templateRoot, 'template.json'), JSON.stringify({ format: TEMPLATE_DESCRIPTOR_FORMAT, formatVersion: 1, templateId: 'linux-x64', buildId: 'build-1', platform: 'linux', architecture: 'x64', minimumPlatformVersion: 'provisional', graphicsBackends: ['opengl'], shaderVariants: ['glsl-120'], runtimePackageApi: { minimum: 1, maximum: 1 }, compiledFeatures: [], capabilities: [], buildFlavor: 'release', runtimeDependencies: [], host: { assembly: 'any', requiresToolchain: false, tools: [] } }));
  const packagePath = path.join(root, 'game.ntpkg'); fs.writeFileSync(packagePath, 'package'); const iconSourcePath = path.join(root, 'icon.png'); await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#ff0000' } }).png().toFile(iconSourcePath);
  const request: PlatformStageRequest = { operationId: 'one', profile: { format: PLATFORM_EXPORT_PROFILE_FORMAT, formatVersion: 1, id: 'linux', label: 'Linux', target: 'linux', architecture: 'x64', packageAccess: 'sidecar', buildFlavor: 'release', compression: 'default', includeDebugSymbols: false, capabilityOverrides: [], desktop: { artifact: 'tar', executableName: 'game' } }, templateRoot, outputDirectory: path.join(root, 'out'), packagePath, iconSourcePath, identity: { displayName: 'Game', applicationId: 'com.example.game', saveNamespace: 'com.example.game', versionName: '1' }, display: { aspectRatio: { width: 16, height: 9 }, orientation: 'landscape', barColor: '#000000' }, runtimePackageApi: 1 };
  return { root, request };
}

describe('platform staging service', () => {
  it('builds deterministic provenance and replaces a previous output', async () => {
    const { request } = await fixture(); fs.mkdirSync(request.outputDirectory); fs.writeFileSync(path.join(request.outputDirectory, 'old'), 'old');
    const first = await stagePlatformExport(request); expect(first.success).toBe(true); expect(fs.existsSync(path.join(request.outputDirectory, 'old'))).toBe(false);
    expect(first.manifest?.files.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
    const second = await stagePlatformExport({ ...request, operationId: 'two' }); expect(second.manifest).toEqual(first.manifest);
    expect(JSON.parse(fs.readFileSync(path.join(request.outputDirectory, 'export-manifest.json'), 'utf8')).deployment.applicationId).toBe('com.example.game');
  });

  it('rejects sandbox content without touching previous output', async () => {
    const { request } = await fixture(); fs.mkdirSync(path.join(request.templateRoot, 'sandbox')); fs.writeFileSync(path.join(request.templateRoot, 'sandbox/demo.txt'), 'demo'); fs.mkdirSync(request.outputDirectory); fs.writeFileSync(path.join(request.outputDirectory, 'keep'), 'yes');
    const result = await stagePlatformExport(request); expect(result.success).toBe(false); expect(result.diagnostics.some((item) => item.code === 'sandbox-content')).toBe(true); expect(fs.readFileSync(path.join(request.outputDirectory, 'keep'), 'utf8')).toBe('yes');
  });
});
