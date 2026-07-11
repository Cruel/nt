import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runExportCommand } from '../../cli/export-command';
import { configureTemplateRegistryRoot, installPlayerTemplate } from '../../main/services/template-registry-service';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { parsePlatformExportProfile } from '../../shared/project-schema/platform-export-contracts';

const enabled = process.env.NOVELTEA_ANDROID_EXPORT_INTEGRATION === '1';
const suite = enabled ? describe : describe.skip;
let root = '';

suite('Android player template integration', () => {
  beforeAll(async () => { root = process.env.NOVELTEA_ANDROID_INTEGRATION_ROOT ?? await mkdtemp(path.join(os.tmpdir(), 'noveltea-android-export-')); await mkdir(root, { recursive: true }); configureTemplateRegistryRoot(path.join(root, 'registry')); }, 30_000);
  afterAll(async () => { if (root && !process.env.NOVELTEA_ANDROID_INTEGRATION_ROOT) await rm(root, { recursive: true, force: true }); });

  it('installs an immutable template and exports a verified APK through the headless export command', async () => {
    const archive = process.env.NOVELTEA_ANDROID_TEMPLATE_ARCHIVE!;
    const installed = await installPlayerTemplate({ archivePath: archive, origin: 'integration-test' });
    expect(installed.success, JSON.stringify(installed.diagnostics)).toBe(true);
    const projectRoot = path.join(root, 'Project ü space'); await mkdir(path.join(projectRoot, 'assets', 'images'), { recursive: true });
    const iconPath = path.join(projectRoot, 'assets', 'images', 'icon.png'); await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#6750a4' } }).png().toFile(iconPath);
    const project = createAuthoringProject({ id: 'android-fixture', name: 'Android Fixture ü', version: '1.2.3' });
    project.assets['app-icon'] = { id: 'app-icon', label: 'App Icon', tags: [], data: assetDataFromImportMetadata({ kind: 'image', projectRelativePath: 'assets/images/icon.png' }) };
    const revision = Number(process.env.NOVELTEA_ANDROID_FIXTURE_REVISION ?? '1');
    const room = defaultRoomData('Start'); room.description.source = `Android fixture revision ${revision}`;
    project.rooms.start = { id: 'start', label: 'Start', tags: [], data: room };
    project.entrypoint = { collection: 'rooms', id: 'start' };
    const abi = (process.env.NOVELTEA_ANDROID_ABI ?? 'x86_64') as 'x86_64' | 'arm64-v8a';
    const flavor = (process.env.NOVELTEA_ANDROID_FLAVOR ?? 'debug') as 'debug' | 'release';
    const artifact = (process.env.NOVELTEA_ANDROID_ARTIFACT ?? 'apk') as 'apk' | 'aab' | 'both';
    const profile = parsePlatformExportProfile({ format: 'noveltea.platform-export-profile', formatVersion: 1, id: `android-${flavor}`, label: `Android ${flavor}`, target: 'android', architecture: abi === 'arm64-v8a' ? 'arm64' : 'x86_64', buildFlavor: flavor, packageAccess: 'android-private-copy', android: { artifact, abi, minSdk: 24 } });
    const settings = project.settings as Record<string, unknown>; const app = settings.app as Record<string, unknown>;
    app.icon = { $ref: { collection: 'assets', id: 'app-icon' } }; app.applicationId = 'org.example.androidfixture'; app.saveNamespace = 'org.example.androidfixture'; app.android = { versionCode: 6 + revision, allowBackup: false, isGame: true };
    settings.platformExport = { selectedProfileId: profile.id, profiles: [profile] };
    const output = process.env.NOVELTEA_ANDROID_EXPORT_OUTPUT ?? path.join(root, 'Output ü space');
    const projectPath = path.join(projectRoot, 'project.json');
    const configPath = path.join(projectRoot, 'android-toolchain.json');
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    await writeFile(configPath, `${JSON.stringify({ androidSdk: process.env.ANDROID_SDK_ROOT!, androidNdk: process.env.ANDROID_NDK_ROOT!, javaHome: process.env.JAVA_HOME!, cmake: process.env.ANDROID_CMAKE_ROOT! })}\n`);
    const command = await runExportCommand({ projectPath, profileId: profile.id, outputDirectory: output, configPath, json: true });
    const result = command.result;
    expect(command.exitCode).toBe(0);
    expect(result.success, JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    const expectedKinds = artifact === 'both' ? ['apk', 'aab'] : [artifact];
    expect(result.artifacts?.map((item) => item.kind)).toEqual(expect.arrayContaining(expectedKinds));
    expect(result.deployment?.android).toMatchObject({ applicationId: 'org.example.androidfixture', versionCode: 6 + revision, abi, artifacts: expectedKinds });
  }, 15 * 60_000);
});
