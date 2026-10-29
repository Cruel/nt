import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { exportProjectToPlatform } from '../../main/services/platform-export-orchestration-service';
import { exportPackage } from '../../main/services/native-runtime-tool-service';
import {
  configureTemplateRegistryRoot,
  templateRootForToken,
} from '../../main/services/template-registry-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { runtimeExportProfileForPlatform } from '../../shared/project-schema/authoring-export';
import { derivedPlatformCapabilities } from '../../shared/project-schema/platform-deployment';
import { prepareRuntimeArtifactForTest } from './runtime-artifact-test-helpers';
import {
  defaultPlatformExportProfile,
  parseProjectPlatformExportSettings,
} from '../../shared/project-schema/platform-export-contracts';
import { createPlatformExportValidationDiagnostic } from '../../shared/project-schema/project-diagnostic-projection';
import { createTemplateLicenseFixture } from './player-template-license-fixture';

function exportableProject() {
  const project = createAuthoringProject({ name: 'Main Trust Boundary' });
  const room = defaultRoomData('Room');
  room.description.source = { kind: 'inline', text: 'Ready.' };
  project.rooms.room = { id: 'room', label: 'Room', data: room };
  project.entrypoint = { kind: 'room', id: 'room' };
  project.assets.icon = {
    id: 'icon',
    label: 'Icon',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/icon.png' },
      aliases: [],
      imageMetadata: { width: 1024, height: 1024, hasAlpha: true, orientation: 1 },
    },
  };
  project.settings.app = {
    ...(project.settings.app as Record<string, unknown>),
    icon: { $ref: { collection: 'assets', id: 'icon' } },
  } as never;
  const profile = defaultPlatformExportProfile('linux');
  project.export.profiles = [profile];
  return project;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function prepared(project: ReturnType<typeof exportableProject>, projectRoot = '/project') {
  const profile = parseProjectPlatformExportSettings({ profiles: project.export.profiles })
    .profiles[0]!;
  const runtimeProfile = runtimeExportProfileForPlatform(
    project,
    profile.target,
    profile.localization,
  );
  const result = await prepareRuntimeArtifactForTest(project, {
    projectRoot,
    profile: runtimeProfile,
  });
  expect(result.status).toBe('prepared');
  if (result.status !== 'prepared') throw new Error('Expected a Prepared Runtime Artifact.');
  return {
    profile,
    runtime: result.artifact,
  };
}

function installLinuxTemplate(root: string, shaderVariants: string[]) {
  const registry = path.join(root, 'registry');
  configureTemplateRegistryRoot(registry);
  const templateRoot = templateRootForToken('linux-x64-release/build-1');
  fs.mkdirSync(path.join(templateRoot, 'bin'), { recursive: true });
  const playerPath = path.join(templateRoot, 'bin/player');
  fs.writeFileSync(playerPath, 'player', { mode: 0o755 });
  const licenseFixture = createTemplateLicenseFixture(templateRoot);
  const player = fs.readFileSync(playerPath);
  const descriptor = {
    format: 'noveltea.player-template',
    formatVersion: 1,
    templateId: 'linux-x64-release',
    buildId: 'build-1',
    engineVersion: '1',
    platform: 'linux',
    architecture: 'x64',
    minimumPlatformVersion: 'glibc 2.28',
    graphicsBackends: ['opengl'],
    shaderVariants,
    compiledProjectFormatVersion: 1,
    playerRuntimeApiVersion: 1,
    compiledFeatures: ['lua'],
    capabilities: derivedPlatformCapabilities('linux'),
    buildFlavor: 'release',
    playerVariant: 'standard',
    packageAccessModes: ['sidecar'],
    files: [
      {
        path: 'bin/player',
        size: player.length,
        mode: fs.statSync(playerPath).mode & 0o777,
        sha256: createHash('sha256').update(player).digest('hex'),
      },
      ...licenseFixture.files,
    ],
    runtimeDependencies: [
      { path: 'bin/player', kind: 'library' },
      ...licenseFixture.runtimeDependencies,
    ],
    artifacts: {
      archive: 'template.tar.gz',
      symbols: 'symbols.tar.gz',
      sbom: 'SBOM.cdx.json',
      notices: 'licenses/index.json',
    },
    provenance: { provider: 'local', source: 'test' },
    host: { assembly: 'any', requiresToolchain: false, tools: [] },
  };
  const descriptorText = JSON.stringify(descriptor);
  fs.writeFileSync(path.join(templateRoot, 'template.json'), descriptorText);
  fs.writeFileSync(
    path.join(templateRoot, '.noveltea-template.json'),
    JSON.stringify({
      format: 'noveltea.template-registry',
      templateId: descriptor.templateId,
      buildId: descriptor.buildId,
      descriptorSha256: createHash('sha256').update(descriptorText).digest('hex'),
      archiveSha256: 'a'.repeat(64),
      installedAt: '2026-08-12T00:00:00.000Z',
      origin: 'test',
      trust: 'local-untrusted',
      verified: true,
    }),
  );
  return 'linux-x64-release/build-1';
}

