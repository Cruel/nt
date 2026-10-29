import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readNovelTeaBuildIdentity } from '../../scripts/noveltea-version.mjs';
import { removeCliRelocation } from './cleanup-cli-relocation.mjs';
import { stagePrivateMediaTools } from './private-media-tools.mjs';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(editorRoot, '..');
const buildIdentity = readNovelTeaBuildIdentity(repositoryRoot);
const targetOverride = process.env.NOVELTEA_CLI_TARGET;
if (targetOverride && targetOverride !== 'windows')
  throw new Error(`Unsupported NOVELTEA_CLI_TARGET '${targetOverride}'.`);
if (process.argv.length > 2)
  throw new Error(
    `NovelTea CLI build does not accept arguments: ${process.argv.slice(2).join(' ')}`,
  );

const windows = process.platform === 'win32' || targetOverride === 'windows';
const macos = !windows && process.platform === 'darwin';
const crossWindows = windows && process.platform !== 'win32';
const platform = windows ? 'windows' : macos ? 'macos' : 'linux';
const preset = windows
  ? 'windows-cli-gnu'
  : macos
    ? 'macos-authoring-release'
    : 'linux-authoring-release';
const buildRoot = path.join(repositoryRoot, 'build', preset);
const executableName = windows ? 'noveltea.exe' : 'noveltea';
const runnerName = windows ? 'noveltea-ui-test-runner.exe' : 'noveltea-ui-test-runner';
const outputDirectory = path.join(repositoryRoot, 'build', 'cli', platform);
const outputPath = path.join(outputDirectory, executableName);
const sourceDirectory = path.join(buildRoot, 'tools', 'editor_tool', 'native-cli');
const cmake = 'cmake';
const env = { ...process.env, NODE_ENV: 'production', NOVELTEA_BUILD_IDENTITY: buildIdentity };
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? env,
    stdio: options.stdio ?? 'inherit',
    encoding: options.stdio === 'pipe' ? 'utf8' : undefined,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`,
    );
  return result;
}

if (process.versions.node !== '24.18.0')
  throw new Error(`NovelTea CLI builds require Node 24.18.0; received ${process.versions.node}.`);
if (
  !(
    (process.platform === 'linux' && process.arch === 'x64') ||
    (process.platform === 'win32' && process.arch === 'x64') ||
    (process.platform === 'darwin' && process.arch === 'arm64')
  )
)
  throw new Error(`Unsupported CLI build host: ${process.platform}/${process.arch}.`);
if (!process.env.VCPKG_ROOT) throw new Error('VCPKG_ROOT is required for native CLI builds.');

const crossArguments = crossWindows
  ? [
      '-DCMAKE_SYSTEM_NAME=Windows',
      '-DCMAKE_C_COMPILER=x86_64-w64-mingw32-gcc-posix',
      '-DCMAKE_CXX_COMPILER=x86_64-w64-mingw32-g++-posix',
      '-DCMAKE_CXX_FLAGS=-msse4.2',
      '-DVCPKG_HOST_TRIPLET=x64-linux',
    ]
  : [];
if (windows) {
  for (const compiler of crossWindows
    ? ['x86_64-w64-mingw32-gcc-posix', 'x86_64-w64-mingw32-g++-posix']
    : ['gcc', 'g++']) {
    const machine = run(compiler, ['-dumpmachine'], { stdio: 'pipe' }).stdout.trim();
    if (!/mingw/i.test(machine))
      throw new Error(
        `Native Windows CLI requires MinGW GNU compiler; ${compiler} targets '${machine}'.`,
      );
  }
}

run(
  process.execPath,
  [path.join(editorRoot, 'scripts/generate-authoring-graph-field-metadata.mjs'), '--check'],
  {
    cwd: editorRoot,
  },
);

const prebuiltShadercRoot = process.env.NOVELTEA_PREBUILT_SHADERC_ROOT;
if (prebuiltShadercRoot && process.platform !== 'linux')
  throw new Error('NOVELTEA_PREBUILT_SHADERC_ROOT is a Linux-only build input.');
run(cmake, [
  '--preset',
  preset,
  '-G',
  'Ninja',
  '-DBUILD_TESTING=OFF',
  '-DNOVELTEA_BUILD_HOST_TOOLS=ON',
  '-DNOVELTEA_COMPILE_SHADERS=OFF',
  '-DNOVELTEA_CMAKE_STAGE_RUNTIME_ASSETS=OFF',
  `-DNOVELTEA_NATIVE_CLI_BUILD_IDENTITY=${buildIdentity}`,
  ...(prebuiltShadercRoot ? [`-DNOVELTEA_PREBUILT_SHADERC_ROOT=${prebuiltShadercRoot}`] : []),
  ...crossArguments,
]);

// The shaderc prebuild is a link-time input: preserve the existing pinned
// archive closure without rebuilding the shader toolchain in release jobs.
if (prebuiltShadercRoot) {
  const linkDirectory = path.join(buildRoot, 'tools', 'editor_tool');
  await mkdir(linkDirectory, { recursive: true });
  for (const archive of [
    'libnoveltea_bgfx_shaderc_embedded.a',
    'libnoveltea_bimg_texturec_embedded.a',
    'libglslang.a',
    'libspirv-opt.a',
    'libspirv-cross.a',
    'libtint.a',
    'libbimg.a',
    'libbimg_decode.a',
    'libbimg_encode.a',
    'libbx.a',
  ]) {
    const source = path.join(prebuiltShadercRoot, 'lib', archive);
    if (!existsSync(source)) throw new Error(`Missing pinned shaderc archive: ${source}`);
    const destination = path.join(linkDirectory, archive);
    if (existsSync(destination)) {
      if (!(await lstat(destination)).isSymbolicLink())
        throw new Error(`Refusing to replace non-symlink shaderc artifact: ${destination}`);
      await rm(destination);
    }
    await symlink(source, destination);
  }
}

// One native executable, not a ScriptC launcher linked with a C++ FFI archive.
run(cmake, ['--build', '--preset', preset, '--target', 'noveltea-native-cli']);
for (const filename of [executableName, runnerName]) {
  if (!existsSync(path.join(sourceDirectory, filename)))
    throw new Error(`Native CLI build did not produce ${filename}.`);
}
await mkdir(outputDirectory, { recursive: true });
await cp(path.join(sourceDirectory, executableName), outputPath);
await cp(path.join(sourceDirectory, runnerName), path.join(outputDirectory, runnerName));
await cp(path.join(sourceDirectory, 'assets'), path.join(outputDirectory, 'assets'), {
  recursive: true,
  force: true,
});
await stagePrivateMediaTools(outputDirectory, { archivePath: process.env.NOVELTEA_FFMPEG_ARCHIVE });

// Certify from a relocated tree, with no Node modules, source files, or
// dynamic island available. The packaged path is the same path users execute.
const relocatedRoot = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-relocation-'));
try {
  for (const filename of [executableName, runnerName]) {
    await cp(path.join(outputDirectory, filename), path.join(relocatedRoot, filename));
  }
  for (const directory of ['assets', 'tools']) {
    await cp(path.join(outputDirectory, directory), path.join(relocatedRoot, directory), {
      recursive: true,
    });
  }
  const cli = path.join(relocatedRoot, executableName);
  run(cli, ['--json', '--version'], { cwd: os.tmpdir() });
  run(cli, ['--json', 'media-tool', 'check'], { cwd: os.tmpdir() });
  const project = path.join(relocatedRoot, 'smoke-project');
  run(cli, ['--no-daemon', '--json', 'project', 'create', project, '--name', 'Smoke'], {
    cwd: os.tmpdir(),
  });
  const validation = spawnSync(cli, ['--no-daemon', '--json', '--project', project, 'validate'], {
    cwd: os.tmpdir(),
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (validation.error) throw validation.error;
  let response;
  try {
    response = JSON.parse(validation.stdout);
  } catch {
    throw new Error(`Relocated native CLI returned invalid JSON: ${validation.stdout}`);
  }
  if (
    validation.status !== 4 ||
    validation.stderr !== '' ||
    !response.diagnostics?.some((item) => item.code === 'COMPILER_ENTRYPOINT_REQUIRED')
  )
    throw new Error(
      `Relocated native Project validation failed: ${validation.stdout} ${validation.stderr}`,
    );
} finally {
  await removeCliRelocation(relocatedRoot);
}

// This proof binds the exact installed executable. Emitted Electron bundle
// provenance is checked independently; no JS island is part of the CLI.
await writeFile(
  path.join(outputDirectory, 'native-production-build.json'),
  `${JSON.stringify({
    contract: 'noveltea.native-cli-production-build.v2',
    runtime: 'direct-cxx',
    executableSha256: sha256(await readFile(outputPath)),
    uiTestRunnerSha256: sha256(await readFile(path.join(outputDirectory, runnerName))),
  })}\n`,
);
console.log(`NovelTea native CLI: ${outputPath}`);
