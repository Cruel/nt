import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// Certification-only, pinned current-format YAML fixtures. No TypeScript
// Project decoder, Workspace writer or semantic validator is invoked here.
// The installed native CLI must still admit the copied Project and reject
// any fixture that drifts from its declared schema/source format.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(repositoryRoot, 'tests/fixtures/native-platform-export-web');
const args = process.argv.slice(2);
const value = (option) => {
  const index = args.indexOf(option);
  return index < 0 ? null : args[index + 1];
};
const destination = value('--root');
const platform = value('--target');
if (!destination || !['web', 'android'].includes(platform))
  throw new Error(
    'Usage: materialize-native-platform-export-fixture --root <directory> --target <web|android> [--revision 1|2] [--abi x86_64|arm64-v8a] [--flavor debug|release] [--artifact apk|aab|both]',
  );
const revision = Number(value('--revision') ?? 1);
if (![1, 2].includes(revision)) throw new Error('Fixture revision must be 1 or 2.');
const flavor = value('--flavor') ?? 'debug';
const abi = value('--abi') ?? 'x86_64';
const artifact = value('--artifact') ?? 'apk';
if (
  platform === 'android' &&
  (!['debug', 'release'].includes(flavor) ||
    !['x86_64', 'arm64-v8a'].includes(abi) ||
    !['apk', 'aab', 'both'].includes(artifact))
)
  throw new Error('Unsupported Android fixture profile.');
const target = path.resolve(destination);
await mkdir(path.dirname(target), { recursive: true });
await cp(fixtureRoot, target, { recursive: true, force: false, errorOnExist: true });
if (platform === 'android') {
  const manifestPath = path.join(target, 'project.yaml');
  const manifest = parseYaml(await readFile(manifestPath, 'utf8'));
  const template = parseYaml(
    await readFile(path.join(repositoryRoot, 'tests/projects/feature-lab/project.yaml'), 'utf8'),
  );
  const android = template.export.profiles.find(
    (profile) =>
      profile.target === 'android' &&
      profile.architecture === (abi === 'x86_64' ? 'x86_64' : 'arm64'),
  );
  if (!android) throw new Error('Missing canonical Android template export profile.');
  manifest.project.version = `2026-10-09.1.${revision}`;
  manifest.settings.app.versionName = `2026-10-09.${revision}`;
  manifest.export.profiles = [
    {
      ...android,
      id: `canonical-android-${flavor}`,
      label: `Canonical Android ${flavor}`,
      buildFlavor: flavor,
      includeDebugSymbols: flavor === 'debug',
      android: { ...android.android, artifact },
      localization: { ...android.localization, locales: ['en'] },
    },
  ];
  await writeFile(manifestPath, stringifyYaml(manifest));
}
for (const relative of ['assets/images', 'assets/fonts', 'assets/audio', 'assets/scripts'])
  await mkdir(path.join(target, relative), { recursive: true });

await Promise.all([
  sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#553399' } })
    .png()
    .toFile(path.join(target, 'assets/images/app-icon.png')),
  sharp({ create: { width: 64, height: 64, channels: 4, background: '#223355' } })
    .png()
    .toFile(path.join(target, 'assets/images/backdrop.png')),
  sharp({ create: { width: 64, height: 64, channels: 4, background: '#772255' } })
    .png()
    .toFile(path.join(target, 'assets/images/backdrop-fr.png')),
]);
const font = path.join(repositoryRoot, 'engine/assets/system/fonts/LiberationSans.ttf');
await Promise.all([
  copyFile(font, path.join(target, 'assets/fonts/body.ttf')),
  copyFile(font, path.join(target, 'assets/fonts/alternate.ttf')),
]);
const samples = 800;
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + samples * 2, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8_000, 24);
wav.writeUInt32LE(16_000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(samples * 2, 40);
await Promise.all([
  writeFile(path.join(target, 'assets/audio/theme.wav'), wav),
  writeFile(path.join(target, 'assets/scripts/startup.lua'), 'fixture_started = true\n'),
]);
process.stdout.write(
  `${JSON.stringify({ projectPath: path.join(target, 'project.yaml'), profileId: platform === 'web' ? 'canonical-web' : `canonical-android-${flavor}`, revision })}\n`,
);