function installWebTemplate(root: string) {
  configureTemplateRegistryRoot(path.join(root, 'web-registry'));
  const token = 'web-wasm32-release/build-1';
  const templateRoot = templateRootForToken(token);
  fs.mkdirSync(templateRoot, { recursive: true });
  fs.writeFileSync(path.join(templateRoot, 'player.js'), 'console.log("native web player")');
  fs.writeFileSync(path.join(templateRoot, 'player.wasm'), Buffer.from([0, 97, 115, 109]));
  fs.writeFileSync(path.join(templateRoot, 'player.data'), 'system data');
  const licenses = createTemplateLicenseFixture(templateRoot);
  const files = ['player.js', 'player.wasm', 'player.data'].map((name) => {
    const data = fs.readFileSync(path.join(templateRoot, name));
    return {
      path: name,
      size: data.length,
      mode: fs.statSync(path.join(templateRoot, name)).mode & 0o777,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  });
  const descriptor = {
    format: 'noveltea.player-template',
    formatVersion: 1,
    templateId: 'web-wasm32-release',
    buildId: 'build-1',
    engineVersion: '1',
    platform: 'web',
    architecture: 'wasm32',
    minimumPlatformVersion: 'modern',
    graphicsBackends: ['webgl2'],
    shaderVariants: ['essl-300'],
    compiledProjectFormatVersion: 1,
    playerRuntimeApiVersion: 1,
    compiledFeatures: ['web-single-threaded'],
    capabilities: derivedPlatformCapabilities('web'),
    buildFlavor: 'release',
    playerVariant: 'standard',
    packageAccessModes: ['web-fetch'],
    files: [...files, ...licenses.files],
    runtimeDependencies: [{ path: 'player.data', kind: 'asset' }, ...licenses.runtimeDependencies],
    artifacts: {
      archive: 'web.zip',
      symbols: 'web-symbols.zip',
      sbom: 'SBOM.cdx.json',
      notices: 'licenses/index.json',
    },
    provenance: { provider: 'local', source: 'test' },
    host: { assembly: 'any', requiresToolchain: false, tools: [] },
  };
  const descriptorText = JSON.stringify(descriptor);
  fs.writeFileSync(path.join(templateRoot, 'template.json'), descriptorText);
  fs.writeFileSync(
    path.join(templateRoot, '.noveltea-template.json'),
    JSON.stringify({
      format: 'noveltea.template-registry',
      templateId: descriptor.templateId,
      buildId: descriptor.buildId,
      descriptorSha256: createHash('sha256').update(descriptorText).digest('hex'),
      archiveSha256: 'a'.repeat(64),
      installedAt: '2026-08-12T00:00:00.000Z',
      origin: 'test',
      trust: 'local-untrusted',
      verified: true,
    }),
  );
  return token;
}

describe('platform export main-process trust boundary', () => {
  it.skipIf(!process.env.NOVELTEA_AUTHORING_NODE_ADDON)(
    'publishes real native-compiled Web output from admitted sources and preserves it on late drift',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-native-web-publish-'));
      temporaryRoots.push(root);
      const projectRoot = path.join(root, 'project');
      fs.mkdirSync(path.join(projectRoot, 'assets'), { recursive: true });
      await sharp({
        create: { width: 1024, height: 1024, channels: 4, background: '#224466' },
      })
        .png()
        .toFile(path.join(projectRoot, 'assets/icon.png'));
      const project = exportableProject();
      const webProfile = defaultPlatformExportProfile('web');
      if (webProfile.target !== 'web') throw new Error('Expected a Web profile.');
      project.export.profiles = [{ ...webProfile, web: { ...webProfile.web, threaded: false } }];
      const templateToken = installWebTemplate(root);
      const outputDirectory = path.join(root, 'dist', 'native-web');
      const request = {
        operationId: 'native-web-publish',
        project,
        projectRoot,
        profileId: project.export.profiles[0]!.id,
        outputDirectory,
        templateToken,
        allowUntrustedTemplate: true,
      };
      const nativeTools = {
        compileShaders: vi.fn(async () => ({
          ok: true,
          success: true,
          diagnostics: [],
          outputs: [],
        })),
        exportPackage: vi.fn(async (compiled: unknown, output: string, options: unknown) =>
          exportPackage(compiled as never, output, options as never),
        ),
      };
      const admission = {
        project,
        diagnostics: [],
        runtimeAssetReferences: ['icon'],
      };
      const published = await exportProjectToPlatform(
        request,
        undefined,
        nativeTools as never,
        async () => null,
        undefined,
        undefined,
        admission,
      );
      expect(published, JSON.stringify(published.diagnostics)).toMatchObject({ success: true });
      expect(nativeTools.exportPackage).toHaveBeenCalledOnce();
      expect(fs.existsSync(`${outputDirectory}.zip`)).toBe(true);
      expect(fs.readdirSync(outputDirectory)).toEqual(
        expect.arrayContaining(['index.html', 'player.json', 'manifest.webmanifest']),
      );
      const player = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'player.json'), 'utf8'));
      const compiledPackage = path.join(outputDirectory, player.package.path);
      expect(fs.statSync(compiledPackage).size).toBeGreaterThan(0);
      const firstArchive = fs.readFileSync(`${outputDirectory}.zip`);
      const firstPackage = fs.readFileSync(compiledPackage);
      const drift = await exportProjectToPlatform(
        { ...request, operationId: 'native-web-drift', force: true },
        undefined,
        nativeTools as never,
        async () => 'The CLI changed an admitted Project source during export.',
        undefined,
        undefined,
        admission,
      );
      expect(drift.success).toBe(false);
      expect(drift.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'platform-export-input-drift' }),
      );
      expect(fs.readFileSync(`${outputDirectory}.zip`)).toEqual(firstArchive);
      expect(fs.readFileSync(compiledPackage)).toEqual(firstPackage);
      expect(fs.readdirSync(path.join(root, 'dist'))).toEqual(['native-web', 'native-web.zip']);
    },
    120_000,
  );
  it('accepts trusted admitted validation separately from the parsed export request', async () => {
    const project = exportableProject();
    const preparation = await prepared(project);
    const issue = createPlatformExportValidationDiagnostic({
      severity: 'error',
      code: 'platform-export.admission-reuse-proof',
      path: '/entrypoint',
      message: 'Admission evidence was consumed.',
    });
    const request = {
      operationId: 'admission-evidence',
      project,
      projectRoot: '/project',
      profileId: preparation.profile.id,
      outputDirectory: '/dist',
      preparedRuntimeArtifact: preparation.runtime,
    };
    const result = await exportProjectToPlatform(
      request,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { project, diagnostics: [issue] },
    );
    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(issue);

    // Evidence associated with another Project instance must not be used.
    const mismatch = await exportProjectToPlatform(
      request,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { project: structuredClone(project), diagnostics: [issue] },
    );
    expect(mismatch.diagnostics).not.toContainEqual(issue);
    expect(mismatch.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'platform-export-admission-mismatch' }),
    );
  });

  it('uses native-admitted downstream preparation for editor platform preflight and rejects source drift', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-native-platform-preflight-'));
    temporaryRoots.push(root);
    const projectRoot = path.join(root, 'project');
    fs.mkdirSync(path.join(projectRoot, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'assets/icon.png'), 'icon');
    const project = exportableProject();
    const templateToken = installLinuxTemplate(root, ['glsl-330']);
    {
      const nativeTools = {
        compileShaders: vi.fn(async () => ({
          ok: true,
          success: true,
          diagnostics: [],
          outputs: [],
        })),
        exportPackage: vi.fn(async () => ({ ok: true, success: true, diagnostics: [] })),
      };
      const beforePublish = vi.fn(async () => null as string | null);
      const request = {
        project,
        projectRoot,
        profileId: project.export.profiles[0]!.id,
        outputDirectory: path.join(root, 'dist/game'),
        templateToken,
        allowUntrustedTemplate: true,
        checkOnly: true,
      };
      const admitted = {
        project,
        diagnostics: [],
        runtimeAssetReferences: ['icon'],
      };
      const result = await exportProjectToPlatform(
        request,
        undefined,
        nativeTools as never,
        beforePublish,
        undefined,
        undefined,
        admitted,
      );
      expect(result, JSON.stringify(result.diagnostics)).toMatchObject({ success: true });
      expect(beforePublish).toHaveBeenCalledOnce();

      beforePublish.mockResolvedValueOnce('CLI changed the admitted sources.');
      const drift = await exportProjectToPlatform(
        request,
        undefined,
        nativeTools as never,
        beforePublish,
        undefined,
        undefined,
        admitted,
      );
      expect(drift.success).toBe(false);
      expect(drift.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'export-source-changed' }),
      );
      expect(fs.existsSync(path.join(root, 'dist/game'))).toBe(false);
    }
  });
  it('rejects malformed serialized requests before orchestration', async () => {
    const result = await exportProjectToPlatform({
      profileId: 'linux-release',
      outputDirectory: '',
    } as never);
    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'platform-export-request-invalid',
        path: '/request',
        ownerPaths: ['/request'],
        boundaries: ['platform-export'],
      }),
    );
  });

  it('rejects a prepared package fingerprint from an older project revision', async () => {
    const project = exportableProject();
    const preparation = await prepared(project);
    project.project.name = 'Changed after readiness';
    const result = await exportProjectToPlatform(
      {
        operationId: 'stale-fingerprint',
        project,
        projectRoot: '/project',
        profileId: preparation.profile.id,
        outputDirectory: '/dist',
        preparedRuntimeArtifact: preparation.runtime,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { project, diagnostics: [], runtimeAssetReferences: ['icon'] },
    );
    expect(result.success).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'runtime-artifact.evidence.rejected',
        path: '/artifact/sourceFingerprint',
        ownerPaths: ['/artifact/sourceFingerprint'],
        severity: 'error',
        boundaries: ['runtime-package', 'platform-export'],
      }),
    ]);
  });

  it('preserves prepared blocker contracts across the IPC orchestration boundary', async () => {
    const project = exportableProject();
    const preparation = await prepared(project);
    const blocker = createPlatformExportValidationDiagnostic({
      code: 'platform-export.contract-test',
      severity: 'error',
      category: 'Contract test',
      path: '/settings/app/applicationId',
      message: 'Contract test blocker.',
      ownerPaths: ['/settings/app/applicationId'],
    });
    const result = await exportProjectToPlatform(
      {
        operationId: 'diagnostic-contract',
        project,
        projectRoot: '/project',
        profileId: preparation.profile.id,
        outputDirectory: '/dist',
        preparedRuntimeArtifact: {
          ...preparation.runtime,
          diagnostics: [...preparation.runtime.diagnostics, blocker],
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { project, diagnostics: [], runtimeAssetReferences: ['icon'] },
    );
    expect(result.diagnostics).toContainEqual(blocker);
  });

  it('requires signing configuration only when signing is explicitly requested', async () => {
    const project = exportableProject();
    const preparation = await prepared(project);
    const result = await exportProjectToPlatform(
      {
        operationId: 'signing-request',
        project,
        projectRoot: '/project',
        profileId: preparation.profile.id,
        outputDirectory: '/dist',
        sign: true,
        preparedRuntimeArtifact: preparation.runtime,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { project, diagnostics: [], runtimeAssetReferences: ['icon'] },
    );

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'platform-signing-required', path: '/sign' }),
    );
  });

  it('rejects an explicitly selected template missing a required shader variant', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-platform-explicit-template-'));
    temporaryRoots.push(root);
    const project = exportableProject();
    const preparation = await prepared(project);
    const templateToken = installLinuxTemplate(root, ['essl-300']);

    const result = await exportProjectToPlatform(
      {
        operationId: 'explicit-incompatible-template',
        project,
        projectRoot: '/project',
        profileId: preparation.profile.id,
        outputDirectory: path.join(root, 'output'),
        templateToken,
        allowUntrustedTemplate: true,
        checkOnly: true,
        preparedRuntimeArtifact: preparation.runtime,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { project, diagnostics: [], runtimeAssetReferences: ['icon'] },
    );

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'template-shader-variant-mismatch',
        path: '/template/shaderVariants',
      }),
    );
  });

  it('keeps an existing adjacent package untouched when export fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-platform-package-temp-'));
    temporaryRoots.push(root);
    const projectRoot = path.join(root, 'project');
    fs.mkdirSync(path.join(projectRoot, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'assets/icon.png'), 'icon');
    const project = exportableProject();
    const preparation = await prepared(project, projectRoot);
    const templateToken = installLinuxTemplate(root, ['glsl-330']);
    const outputDirectory = path.join(root, 'dist/game');
    fs.mkdirSync(path.dirname(outputDirectory), { recursive: true });
    const adjacentPackage = `${outputDirectory}.game.ntpkg`;
    fs.writeFileSync(adjacentPackage, 'keep');
    let actualPackagePath = '';

    const result = await exportProjectToPlatform(
      {
        operationId: 'private-package-temp',
        project,
        projectRoot,
        profileId: preparation.profile.id,
        outputDirectory,
        templateToken,
        allowUntrustedTemplate: true,
        preparedRuntimeArtifact: preparation.runtime,
      },
      undefined,
      {
        async compileShaders() {
          throw new Error('Shader compilation should not run for a prepared export.');
        },
        async exportPackage(_compiledProject: unknown, outputPath: string) {
          actualPackagePath = outputPath;
          return { success: false, diagnostics: [] };
        },
      } as never,
      undefined,
      undefined,
      undefined,
      { project, diagnostics: [], runtimeAssetReferences: ['icon'] },
    );

    expect(result.success).toBe(false);
    expect(actualPackagePath).not.toBe(adjacentPackage);
    expect(fs.readFileSync(adjacentPackage, 'utf8')).toBe('keep');
  });
});
