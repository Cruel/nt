import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [rootArg, stageArg, releaseTag, abi, flavor, bundletoolArg] = process.argv.slice(2);
if (!rootArg || !stageArg || !releaseTag || !abi || !flavor || !bundletoolArg) throw new Error('Expected root, stage, release tag, ABI, flavor, and bundletool JAR.');
const root = path.resolve(rootArg); const stage = path.resolve(stageArg); const source = path.join(stage, 'source');
const architecture = abi === 'arm64-v8a' ? 'arm64' : abi === 'x86_64' ? 'x86_64' : (() => { throw new Error(`Unsupported ABI ${abi}`); })();
await rm(stage, { recursive: true, force: true }); await mkdir(source, { recursive: true });
const ignored = (sourcePath) => !/(?:^|[/\\])(?:build|\.gradle|\.cxx|\.idea|local\.properties|\.DS_Store)(?:$|[/\\])/.test(sourcePath);
for (const entry of ['CMakeLists.txt', 'cmake', 'engine', 'apps/player', 'android', 'third_party']) {
  await cp(path.join(root, entry), path.join(source, entry), { recursive: true, filter: ignored });
}
const prebuiltShaders = path.join(root, 'android', 'app', 'build', 'generated', 'noveltea', 'shaders');
try { await stat(prebuiltShaders); await cp(prebuiltShaders, path.join(source, 'android', 'prebuilt-shaders'), { recursive: true }); }
catch { throw new Error('Build the Android player template once before packaging so certified essl-300 shader assets are available.'); }
await mkdir(path.join(source, 'android', 'tools'), { recursive: true });
await cp(path.resolve(bundletoolArg), path.join(source, 'android', 'tools', 'bundletool-1.18.1.jar'));
await chmod(path.join(source, 'android', 'gradlew'), 0o755);
await mkdir(path.join(stage, 'licenses'), { recursive: true });
const dependencies = [
  ['SDL', '3.4.10'], ['Android Gradle Plugin', '8.7.3'], ['Gradle', '8.9'], ['bundletool', '1.18.1'],
  ['Android NDK', '28.2.13676358'], ['bgfx.cmake', '1.143.9262-545'], ['RmlUi', '6.2'], ['Lua', '5.5.0'],
  ['sol2', '3.5.0'], ['FreeType', '2.13.3'], ['HarfBuzz', '11.2.1'], ['SheenBidi', '2.6'],
  ['libunibreak', '6.1'], ['miniaudio', '0.11.23'], ['nlohmann-json', '3.12.0'], ['twink', 'ea488b2'],
];
await writeFile(path.join(stage, 'SBOM.cdx.json'), `${JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, metadata: { component: { type: 'application', name: 'noveltea-android-player-template', version: releaseTag } }, components: dependencies.map(([name, version]) => ({ type: 'library', name, version })) }, null, 2)}\n`);
await writeFile(path.join(stage, 'licenses', 'THIRD_PARTY_NOTICES.txt'), `NovelTea Android player template third-party inventory\n\n${dependencies.map(([name, version]) => `${name} ${version}`).join('\n')}\n\nResolved dependency license texts are collected from the native build source trees in release CI.\n`);

async function files(directory, prefix = '') { const output = []; for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) { const relative = path.posix.join(prefix, entry.name); if (entry.isDirectory()) output.push(...await files(directory, relative)); else if (entry.isFile()) output.push(relative); } return output.sort(); }
const sha = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const inventory = [];
for (const relative of await files(stage)) {
  if (relative === 'template.json') continue;
  const info = await stat(path.join(stage, relative));
  const role = relative.includes('/assets/system/') ? 'system-asset' : relative.endsWith('.aar') ? 'native-dependency' : relative.includes('NOTICE') ? 'notice' : 'support';
  inventory.push({ path: relative, size: info.size, mode: info.mode & 0o777, sha256: await sha(path.join(stage, relative)), role });
}
const templateId = `android-${abi}-${flavor}`; const buildId = `${releaseTag}-android-${abi}-${flavor}`;
const archiveExtension = process.platform === 'win32' ? 'zip' : 'tar.gz';
const descriptor = {
  format: 'noveltea.player-template', formatVersion: 1, templateId, buildId, engineVersion: releaseTag,
  platform: 'android', architecture, abi, minimumPlatformVersion: 'Android API 24', graphicsBackends: ['opengles'], shaderVariants: ['essl-300'],
  runtimePackageApi: { minimum: 1, maximum: 1 }, playerConfigApi: { minimum: 1, maximum: 1 },
  compiledFeatures: ['lua', 'rmlui', 'audio', 'save', 'android-private-copy'], capabilities: ['network.client', 'external-url', 'gamepad', 'vibration', 'microphone', 'notifications', 'billing'],
  buildFlavor: flavor, packageAccessModes: ['android-private-copy'], files: inventory, runtimeDependencies: [],
  artifacts: { archive: `noveltea-player-template-${releaseTag}-${templateId}.${archiveExtension}`, symbols: `noveltea-player-symbols-${releaseTag}-${templateId}.zip`, sbom: 'SBOM.cdx.json', notices: 'licenses/THIRD_PARTY_NOTICES.txt' },
  provenance: { provider: 'github-attestation', source: releaseTag }, host: { assembly: 'any', requiresToolchain: true, tools: ['java', 'android-sdk', 'android-ndk', 'cmake', 'bundletool'] },
  android: {
    gradleProjectRoot: 'source/android', applicationModule: 'app', gradleWrapperPath: 'source/android/gradlew', bundletoolPath: 'source/android/tools/bundletool-1.18.1.jar',
    insertionRoots: { generatedSource: 'generated/java', resources: 'generated/res', assets: 'generated/assets' }, namespace: 'org.noveltea.player', activityClass: 'org.noveltea.player.MainActivity', nativeLibraryName: 'noveltea-player',
    supportedAbis: [abi], artifactKinds: flavor === 'release' ? ['apk', 'aab'] : ['apk'], packageAccessModes: ['android-private-copy'], minimumSdk: { minimum: 24, maximum: 35 }, targetSdk: 35, compileSdk: 35,
    toolchain: { gradle: '8.9', androidGradlePlugin: '8.7.3', java: '17', buildTools: '35.0.0', ndk: '28.2.13676358', cmake: '3.31.6', bundletool: '1.18.1' },
    roles: { manifest: ['source/android/app/src/main/AndroidManifest.xml'], nativeLibraries: ['source/apps/player/CMakeLists.txt'], runtimeAssets: ['source/engine/assets/system', 'source/android/prebuilt-shaders'], notices: ['licenses/THIRD_PARTY_NOTICES.txt'], supportFiles: ['source/android/gradlew', 'source/android/gradle/wrapper/gradle-wrapper.jar', 'source/android/tools/bundletool-1.18.1.jar'] },
  },
};
await writeFile(path.join(stage, 'template.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
const parsed = spawnSync('node', ['-e', `JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(stage, 'template.json'))},'utf8'))`]);
if (parsed.status !== 0) throw new Error('Generated descriptor is not valid JSON.');
