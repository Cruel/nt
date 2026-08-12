import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(editorRoot, '..');
const scriptcVersion = '0.0.26';
const scriptcBinary = path.join(editorRoot, 'node_modules', '.bin', 'scriptc');
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
const agentKitSourcePaths = [
  'CLI.md',
  'GUIDE.md',
  'PROJECT_FORMAT.md',
  'docs/ASSETS_SHADERS.md',
  'docs/AUTHORING.md',
  'docs/LAYOUTS.md',
  'docs/LUA.md',
  'docs/TESTS.md',
  'skill/SKILL.md',
];
const islandBundle = path.join(editorRoot, 'dist-scriptc-island', 'noveltea-scriptc-island.cjs');
const islandDeclaration = path.join(editorRoot, 'scripts', 'noveltea-scriptc-island.d.ts');
const hostSource = path.join(editorRoot, 'scripts', 'noveltea-scriptc-host.ts');
const staticContractsSource = path.join(editorRoot, 'src', 'cli', 'static-contracts.ts');

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
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error(
    `NovelTea CLI release builds currently support Linux x64 hosts only; received ${process.platform}/${process.arch}.`,
  );
if (!process.env.VCPKG_ROOT)
  throw new Error('VCPKG_ROOT is required for the native tooling release build.');
if (!existsSync(scriptcBinary))
  throw new Error(`Pinned scriptc ${scriptcVersion} is not installed. Run pnpm install first.`);

const clangCheck = spawnSync('clang', ['--version'], { encoding: 'utf8' });
if (clangCheck.error?.code === 'ENOENT' || clangCheck.status !== 0)
  throw new Error('NovelTea CLI release builds require clang on PATH for scriptc.');
if (clangCheck.error) throw clangCheck.error;

const versionCheck = spawnSync(scriptcBinary, ['--version'], { cwd: editorRoot, encoding: 'utf8' });
if (versionCheck.error) throw versionCheck.error;
if (versionCheck.status !== 0 || versionCheck.stdout.trim() !== scriptcVersion)
  throw new Error(
    `NovelTea CLI requires scriptc ${scriptcVersion}; received '${versionCheck.stdout.trim() || 'unknown'}'.`,
  );

const buildEnv = { ...process.env, NODE_ENV: 'production' };
const prebuiltShadercRoot = process.env.NOVELTEA_PREBUILT_SHADERC_ROOT;
const shadercProviderArguments = prebuiltShadercRoot
  ? [`-DNOVELTEA_PREBUILT_SHADERC_ROOT=${prebuiltShadercRoot}`]
  : [];

async function stagePrebuiltShadercLinkClosure() {
  if (!prebuiltShadercRoot) return;
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
  const linkDirectory = path.join(repositoryRoot, 'build', 'linux-release', 'tools', 'editor_tool');
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
    'linux-release',
    '-DBUILD_TESTING=OFF',
    '-DNOVELTEA_COMPILE_SHADERS=OFF',
    '-DNOVELTEA_CMAKE_STAGE_RUNTIME_ASSETS=OFF',
    ...shadercProviderArguments,
  ],
  { env: buildEnv },
);
run('cmake', ['--build', '--preset', 'linux-release', '--target', 'noveltea_tooling_native'], {
  env: buildEnv,
});
await stagePrebuiltShadercLinkClosure();

run('pnpm', ['exec', 'vp', 'pack'], { cwd: editorRoot, env: buildEnv });
if (!existsSync(islandBundle))
  throw new Error(`Scriptc island bundle was not produced: ${islandBundle}`);

const buildRoot = path.join(repositoryRoot, 'build', 'linux-release');
const editorToolRoot = path.join(buildRoot, 'tools', 'editor_tool');
const engineRoot = path.join(buildRoot, 'engine');
const vcpkgLibRoot = path.join(buildRoot, 'vcpkg_installed', 'x64-linux-noveltea', 'lib');
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

