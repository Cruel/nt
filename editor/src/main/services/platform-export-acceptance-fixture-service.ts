import { createHash } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { parsePlatformExportProfile, type ExportPlatform, type PlatformExportProfile } from '../../shared/project-schema/platform-export-contracts';
import { parseRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  createPlatformExportAcceptanceFixture,
  PLATFORM_EXPORT_ACCEPTANCE_FIXTURE_REVISION,
} from '../../shared/project-schema/platform-export-acceptance-fixture';

export interface MaterializePlatformExportAcceptanceFixtureOptions {
  root: string;
  target: ExportPlatform;
  architecture?: 'x64' | 'arm64' | 'wasm32' | 'x86_64';
  buildFlavor?: 'debug' | 'release';
  androidAbi?: 'arm64-v8a' | 'x86_64';
  androidArtifact?: 'apk' | 'aab' | 'both';
  webBasePath?: string;
  contentRevision?: number;
  fontSourcePath: string;
}

export interface MaterializedPlatformExportAcceptanceFixture {
  projectPath: string;
  projectRoot: string;
  profile: PlatformExportProfile;
  fixtureRevision: string;
  projectSha256: string;
  profileSha256: string;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function wavSilence(): Buffer {
  const sampleRate = 8_000;
  const samples = 800;
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function profileFor(options: MaterializePlatformExportAcceptanceFixtureOptions): PlatformExportProfile {
  const flavor = options.buildFlavor ?? 'release';
  if (options.target === 'web') {
    return parsePlatformExportProfile({
      format: 'noveltea.platform-export-profile', formatVersion: 1,
      id: 'canonical-web', label: 'Canonical Web', target: 'web', architecture: 'wasm32',
      packageAccess: 'web-fetch', buildFlavor: flavor, compression: 'default', includeDebugSymbols: false,
      capabilityOverrides: [], web: { artifact: 'directory-zip', threaded: false, pwa: true, display: 'standalone', basePath: options.webBasePath ?? '/', serviceWorker: 'offline' },
    });
  }
  if (options.target === 'android') {
    const abi = options.androidAbi ?? 'x86_64';
    return parsePlatformExportProfile({
      format: 'noveltea.platform-export-profile', formatVersion: 1,
      id: `canonical-android-${flavor}`, label: `Canonical Android ${flavor}`, target: 'android',
      architecture: abi === 'arm64-v8a' ? 'arm64' : 'x86_64', packageAccess: 'android-private-copy',
      buildFlavor: flavor, compression: 'default', includeDebugSymbols: false, capabilityOverrides: [],
      android: { artifact: options.androidArtifact ?? 'apk', abi, minSdk: 24 },
    });
  }
  const architecture = options.architecture ?? (options.target === 'macos' ? 'arm64' : 'x64');
  const packageAccess = options.target === 'macos' ? 'bundle-resource' : 'sidecar';
  const artifact = options.target === 'macos' ? 'app-bundle' : options.target === 'linux' ? 'tar' : 'zip';
  return parsePlatformExportProfile({
    format: 'noveltea.platform-export-profile', formatVersion: 1,
    id: `canonical-${options.target}`, label: `Canonical ${options.target}`, target: options.target,
    architecture, packageAccess, buildFlavor: flavor, compression: 'default', includeDebugSymbols: true,
    capabilityOverrides: [], desktop: { artifact, executableName: options.target === 'windows' ? 'Platform Export Acceptance' : 'platform-export-acceptance' },
  });
}

export async function materializePlatformExportAcceptanceFixture(
  options: MaterializePlatformExportAcceptanceFixtureOptions,
): Promise<MaterializedPlatformExportAcceptanceFixture> {
  const projectRoot = path.resolve(options.root);
  const project = createPlatformExportAcceptanceFixture();
  const contentRevision = options.contentRevision ?? 1;
  project.project.version = `${PLATFORM_EXPORT_ACCEPTANCE_FIXTURE_REVISION}.${contentRevision}`;
  const gallery = project.rooms.gallery;
  if (gallery) {
    const data = parseRoomData(gallery.data);
    if (data && data.description.source.kind === 'inline') data.description.source = { kind: 'inline', text: `Navigation reached the gallery, revision ${contentRevision}.` };
  }
  const profile = profileFor(options);
  const settings = project.settings as Record<string, unknown>;
  settings.export = {
    selectedProfileId: 'runtime-canonical',
    profiles: [{
      id: 'runtime-canonical', label: 'Canonical Runtime Package', kind: 'runtime', outputPath: '',
      includeChecksums: true, stripEditorData: true, stripShaderSources: false,
      compileShadersBeforeExport: true,
      shaderVariants: options.target === 'web' || options.target === 'android' ? ['essl-300'] : ['glsl-120'],
      includeAllProjectAssets: false, includeOnlyReferencedAssets: true, includeTests: false, previewAfterExport: false,
    }],
  };
  settings.platformExport = { selectedProfileId: profile.id, profiles: [profile] };
  const app = settings.app as Record<string, unknown>;
  if (options.target === 'android') {
    app.android = { versionCode: contentRevision, allowBackup: false, isGame: true };
  }

  await Promise.all([
    mkdir(path.join(projectRoot, 'assets/images'), { recursive: true }),
    mkdir(path.join(projectRoot, 'assets/fonts'), { recursive: true }),
    mkdir(path.join(projectRoot, 'assets/audio'), { recursive: true }),
    mkdir(path.join(projectRoot, 'assets/scripts'), { recursive: true }),
  ]);
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#553399' } })
    .png().toFile(path.join(projectRoot, 'assets/images/app-icon.png'));
  await sharp({ create: { width: 64, height: 64, channels: 4, background: '#223355' } })
    .png().toFile(path.join(projectRoot, 'assets/images/backdrop.png'));
  await copyFile(options.fontSourcePath, path.join(projectRoot, 'assets/fonts/body.ttf'));
  await writeFile(path.join(projectRoot, 'assets/audio/theme.wav'), wavSilence());
  await writeFile(path.join(projectRoot, 'assets/scripts/startup.lua'), 'Game.prop("fixture_started", true)\n');

  const projectData = `${JSON.stringify(project, null, 2)}\n`;
  const projectPath = path.join(projectRoot, 'project.json');
  await writeFile(projectPath, projectData);
  return {
    projectPath,
    projectRoot,
    profile,
    fixtureRevision: `${PLATFORM_EXPORT_ACCEPTANCE_FIXTURE_REVISION}.${contentRevision}`,
    projectSha256: sha256(projectData),
    profileSha256: sha256(JSON.stringify(profile)),
  };
}
