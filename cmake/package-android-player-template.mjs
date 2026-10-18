import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveAndroidPlayerBuild } from './android-player-build.mjs';

const [rootArg, stageArg, releaseTag, abi, flavor, bundletoolArg, bgfxVersion, sourceFlavor = flavor, variant = flavor] = process.argv.slice(2);
if (!rootArg || !stageArg || !releaseTag || !abi || !flavor || !bundletoolArg || !bgfxVersion) throw new Error('Expected root, stage, release tag, ABI, flavor, bundletool JAR, and bgfx version.');
const root = path.resolve(rootArg); const stage = path.resolve(stageArg); const source = path.join(stage, 'source');
const architecture = abi === 'arm64-v8a' ? 'arm64' : abi === 'x86_64' ? 'x86_64' : (() => { throw new Error(`Unsupported ABI ${abi}`); })();
await rm(stage, { recursive: true, force: true }); await mkdir(source, { recursive: true });
const ignored = (sourcePath) => !/(?:^|[/\\])(?:build|\.gradle|\.cxx|\.idea|local\.properties|\.DS_Store)(?:$|[/\\])/.test(sourcePath);
await cp(path.join(root, 'android'), path.join(source, 'android'), { recursive: true, filter: ignored });

// The optimized devtools player retains release packaging/signing semantics.
if (sourceFlavor !== flavor || !['release', 'debug', 'devtools'].includes(variant) ||
    (variant === 'devtools' && flavor !== 'release') ||
    (variant === 'debug' && flavor !== 'debug'))
  throw new Error(`Unsupported Android source/template variant: ${sourceFlavor}/${flavor}/${variant}`);
const { nativeRoot, buildRoot, nativeLibraryPath } = await resolveAndroidPlayerBuild(root, abi, sourceFlavor);
const configured = await readFile(path.join(buildRoot, 'CMakeCache.txt'), 'utf8');
const devtools = /^NOVELTEA_ENABLE_DEVTOOLS:BOOL=(ON|OFF)$/m.exec(configured)?.[1];
const requiredDevtools = variant === 'devtools' || flavor === 'debug' ? 'ON' : 'OFF';
if (devtools !== requiredDevtools)
  throw new Error(`Android ${variant} template requires devtools ${requiredDevtools}, found ${devtools}.`);
const nativeDestination = path.join(source, 'android', 'prebuilt-native', abi);
await mkdir(nativeDestination, { recursive: true });
for (const entry of await readdir(nativeRoot, { withFileTypes: true }))
  if (entry.isFile() && entry.name.endsWith('.so'))
    await cp(path.join(nativeRoot, entry.name), path.join(nativeDestination, entry.name));
for (const required of ['libnoveltea-player.so', 'libSDL3.so'])
  await stat(path.join(nativeDestination, required)).catch(() => {
    throw new Error(`Prebuilt Android native closure is missing ${required} for ${abi}.`);
  });

const stagedSystemRoot = path.join(root, 'android', 'app', 'build', 'generated', 'runtime-assets', 'noveltea', 'system');
await stat(stagedSystemRoot).catch(() => {
  throw new Error('Build the Android player template once before packaging its staged system assets.');
});
await cp(stagedSystemRoot, path.join(source, 'android', 'prebuilt-system'), { recursive: true });
const shaderCandidates = [
  path.join(root, 'android', 'app', 'build', 'generated', 'noveltea', 'shaders'),
  path.join(root, 'build', 'prebuilt-shader-assets'),
];
const prebuiltShaders = await (async () => {
  for (const candidate of shaderCandidates) {
    try {
      await stat(candidate);
      const verification = spawnSync('cmake', [
        '-DNOVELTEA_VERIFY_ONLY=ON',
        `-DNOVELTEA_SHADER_OUTPUT_ROOT=${candidate}`,
        '-DNOVELTEA_SHADER_VARIANTS=essl-300',
        '-P', path.join(root, 'cmake', 'CompileNovelTeaShaders.cmake'),
      ], { stdio: 'ignore' });
      if (verification.status === 0) return candidate;
    }
    catch { /* Try the next certified shader root. */ }
  }
  throw new Error('Build the Android player template once before packaging or provide build/prebuilt-shader-assets with certified essl-300 shader assets.');
})();
await cp(prebuiltShaders, path.join(source, 'android', 'prebuilt-shaders'), { recursive: true });
await mkdir(path.join(source, 'android', 'tools'), { recursive: true });
await cp(path.resolve(bundletoolArg), path.join(source, 'android', 'tools', 'bundletool-1.18.1.jar'));
await chmod(path.join(source, 'android', 'gradlew'), 0o755);
// Use the same resolved license generator and SBOM contract as desktop and Web.
// Use the cache that produced the merged player, not another retained Gradle configuration.
const metadata = spawnSync('node', [path.join(root, 'cmake/generate-player-template-metadata.mjs'),
  path.join(buildRoot, 'vcpkg_installed'), stage, releaseTag, buildRoot, '--android'], { encoding: 'utf8' });