const libraries = [
  archive(path.join(editorToolRoot, 'libnoveltea_tooling_native.a')),
  archive(path.join(engineRoot, 'libnoveltea_presentation.a')),
  archive(path.join(engineRoot, 'libnoveltea_script_lua.a')),
  archive(path.join(engineRoot, 'libnoveltea_runtime.a')),
  archive(path.join(vcpkgLibRoot, 'liblua.a')),
  archive(path.join(editorToolRoot, 'libnoveltea_shader_tooling.a')),
  archive(path.join(engineRoot, 'libnoveltea_content.a')),
  archive(path.join(engineRoot, 'libnoveltea_domain.a')),
  archive(path.join(vcpkgLibRoot, 'libminiz.a')),
  archive(path.join(editorToolRoot, 'libnoveltea_bgfx_shaderc_embedded.a')),
  archive(path.join(editorToolRoot, 'libfcpp.a'), path.join(shadercBgfxRoot, 'libfcpp.a')),
  archive(path.join(editorToolRoot, 'libglslang.a'), path.join(shadercBgfxRoot, 'libglslang.a')),
  archive(
    path.join(editorToolRoot, 'libglsl-optimizer.a'),
    path.join(shadercBgfxRoot, 'libglsl-optimizer.a'),
  ),
  archive(
    path.join(editorToolRoot, 'libspirv-opt.a'),
    path.join(shadercBgfxRoot, 'libspirv-opt.a'),
  ),
  archive(
    path.join(editorToolRoot, 'libspirv-cross.a'),
    path.join(shadercBgfxRoot, 'libspirv-cross.a'),
  ),
  archive(path.join(editorToolRoot, 'libbimg.a'), path.join(shadercBimgRoot, 'libbimg.a')),
  archive(path.join(editorToolRoot, 'libbx.a'), path.join(shadercBxRoot, 'libbx.a')),
];

const outputDirectory = path.join(repositoryRoot, 'build', 'cli', 'linux');
const outputPath = path.join(outputDirectory, 'noveltea');
await mkdir(outputDirectory, { recursive: true });
await rm(stageRoot, { recursive: true, force: true });
await mkdir(islandPackageRoot, { recursive: true });
await mkdir(agentKitSourcePackageRoot, { recursive: true });

try {
  await cp(islandBundle, path.join(islandPackageRoot, 'index.cjs'));
  await writeFile(
    path.join(islandPackageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'noveltea-scriptc-island',
        version: '1.0.0',
        private: true,
        main: 'index.cjs',
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
  await writeFile(
    path.join(agentKitSourcePackageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'noveltea-scriptc-agent-kit-source',
        version: '1.0.0',
        private: true,
        main: 'index.cjs',
        types: 'index.d.ts',
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(agentKitSourcePackageRoot, 'index.cjs'),
    `exports.scriptcAgentKitSourceFiles = Object.freeze(${JSON.stringify(agentKitSourceFiles)});\n`,
  );
  await writeFile(
    path.join(agentKitSourcePackageRoot, 'index.d.ts'),
    'export declare const scriptcAgentKitSourceFiles: Readonly<Record<string, string>>;\n',
  );

  const stagedHost = path.join(stageRoot, 'noveltea-scriptc-host.ts');
  const stagedStaticContracts = path.join(stageRoot, 'static-contracts.ts');
  const stagedHostSource = (await readFile(hostSource, 'utf8'))
    .replace('../src/cli/static-contracts', './static-contracts')
    .replace(
      '      // @ts-expect-error The private island package is materialized only during release staging.\n',
      '',
    );
  await cp(staticContractsSource, stagedStaticContracts);
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
        system_libraries: ['m', 'dl', 'rt', 'stdc++'],
      },
      null,
      2,
    )}\n`,
  );

  run(
    scriptcBinary,
    ['build', stagedHost, '--dynamic', '--ffi', ffiPath, '--out', outputPath, '--no-keep-c'],
    { cwd: stageRoot, env: buildEnv },
  );
  run('strip', ['--strip-all', outputPath], { env: buildEnv });
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}

console.log(`NovelTea CLI: ${outputPath}`);
