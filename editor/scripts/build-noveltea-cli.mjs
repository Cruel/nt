import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readNovelTeaVersion } from '../../scripts/noveltea-version.mjs';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(editorRoot, '..');
const { version: productVersion } = readNovelTeaVersion(repositoryRoot);
const scriptcVersion = '0.0.30';
const isWindows = process.platform === 'win32';
const releasePlatform = isWindows ? 'windows' : 'linux';
const releasePreset = isWindows ? 'windows-cli-gnu' : 'linux-release';
const releaseTriplet = isWindows ? 'x64-mingw-static-noveltea' : 'x64-linux-noveltea';
const executableName = isWindows ? 'noveltea.exe' : 'noveltea';
const scriptcEntrypoint = path.join(editorRoot, 'node_modules', 'scriptc', 'dist', 'main.js');
const vitePlusEntrypoint = path.join(editorRoot, 'node_modules', 'vite-plus', 'bin', 'vp');
const scriptcRoot = path.join(
  repositoryRoot,
  'build',
  'host-tools',
  'scriptc',
  `v${scriptcVersion}`,
);
const stageRoot = path.join(scriptcRoot, 'stage');
const islandPackageRoot = path.join(stageRoot, 'node_modules', 'noveltea-scriptc-island');
const agentKitSourcePackageRoot = path.join(
  stageRoot,
  'node_modules',
  'noveltea-scriptc-agent-kit-source',
);
const agentKitProvenancePath = path.join(editorRoot, 'agent-kit-provenance.json');
const agentKitSourcePaths = [
  'CLI.md',
  'GUIDE.md',
  'PROJECT_FORMAT.md',
  'docs/ASSETS_SHADERS.md',
  'docs/AUTHORING.md',
  'docs/INTERACTIONS.md',
  'docs/ROOMS.md',
  'docs/LAYOUTS.md',
  'docs/RMLUI.md',
  'docs/RCSS_REFERENCE.md',
  'docs/LUA.md',
  'docs/TESTS.md',
];
const islandBundle = path.join(editorRoot, 'dist-scriptc-island', 'noveltea-scriptc-island.mjs');
const islandDeclaration = path.join(editorRoot, 'scripts', 'noveltea-scriptc-island.d.ts');
const hostSource = path.join(editorRoot, 'scripts', 'noveltea-scriptc-host.ts');
const hostProcessSource = path.join(editorRoot, 'scripts', 'noveltea-scriptc-process.ts');
const staticContractsSource = path.join(editorRoot, 'src', 'cli', 'static-contracts.ts');
const productVersionSource = path.join(editorRoot, 'src', 'shared', 'product-version.ts');

if (process.argv.length > 2)
  throw new Error(
    `NovelTea CLI build does not accept arguments: ${process.argv.slice(2).join(' ')}`,
  );

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

if (process.versions.node !== '24.18.0')
  throw new Error(
    `NovelTea CLI release builds require Node 24.18.0; received ${process.versions.node}.`,
  );
if (!['linux', 'win32'].includes(process.platform) || process.arch !== 'x64')
  throw new Error(
    `NovelTea CLI release builds support Linux and Windows x64 hosts; received ${process.platform}/${process.arch}.`,
  );
if (!process.env.VCPKG_ROOT)
  throw new Error('VCPKG_ROOT is required for the native tooling release build.');
if (!existsSync(scriptcEntrypoint))
  throw new Error(`Pinned scriptc ${scriptcVersion} is not installed. Run pnpm install first.`);
if (!existsSync(vitePlusEntrypoint))
  throw new Error('Vite+ is not installed. Run pnpm install first.');

if (isWindows) {
  for (const compiler of ['gcc', 'g++']) {
    const check = spawnSync(compiler, ['--version'], { encoding: 'utf8' });
    if (check.error?.code === 'ENOENT' || check.status !== 0)
      throw new Error(`NovelTea Windows CLI release builds require MinGW ${compiler} on PATH.`);
    if (check.error) throw check.error;
    const targetCheck = spawnSync(compiler, ['-dumpmachine'], { encoding: 'utf8' });
    if (targetCheck.error) throw targetCheck.error;
    if (targetCheck.status !== 0 || !/mingw/i.test(targetCheck.stdout.trim()))
      throw new Error(
        `NovelTea Windows CLI release builds require a MinGW GNU compiler; ${compiler} targets '${targetCheck.stdout.trim() || 'unknown'}'.`,
      );
  }
} else {
  const clangCheck = spawnSync('clang', ['--version'], { encoding: 'utf8' });
  if (clangCheck.error?.code === 'ENOENT' || clangCheck.status !== 0)
    throw new Error('NovelTea Linux CLI release builds require clang on PATH for ScriptC.');
  if (clangCheck.error) throw clangCheck.error;
}

