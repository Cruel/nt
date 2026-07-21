import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializePlatformExportAcceptanceFixture } from '../src/main/services/platform-export-acceptance-fixture-service';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const fontRelativePath = path.join('apps', 'sandbox', 'assets', 'rmlui', 'LiberationSans.ttf');

function repositoryRoot(): string {
  const candidates = [
    process.env.INIT_CWD,
    process.cwd(),
    path.resolve(moduleDirectory, '../..'),
    path.resolve(moduleDirectory, '../../..'),
  ].filter((candidate): candidate is string => !!candidate);
  const root = candidates.find((candidate) => existsSync(path.join(candidate, fontRelativePath)));
  if (!root) throw new Error(`Unable to locate the repository fixture font '${fontRelativePath}'.`);
  return root;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const root = value('--root');
  if (!root)
    throw new Error(
      'Usage: materialize-android-export-fixture --root <directory> [--revision <n>]',
    );
  const revision = Number(value('--revision') ?? '1');
  const abi = (value('--abi') ?? 'x86_64') as 'x86_64' | 'arm64-v8a';
  const flavor = (value('--flavor') ?? 'debug') as 'debug' | 'release';
  const artifact = (value('--artifact') ?? 'apk') as 'apk' | 'aab' | 'both';
  const fixture = await materializePlatformExportAcceptanceFixture({
    root: path.resolve(root),
    target: 'android',
    architecture: abi === 'arm64-v8a' ? 'arm64' : 'x86_64',
    buildFlavor: flavor,
    androidAbi: abi,
    androidArtifact: artifact,
    contentRevision: revision,
    fontSourcePath: path.join(repositoryRoot(), fontRelativePath),
  });
  process.stdout.write(
    `${JSON.stringify({ projectPath: fixture.projectPath, profileId: fixture.profile.id })}\n`,
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
