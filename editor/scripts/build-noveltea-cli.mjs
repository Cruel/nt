import { existsSync, realpathSync } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readNovelTeaBuildIdentity, readNovelTeaVersion } from '../../scripts/noveltea-version.mjs';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(editorRoot, '..');
const { version: productVersion } = readNovelTeaVersion(repositoryRoot);
const buildIdentity = readNovelTeaBuildIdentity(repositoryRoot);
const scriptcVersion = '0.1.3';
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const releasePlatform = isWindows ? 'windows' : isMac ? 'macos' : 'linux';
const releasePreset = isWindows ? 'windows-cli-gnu' : isMac ? 'macos-release' : 'linux-release';
const releaseTriplet = isWindows
  ? 'x64-mingw-static-noveltea'
  : isMac
    ? 'arm64-osx-noveltea'
    : 'x64-linux-noveltea';
const buildRoot = path.join(repositoryRoot, 'build', releasePreset);
const executableName = isWindows ? 'noveltea.exe' : 'noveltea';
const uiTestRunnerName = isWindows ? 'noveltea-ui-test-runner.exe' : 'noveltea-ui-test-runner';
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
const comfyUiWorkflowPackageRoot = path.join(
  stageRoot,
  'node_modules',
  'noveltea-scriptc-comfyui-workflows',
);
const comfyUiWorkflowSourceRoot = path.join(editorRoot, 'assets', 'comfyui', 'workflows');
const agentKitSourceRoot = path.join(editorRoot, 'agent-kit');
const agentKitProvenancePath = path.join(editorRoot, 'agent-kit-provenance.json');
const agentKitSystemLayoutSourceRoot = path.join(repositoryRoot, 'engine', 'assets', 'system');
async function collectUtf8Files(root, directory, files = {}) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectUtf8Files(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Expected regular file while collecting ${absolutePath}`);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    files[relativePath] = await readFile(absolutePath, 'utf8');
  }
  return files;
}

const islandBundleRoot = path.join(editorRoot, 'dist-scriptc-island');
const islandBundle = path.join(islandBundleRoot, 'noveltea-scriptc-island.mjs');
const islandDeclaration = path.join(editorRoot, 'scripts', 'noveltea-scriptc-island.d.ts');
const hostSource = path.join(editorRoot, 'scripts', 'noveltea-scriptc-host.ts');
const hostProcessSource = path.join(editorRoot, 'scripts', 'noveltea-scriptc-process.ts');
const staticContractsSource = path.join(editorRoot, 'src', 'cli', 'static-contracts.ts');
const schemaStaticContractsSource = path.join(
  editorRoot,
  'src',
  'shared',
  'schema-static-contracts.ts',
);
const commandRoutingSource = path.join(editorRoot, 'src', 'cli', 'command-routing.ts');
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

async function resolveCmakeCommand() {
  const cachePath = path.join(buildRoot, 'CMakeCache.txt');
  if (!existsSync(cachePath)) return 'cmake';
  const cache = await readFile(cachePath, 'utf8');
  const match = /^CMAKE_COMMAND:INTERNAL=(.+)$/mu.exec(cache);
  const cachedCommand = match?.[1]?.trim();
  return cachedCommand && existsSync(cachedCommand) ? cachedCommand : 'cmake';
}

if (process.versions.node !== '24.18.0')
  throw new Error(
    `NovelTea CLI release builds require Node 24.18.0; received ${process.versions.node}.`,
  );
const supportedHost =
  (process.platform === 'linux' && process.arch === 'x64') ||
  (process.platform === 'win32' && process.arch === 'x64') ||
  (process.platform === 'darwin' && process.arch === 'arm64');
if (!supportedHost)
  throw new Error(
    `NovelTea CLI release builds support Linux x64, Windows x64, and macOS arm64 hosts; received ${process.platform}/${process.arch}.`,
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
    throw new Error('NovelTea POSIX CLI release builds require clang on PATH for ScriptC.');
  if (clangCheck.error) throw clangCheck.error;
}

async function ensureScriptcNativeHelperExecutable() {
  if (isWindows) return;
  const scriptcRequire = createRequire(realpathSync(scriptcEntrypoint));
  const compilerEntrypoint = scriptcRequire.resolve('@scriptc/compiler');
  const compilerRequire = createRequire(compilerEntrypoint);
  const helperPackage = isMac ? '@scriptc/llvm-darwin-arm64' : '@scriptc/llvm-linux-x64-gnu';
  let helperPackageJson;
  try {
    helperPackageJson = compilerRequire.resolve(`${helperPackage}/package.json`);
  } catch {
    throw new Error(
      `Pinned scriptc LLVM helper ${helperPackage} is not installed. Run pnpm install with optional dependencies enabled.`,
    );
  }
  const helperBinary = path.join(path.dirname(helperPackageJson), 'bin', 'scriptc-llvm-codegen');
  await chmod(helperBinary, 0o755);
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
await ensureScriptcNativeHelperExecutable();

const buildEnv = {
  ...process.env,
  NODE_ENV: 'production',
  NOVELTEA_BUILD_IDENTITY: buildIdentity,
};
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
const cmakeCommand = await resolveCmakeCommand();

async function stagePrebuiltShadercLinkClosure() {
  if (!prebuiltShadercRoot) return;
  if (process.platform !== 'linux')
    throw new Error('NOVELTEA_PREBUILT_SHADERC_ROOT is currently a Linux-only release input.');
  const archives = [
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
  cmakeCommand,
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
run(cmakeCommand, ['--build', '--preset', releasePreset, '--target', 'noveltea_tooling_native'], {
  env: buildEnv,
});
await stagePrebuiltShadercLinkClosure();

run(process.execPath, [vitePlusEntrypoint, 'pack'], { cwd: editorRoot, env: buildEnv });
if (!existsSync(islandBundle))
  throw new Error(`Scriptc island bundle was not produced: ${islandBundle}`);

const editorToolRoot = path.join(buildRoot, 'tools', 'editor_tool');
const engineRoot = path.join(buildRoot, 'engine');
const vcpkgLibRoot = path.join(buildRoot, 'vcpkg_installed', releaseTriplet, 'lib');
const bgfxBuildRoot = path.join(buildRoot, '_deps', 'bgfx.cmake-build', 'cmake');
const shadercBgfxRoot = path.join(bgfxBuildRoot, 'bgfx');
const shadercBimgRoot = path.join(bgfxBuildRoot, 'bimg');
const shadercBxRoot = path.join(bgfxBuildRoot, 'bx');

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
  staticArchive(editorToolRoot, 'noveltea_text_tooling'),
  staticArchive(editorToolRoot, 'noveltea_bimg_texturec_embedded'),
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
      path.join(root, 'glslang.lib'),
      path.join(root, 'libglslang.a'),
    ]),
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
  archive(
    path.join(editorToolRoot, 'tint.lib'),
    path.join(editorToolRoot, 'libtint.a'),
    path.join(shadercBgfxRoot, 'tint.lib'),
    path.join(shadercBgfxRoot, 'libtint.a'),
  ),
  archive(
    ...[editorToolRoot, shadercBimgRoot, vcpkgLibRoot].flatMap((root) => [
      path.join(root, 'bimg_decode.lib'),
      path.join(root, 'libbimg_decode.a'),
    ]),
  ),
  archive(
    ...[editorToolRoot, shadercBimgRoot, vcpkgLibRoot].flatMap((root) => [
      path.join(root, 'bimg_encode.lib'),
      path.join(root, 'libbimg_encode.a'),
    ]),
  ),
  staticArchive(vcpkgLibRoot, 'harfbuzz'),
  staticArchive(vcpkgLibRoot, 'freetype'),
  staticArchive(vcpkgLibRoot, 'SheenBidi'),
  staticArchive(vcpkgLibRoot, 'unibreak'),
  staticArchive(vcpkgLibRoot, 'png16'),
  staticArchive(vcpkgLibRoot, 'bz2'),
  staticArchive(vcpkgLibRoot, 'brotlidec'),
  staticArchive(vcpkgLibRoot, 'brotlicommon'),
  isWindows ? archive(path.join(vcpkgLibRoot, 'libzs.a')) : staticArchive(vcpkgLibRoot, 'z'),
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
await mkdir(comfyUiWorkflowPackageRoot, { recursive: true });

try {
  await cp(islandBundleRoot, islandPackageRoot, { recursive: true });
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

  const comfyUiWorkflowFiles = await collectUtf8Files(
    comfyUiWorkflowSourceRoot,
    comfyUiWorkflowSourceRoot,
  );
  await writeFile(
    path.join(comfyUiWorkflowPackageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'noveltea-scriptc-comfyui-workflows',
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
    path.join(comfyUiWorkflowPackageRoot, 'index.mjs'),
    `export const scriptcComfyUiWorkflowFiles = Object.freeze(${JSON.stringify(comfyUiWorkflowFiles)});\n`,
  );
  await writeFile(
    path.join(comfyUiWorkflowPackageRoot, 'index.d.ts'),
    'export declare const scriptcComfyUiWorkflowFiles: Readonly<Record<string, string>>;\n',
  );

  const agentKitSourceFiles = await collectUtf8Files(agentKitSourceRoot, agentKitSourceRoot);
  const agentKitProvenance = JSON.parse(await readFile(agentKitProvenancePath, 'utf8'));
  const agentKitSystemLayoutSourceFiles = await collectUtf8Files(
    agentKitSystemLayoutSourceRoot,
    path.join(agentKitSystemLayoutSourceRoot, 'ui'),
  );
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
    `export const scriptcAgentKitSourceFiles = Object.freeze(${JSON.stringify(agentKitSourceFiles)});\nexport const scriptcAgentKitProvenance = Object.freeze(${JSON.stringify(agentKitProvenance)});\nexport const scriptcAgentKitSystemLayoutSourceFiles = Object.freeze(${JSON.stringify(agentKitSystemLayoutSourceFiles)});\n`,
  );
  await writeFile(
    path.join(agentKitSourcePackageRoot, 'index.d.ts'),
    'export declare const scriptcAgentKitSourceFiles: Readonly<Record<string, string>>;\nexport declare const scriptcAgentKitProvenance: unknown;\nexport declare const scriptcAgentKitSystemLayoutSourceFiles: Readonly<Record<string, string>>;\n',
  );

  const stagedHost = path.join(stageRoot, 'noveltea-scriptc-host.ts');
  const stagedHostProcess = path.join(stageRoot, 'noveltea-scriptc-process.ts');
  const stagedStaticContracts = path.join(stageRoot, 'static-contracts.ts');
  const stagedSchemaStaticContracts = path.join(stageRoot, 'schema-static-contracts.ts');
  const stagedCommandRouting = path.join(stageRoot, 'command-routing.ts');
  const stagedProductVersion = path.join(stageRoot, 'product-version.ts');
  const stagedHostSource = (await readFile(hostSource, 'utf8'))
    .replace('../src/cli/static-contracts', './static-contracts')
    .replace('../src/cli/command-routing', './command-routing')
    .replaceAll(
      '// @ts-expect-error The private island package is materialized only during release staging.',
      '',
    );
  const stagedStaticContractsSource = (await readFile(staticContractsSource, 'utf8'))
    .replace('../shared/product-version', './product-version')
    .replace('../shared/schema-static-contracts', './schema-static-contracts');
  const stagedProductVersionSource = (await readFile(productVersionSource, 'utf8'))
    .replace('__NOVELTEA_VERSION__', JSON.stringify(productVersion))
    .replace('__NOVELTEA_BUILD_IDENTITY__', JSON.stringify(buildIdentity));
  await writeFile(stagedStaticContracts, stagedStaticContractsSource);
  await cp(schemaStaticContractsSource, stagedSchemaStaticContracts);
  await cp(commandRoutingSource, stagedCommandRouting);
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
          {
            name: 'nativeRunQuickJsGc',
            symbol: 'noveltea_tooling_scriptc_run_gc',
            params: [],
            returns: 'void',
          },
          {
            name: 'nativeSetQuickJsGcThreshold',
            symbol: 'noveltea_tooling_scriptc_set_gc_threshold',
            params: ['u32'],
            returns: 'void',
          },
        ],
        libraries,
        system_libraries: isWindows
          ? ['advapi32', 'bcrypt', 'ole32', 'shell32', 'user32', 'ws2_32']
          : isMac
            ? ['c++']
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
  run(isWindows ? 'llvm-strip' : 'strip', [isMac ? '-x' : '--strip-all', outputPath], {
    env: buildEnv,
  });

  const uiTestRunnerSource = path.join(buildRoot, 'tools', 'editor_tool', uiTestRunnerName);
  if (!existsSync(uiTestRunnerSource))
    throw new Error(`NovelTea UI Test runner is missing: ${uiTestRunnerSource}`);
  const uiTestRunnerOutput = path.join(outputDirectory, uiTestRunnerName);
  await cp(uiTestRunnerSource, uiTestRunnerOutput);
  run(isWindows ? 'llvm-strip' : 'strip', [isMac ? '-x' : '--strip-all', uiTestRunnerOutput], {
    env: buildEnv,
  });
  if (!isWindows) await chmod(uiTestRunnerOutput, 0o755);

  await cp(
    path.join(repositoryRoot, 'engine', 'assets', 'system'),
    path.join(outputDirectory, 'assets', 'system'),
    { recursive: true, dereference: true },
  );
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}

console.log(`NovelTea CLI: ${outputPath}`);