const versionCheck = spawnSync(process.execPath, [scriptcEntrypoint, '--version'], {
  cwd: editorRoot,
  encoding: 'utf8',
});
if (versionCheck.error) throw versionCheck.error;
if (versionCheck.status !== 0 || versionCheck.stdout.trim() !== scriptcVersion)
  throw new Error(
    `NovelTea CLI requires scriptc ${scriptcVersion}; received '${versionCheck.stdout.trim() || 'unknown'}'.`,
  );

const buildEnv = { ...process.env, NODE_ENV: 'production' };
const scriptcBuildEnv = isWindows
  ? {
      ...buildEnv,
      SCRIPTC_CC: 'zigcc',
      SCRIPTC_TARGET: 'x86_64-windows-gnu',
    }
  : buildEnv;
if (isWindows) {
  const zigCheck = spawnSync('zig', ['version'], { encoding: 'utf8' });
  if (zigCheck.error?.code === 'ENOENT' || zigCheck.status !== 0)
    throw new Error('NovelTea Windows CLI release builds require Zig on PATH for ScriptC.');
  if (zigCheck.error) throw zigCheck.error;
}
const prebuiltShadercRoot = process.env.NOVELTEA_PREBUILT_SHADERC_ROOT;
const shadercProviderArguments = prebuiltShadercRoot
  ? [`-DNOVELTEA_PREBUILT_SHADERC_ROOT=${prebuiltShadercRoot}`]
  : [];

async function stagePrebuiltShadercLinkClosure() {
  if (!prebuiltShadercRoot) return;
  if (isWindows)
    throw new Error('NOVELTEA_PREBUILT_SHADERC_ROOT is currently a Linux-only release input.');
  const archives = [
    'libnoveltea_bgfx_shaderc_embedded.a',
    'libfcpp.a',
    'libglslang.a',
    'libglsl-optimizer.a',
    'libspirv-opt.a',
    'libspirv-cross.a',
    'libbimg.a',
    'libbx.a',
  ];
  const linkDirectory = path.join(repositoryRoot, 'build', releasePreset, 'tools', 'editor_tool');
  await mkdir(linkDirectory, { recursive: true });
  for (const archive of archives) {
    const source = path.join(prebuiltShadercRoot, 'lib', archive);
    if (!existsSync(source)) throw new Error(`Prebuilt shaderc archive is missing: ${source}`);
    const destination = path.join(linkDirectory, archive);
    if (existsSync(destination)) {
      const info = await lstat(destination);
      if (!info.isSymbolicLink())
        throw new Error(
          `Refusing to overwrite existing shaderc build artifact: ${destination}. Remove the stale build output before using NOVELTEA_PREBUILT_SHADERC_ROOT.`,
        );
      await rm(destination);
    }
    await symlink(source, destination);
  }
}

run(
  'cmake',
  [
    '--preset',
    releasePreset,
    '-G',
    'Ninja',
    '-DBUILD_TESTING=OFF',
    '-DNOVELTEA_BUILD_HOST_TOOLS=ON',
    '-DNOVELTEA_COMPILE_SHADERS=OFF',
    '-DNOVELTEA_CMAKE_STAGE_RUNTIME_ASSETS=OFF',
    ...shadercProviderArguments,
  ],
  { env: buildEnv },
);
run('cmake', ['--build', '--preset', releasePreset, '--target', 'noveltea_tooling_native'], {
  env: buildEnv,
});
await stagePrebuiltShadercLinkClosure();

run(process.execPath, [vitePlusEntrypoint, 'pack'], { cwd: editorRoot, env: buildEnv });
if (!existsSync(islandBundle))
  throw new Error(`Scriptc island bundle was not produced: ${islandBundle}`);

