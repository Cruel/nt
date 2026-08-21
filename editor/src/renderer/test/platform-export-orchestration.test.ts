import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { exportProjectToPlatform } from '../../main/services/platform-export-orchestration-service';
import {
  configureTemplateRegistryRoot,
  templateRootForToken,
} from '../../main/services/template-registry-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { runtimeExportProfileForPlatform } from '../../shared/project-schema/authoring-export';
import { prepareRuntimeArtifactForTest } from './runtime-artifact-test-helpers';
import {
  defaultPlatformExportProfile,
  parseProjectPlatformExportSettings,
} from '../../shared/project-schema/platform-export-contracts';
import { createPlatformExportValidationDiagnostic } from '../../shared/project-schema/project-validation';

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
  const runtimeProfile = runtimeExportProfileForPlatform(project, profile.target);
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
  const player = fs.readFileSync(playerPath);
  const descriptor = {
    format: 'noveltea.player-template',
    formatVersion: 1,
    templateId: 'linux-x64-release',
    buildId: 'build-1',
    engineVersion: '1',
    platform: 'linux',
    architecture: 'x64',
    minimumPlatformVersion: 'glibc 2.39',
    graphicsBackends: ['opengl'],
    shaderVariants,
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
        mode: fs.statSync(playerPath).mode & 0o777,
        sha256: createHash('sha256').update(player).digest('hex'),
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
  const descriptorText = JSON.stringify(descriptor);
  fs.writeFileSync(path.join(templateRoot, 'template.json'), descriptorText);
  fs.writeFileSync(
    path.join(templateRoot, '.noveltea-template.json'),
    JSON.stringify({
      format: 'noveltea.template-registry',
      formatVersion: 1,
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

describe('platform export main-process trust boundary', () => {
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
    const result = await exportProjectToPlatform({
      operationId: 'stale-fingerprint',
      project,
      projectRoot: '/project',
      profileId: preparation.profile.id,
      outputDirectory: '/dist',
      preparedRuntimeArtifact: preparation.runtime,
    });
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
    const result = await exportProjectToPlatform({
      operationId: 'diagnostic-contract',
      project,
      projectRoot: '/project',
      profileId: preparation.profile.id,
      outputDirectory: '/dist',
      preparedRuntimeArtifact: {
        ...preparation.runtime,
        diagnostics: [...preparation.runtime.diagnostics, blocker],
      },
    });
    expect(result.diagnostics).toContainEqual(blocker);
  });

  it('requires signing configuration only when signing is explicitly requested', async () => {
    const project = exportableProject();
    const preparation = await prepared(project);
    const result = await exportProjectToPlatform({
      operationId: 'signing-request',
      project,
      projectRoot: '/project',
      profileId: preparation.profile.id,
      outputDirectory: '/dist',
      sign: true,
      preparedRuntimeArtifact: preparation.runtime,
    });

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
    const templateToken = installLinuxTemplate(root, ['essl-100']);

    const result = await exportProjectToPlatform({
      operationId: 'explicit-incompatible-template',
      project,
      projectRoot: '/project',
      profileId: preparation.profile.id,
      outputDirectory: path.join(root, 'output'),
      templateToken,
      allowUntrustedTemplate: true,
      checkOnly: true,
      preparedRuntimeArtifact: preparation.runtime,
    });

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
    const templateToken = installLinuxTemplate(root, ['glsl-120']);
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
    );

    expect(result.success).toBe(false);
    expect(actualPackagePath).not.toBe(adjacentPackage);
    expect(fs.readFileSync(adjacentPackage, 'utf8')).toBe('keep');
  });
});