if (metadata.status !== 0) throw new Error(`Android license generation failed: ${metadata.stderr || metadata.stdout}`);

async function files(directory, prefix = '') { const output = []; for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) { const relative = path.posix.join(prefix, entry.name); if (entry.isDirectory()) output.push(...await files(directory, relative)); else if (entry.isFile()) output.push(relative); } return output.sort(); }
const sha = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const inventory = [];
for (const relative of await files(stage)) {
  if (relative === 'template.json') continue;
  const info = await stat(path.join(stage, relative));
  const role = relative.startsWith('licenses/') ? 'notice' : relative.includes('/prebuilt-system/') ? 'system-asset' : relative.endsWith('.aar') ? 'native-dependency' : 'support';
  inventory.push({ path: relative, size: info.size, mode: info.mode & 0o777, sha256: await sha(path.join(stage, relative)), role });
}
const templateId = `android-${abi}-${variant}`; const buildId = `${releaseTag}-${templateId}`;
const archiveExtension = process.platform === 'win32' ? 'zip' : 'tar.gz';
const descriptor = {
  format: 'noveltea.player-template', formatVersion: 1, templateId, buildId, engineVersion: releaseTag,
  platform: 'android', architecture, abi, minimumPlatformVersion: 'Android API 24', graphicsBackends: ['opengles'], shaderVariants: ['essl-300'],
  compiledProjectFormatVersion: 1, playerRuntimeApiVersion: 1,
  compiledFeatures: ['lua', 'rmlui', 'audio', 'save', 'android-private-copy'], capabilities: ['network.client', 'external-url', 'gamepad', 'vibration', 'microphone', 'notifications', 'billing'],
  buildFlavor: flavor, playerVariant: variant === 'devtools' ? 'devtools' : 'standard', packageAccessModes: ['android-private-copy'], files: inventory, runtimeDependencies: inventory.filter((entry) => entry.role === 'notice').map((entry) => ({ path: entry.path, kind: 'notice' })),
  artifacts: { archive: `noveltea-player-template-${releaseTag}-${templateId}.${archiveExtension}`, symbols: `noveltea-player-symbols-${releaseTag}-${templateId}.zip`, sbom: 'SBOM.cdx.json', notices: 'licenses/index.json' },
  provenance: { provider: 'github-attestation', source: releaseTag }, host: { assembly: 'any', requiresToolchain: true, tools: ['java', 'android-sdk', 'bundletool'] },
  android: {
    gradleProjectRoot: 'source/android', applicationModule: 'app', gradleWrapperPath: 'source/android/gradlew', bundletoolPath: 'source/android/tools/bundletool-1.18.1.jar',
    insertionRoots: { generatedSource: 'generated/java', resources: 'generated/res', assets: 'generated/assets' }, namespace: 'org.noveltea.player', activityClass: 'org.noveltea.player.MainActivity', nativeLibraryName: 'noveltea-player',
    supportedAbis: [abi], artifactKinds: flavor === 'release' ? ['apk', 'aab'] : ['apk'], packageAccessModes: ['android-private-copy'], minimumSdk: { minimum: 24, maximum: 35 }, targetSdk: 35, compileSdk: 35,
    toolchain: { gradle: '8.9', androidGradlePlugin: '8.7.3', java: '17', buildTools: '35.0.0', ndk: '28.2.13676358', cmake: '3.31.6', bundletool: '1.18.1' },
    roles: { manifest: ['source/android/app/src/main/AndroidManifest.xml'], nativeLibraries: [`source/android/prebuilt-native/${abi}`], runtimeAssets: ['source/android/prebuilt-system', 'source/android/prebuilt-shaders'], notices: ['licenses/index.json'], supportFiles: ['source/android/gradlew', 'source/android/gradle/wrapper/gradle-wrapper.jar', 'source/android/tools/bundletool-1.18.1.jar'] },
  },
};
await writeFile(path.join(stage, 'template.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
const parsed = spawnSync('node', ['-e', `JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(stage, 'template.json'))},'utf8'))`]);
if (parsed.status !== 0) throw new Error('Generated descriptor is not valid JSON.');
process.stdout.write(JSON.stringify({ nativeLibraryPath }));