const buildRoot = path.join(repositoryRoot, 'build', releasePreset);
const editorToolRoot = path.join(buildRoot, 'tools', 'editor_tool');
const engineRoot = path.join(buildRoot, 'engine');
const vcpkgLibRoot = path.join(buildRoot, 'vcpkg_installed', releaseTriplet, 'lib');
const shadercBgfxRoot = path.join(
  buildRoot,
  '_deps',
  'noveltea_bgfx_shaderc_source-build',
  'cmake',
  'bgfx',
);
const shadercBimgRoot = path.join(
  buildRoot,
  '_deps',
  'noveltea_bgfx_shaderc_source-build',
  'cmake',
  'bimg',
);
const shadercBxRoot = path.join(
  buildRoot,
  '_deps',
  'noveltea_bgfx_shaderc_source-build',
  'cmake',
  'bx',
);

function archive(...candidates) {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found)
    throw new Error(`Required NovelTea CLI link archive is missing: ${candidates.join(' or ')}`);
  return found;
}

function staticArchive(root, name) {
  return archive(path.join(root, `${name}.lib`), path.join(root, `lib${name}.a`));
}

function compilerLibrary(command, argument, label) {
  const result = spawnSync(command, [argument], { encoding: 'utf8' });
  if (result.error) throw result.error;
  const candidate = result.stdout.trim();
  if (result.status !== 0 || !candidate || candidate === label || !existsSync(candidate))
    throw new Error(`MinGW ${label} archive is unavailable from ${command} ${argument}.`);
  return candidate;
}

const windowsGnuRuntimeLibraries = isWindows
  ? [
      compilerLibrary('g++', '-print-file-name=libstdc++.a', 'libstdc++.a'),
      compilerLibrary('gcc', '-print-libgcc-file-name', 'libgcc.a'),
      compilerLibrary('gcc', '-print-file-name=libgcc_eh.a', 'libgcc_eh.a'),
      compilerLibrary('gcc', '-print-file-name=libwinpthread.a', 'libwinpthread.a'),
    ]
  : [];

const libraries = [
  staticArchive(editorToolRoot, 'noveltea_tooling_native'),
  staticArchive(engineRoot, 'noveltea_presentation'),
  staticArchive(engineRoot, 'noveltea_script_lua'),
  staticArchive(engineRoot, 'noveltea_runtime'),
  staticArchive(vcpkgLibRoot, 'lua'),
  staticArchive(editorToolRoot, 'noveltea_shader_tooling'),
  staticArchive(engineRoot, 'noveltea_content'),
  staticArchive(engineRoot, 'noveltea_domain'),
  staticArchive(editorToolRoot, 'noveltea_bgfx_shaderc_embedded'),
  archive(
    ...[editorToolRoot, shadercBgfxRoot].flatMap((root) => [
      path.join(root, 'fcpp.lib'),
      path.join(root, 'libfcpp.a'),
    ]),
  ),
  archive(
    ...[editorToolRoot, shadercBgfxRoot].flatMap((root) => [
      path.join(root, 'glslang.lib'),
      path.join(root, 'libglslang.a'),
    ]),
  ),
  archive(
    path.join(editorToolRoot, 'glsl-optimizer.lib'),
    path.join(editorToolRoot, 'libglsl-optimizer.a'),
    path.join(shadercBgfxRoot, 'glsl-optimizer.lib'),
    path.join(shadercBgfxRoot, 'libglsl-optimizer.a'),
  ),
  archive(
    path.join(editorToolRoot, 'spirv-opt.lib'),
    path.join(editorToolRoot, 'libspirv-opt.a'),
    path.join(shadercBgfxRoot, 'spirv-opt.lib'),
    path.join(shadercBgfxRoot, 'libspirv-opt.a'),
  ),
  archive(
    path.join(editorToolRoot, 'spirv-cross.lib'),
    path.join(editorToolRoot, 'libspirv-cross.a'),
    path.join(shadercBgfxRoot, 'spirv-cross.lib'),
    path.join(shadercBgfxRoot, 'libspirv-cross.a'),
  ),
  staticArchive(vcpkgLibRoot, 'bimg_decode'),
  staticArchive(vcpkgLibRoot, 'lodepng'),
  staticArchive(vcpkgLibRoot, 'tinyexr'),
  staticArchive(vcpkgLibRoot, 'miniz'),
  archive(
    ...[editorToolRoot, shadercBimgRoot].flatMap((root) => [
      path.join(root, 'bimg.lib'),
      path.join(root, 'libbimg.a'),
    ]),
  ),
  archive(
    ...[editorToolRoot, shadercBxRoot].flatMap((root) => [
      path.join(root, 'bx.lib'),
      path.join(root, 'libbx.a'),
    ]),
  ),
  ...windowsGnuRuntimeLibraries,
];

