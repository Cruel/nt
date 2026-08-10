import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(editorRoot, '..');
const perryVersion = '0.5.1220';
const perryArchiveSha256 = 'e4bcd0f362e001101a0d1b3683d14bd8e42b882dd59a1395be670fb9af9593c3';
const perrySourceTreeSha256 = '1adef789a428d96cf69b27ed59cdc46e72dcebaa9d22218a2c4ea6b3046134b7';
const cacheRoot = path.join(repositoryRoot, 'build', 'host-tools', 'perry-cache');
const perryToolRoot = path.join(repositoryRoot, 'build', 'host-tools', 'perry', `v${perryVersion}`);
const perrySourceRoot = path.join(perryToolRoot, `perry-${perryVersion}`);
const perryArchivePath = path.join(perryToolRoot, `perry-${perryVersion}.tar.gz`);
const perryBinary = path.join(editorRoot, 'node_modules', '.bin', 'perry');
const updateNativeLock = process.argv.slice(2).includes('--update-native-lock');
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== '--update-native-lock');
if (unknownArguments.length > 0)
  throw new Error(`Unknown NovelTea CLI build argument(s): ${unknownArguments.join(', ')}.`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`,
    );
}

async function sha256(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

async function sourceTreeSha256(root) {
  const hash = createHash('sha256');
  async function visit(relative = '') {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      // Perry writes Rust build outputs into this directory after source verification.
      if (child === 'target' || child.startsWith('target/')) continue;
      const absolute = path.join(root, child);
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        hash.update(`D\0${child}\0`);
        await visit(child);
      } else if (info.isSymbolicLink()) {
        hash.update(`L\0${child}\0${await readlink(absolute)}\0`);
      } else if (info.isFile()) {
        hash.update(`F\0${child}\0${info.mode & 0o777}\0`);
        hash.update(await readFile(absolute));
        hash.update('\0');
      }
    }
  }
  await visit();
  return hash.digest('hex');
}

async function ensurePerrySourceWorkspace() {
  await mkdir(perryToolRoot, { recursive: true });
  if (!existsSync(perryArchivePath)) {
    const response = await fetch(
      `https://github.com/PerryTS/perry/archive/refs/tags/v${perryVersion}.tar.gz`,
      { redirect: 'follow' },
    );
    if (!response.ok)
      throw new Error(`Unable to download Perry v${perryVersion} source: HTTP ${response.status}.`);
    await writeFile(perryArchivePath, Buffer.from(await response.arrayBuffer()));
  }

  const actualHash = await sha256(perryArchivePath);
  if (actualHash !== perryArchiveSha256) {
    await rm(perryArchivePath, { force: true });
    throw new Error(
      `Perry v${perryVersion} source hash mismatch: expected ${perryArchiveSha256}, received ${actualHash}.`,
    );
  }

  if (existsSync(path.join(perrySourceRoot, 'Cargo.toml'))) {
    const actualTreeHash = await sourceTreeSha256(perrySourceRoot);
    if (actualTreeHash === perrySourceTreeSha256) return;
    await rm(perrySourceRoot, { recursive: true, force: true });
  }

  const extractionRoot = path.join(perryToolRoot, '.extract');
  await rm(extractionRoot, { recursive: true, force: true });
  await mkdir(extractionRoot, { recursive: true });
  run('tar', ['-xzf', perryArchivePath, '-C', extractionRoot]);
  const extractedRoot = path.join(extractionRoot, `perry-${perryVersion}`);
  if (!existsSync(path.join(extractedRoot, 'Cargo.toml')))
    throw new Error(
      `Perry v${perryVersion} archive did not contain the expected source workspace.`,
    );
  await rm(perrySourceRoot, { recursive: true, force: true });
  run('mv', [extractedRoot, perrySourceRoot]);
  await rm(extractionRoot, { recursive: true, force: true });
  const extractedTreeHash = await sourceTreeSha256(perrySourceRoot);
  if (extractedTreeHash !== perrySourceTreeSha256) {
    await rm(perrySourceRoot, { recursive: true, force: true });
    throw new Error(
      `Perry v${perryVersion} extracted source hash mismatch: expected ${perrySourceTreeSha256}, received ${extractedTreeHash}.`,
    );
  }
}

if (process.versions.node !== '24.18.0') {
  throw new Error(
    `NovelTea CLI release builds require Node 24.18.0; received ${process.versions.node}.`,
  );
}
if (process.platform !== 'linux') {
  throw new Error(
    `NovelTea CLI release builds currently support Linux hosts only; received ${process.platform}.`,
  );
}
if (!process.env.VCPKG_ROOT)
  throw new Error('VCPKG_ROOT is required for the native tooling release build.');
if (!existsSync(perryBinary))
  throw new Error(`Pinned Perry ${perryVersion} is not installed. Run pnpm install first.`);

await ensurePerrySourceWorkspace();
const buildEnv = {
  ...process.env,
  PERRY_CACHE_DIR: cacheRoot,
  PERRY_WORKSPACE_ROOT: perrySourceRoot,
  ...(updateNativeLock
    ? { PERRY_LOCK_UPDATE: '@noveltea/tooling-native' }
    : { PERRY_LOCK_FROZEN: '1' }),
};

run(
  'cmake',
  ['--preset', 'linux-release', '-DBUILD_TESTING=OFF', '-DNOVELTEA_COMPILE_SHADERS=OFF'],
  { env: buildEnv },
);
run('cmake', ['--build', '--preset', 'linux-release', '--target', 'noveltea_tooling_native'], {
  env: buildEnv,
});

const outputDirectory = path.join(repositoryRoot, 'build', 'cli', 'linux');
const outputPath = path.join(outputDirectory, 'noveltea');
await mkdir(outputDirectory, { recursive: true });
run(perryBinary, ['compile', 'scripts/noveltea.ts', '--target', 'linux', '--output', outputPath], {
  cwd: editorRoot,
  env: buildEnv,
});

console.log(`NovelTea CLI: ${outputPath}`);