const outputDirectory = path.join(repositoryRoot, 'build', 'cli', releasePlatform);
const outputPath = path.join(outputDirectory, executableName);
await mkdir(outputDirectory, { recursive: true });
await rm(stageRoot, { recursive: true, force: true });
await mkdir(islandPackageRoot, { recursive: true });
await mkdir(agentKitSourcePackageRoot, { recursive: true });

try {
  await cp(islandBundle, path.join(islandPackageRoot, 'index.mjs'));
  await writeFile(
    path.join(islandPackageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'noveltea-scriptc-island',
        version: productVersion,
        private: true,
        main: 'index.mjs',
        types: 'index.d.ts',
      },
      null,
      2,
    )}\n`,
  );
  await cp(islandDeclaration, path.join(islandPackageRoot, 'index.d.ts'));

  const agentKitSourceFiles = Object.fromEntries(
    await Promise.all(
      agentKitSourcePaths.map(async (relativePath) => [
        relativePath,
        await readFile(path.join(editorRoot, 'agent-kit', relativePath), 'utf8'),
      ]),
    ),
  );
  const agentKitProvenance = JSON.parse(await readFile(agentKitProvenancePath, 'utf8'));
  await writeFile(
    path.join(agentKitSourcePackageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'noveltea-scriptc-agent-kit-source',
        version: productVersion,
        private: true,
        main: 'index.mjs',
        types: 'index.d.ts',
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(agentKitSourcePackageRoot, 'index.mjs'),
    `export const scriptcAgentKitSourceFiles = Object.freeze(${JSON.stringify(agentKitSourceFiles)});\nexport const scriptcAgentKitProvenance = Object.freeze(${JSON.stringify(agentKitProvenance)});\n`,
  );
  await writeFile(
    path.join(agentKitSourcePackageRoot, 'index.d.ts'),
    'export declare const scriptcAgentKitSourceFiles: Readonly<Record<string, string>>;\nexport declare const scriptcAgentKitProvenance: unknown;\n',
  );

  const stagedHost = path.join(stageRoot, 'noveltea-scriptc-host.ts');
  const stagedHostProcess = path.join(stageRoot, 'noveltea-scriptc-process.ts');
  const stagedStaticContracts = path.join(stageRoot, 'static-contracts.ts');
  const stagedProductVersion = path.join(stageRoot, 'product-version.ts');
  const stagedHostSource = (await readFile(hostSource, 'utf8'))
    .replace('../src/cli/static-contracts', './static-contracts')
    .replace(
      '      // @ts-expect-error The private island package is materialized only during release staging.',
      '',
    );
  const stagedStaticContractsSource = (await readFile(staticContractsSource, 'utf8')).replace(
    '../shared/product-version',
    './product-version',
  );
  const stagedProductVersionSource = (await readFile(productVersionSource, 'utf8')).replace(
    '__NOVELTEA_VERSION__',
    JSON.stringify(productVersion),
  );
  await writeFile(stagedStaticContracts, stagedStaticContractsSource);
  await writeFile(stagedProductVersion, stagedProductVersionSource);
  await cp(hostProcessSource, stagedHostProcess);
  await writeFile(stagedHost, stagedHostSource);
  const ffiPath = path.join(stageRoot, 'ffi.json');
  await writeFile(
    ffiPath,
    `${JSON.stringify(
      {
        ffi_format: 1,
        functions: [
          {
            name: 'nativeInvokeToFile',
            symbol: 'noveltea_tooling_scriptc_invoke_to_file',
            params: ['string', 'string', 'string'],
            returns: 'void',
          },
        ],
        libraries,
        system_libraries: isWindows
          ? ['advapi32', 'bcrypt', 'ole32', 'shell32', 'user32', 'ws2_32']
          : ['m', 'dl', 'rt', 'stdc++'],
      },
      null,
      2,
    )}\n`,
  );

  run(
    process.execPath,
    [
      scriptcEntrypoint,
      'build',
      stagedHost,
      '--dynamic',
      '--ffi',
      ffiPath,
      '--out',
      outputPath,
      '--no-keep-c',
    ],
    { cwd: stageRoot, env: scriptcBuildEnv },
  );
  run(isWindows ? 'llvm-strip' : 'strip', ['--strip-all', outputPath], { env: buildEnv });
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}

console.log(`NovelTea CLI: ${outputPath}`);
