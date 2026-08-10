import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(editorRoot, '..');
const nativeCli = path.resolve(
  process.env.NOVELTEA_CLI_PATH ?? path.join(repositoryRoot, 'build', 'cli', 'linux', 'noveltea'),
);
const nodeCli = path.join(editorRoot, 'dist-electron', 'tools', 'noveltea.mjs');
const fixtureTool = path.join(
  editorRoot,
  'dist-electron',
  'tools',
  'materialize-android-export-fixture.mjs',
);
const bgfxInclude = path.join(
  repositoryRoot,
  'build',
  'linux-release',
  'vcpkg_installed',
  'x64-linux-noveltea',
  'include',
  'bgfx',
);

const typedFragmentGoldens = Object.freeze({
  'glsl-120': '0c6e9745c2d8c970e6712ff589ded92984997585b0292d44fe3d2ffb1edb79d8',
  'essl-100': '60761370f25ccc732c1589d57bdb72be60aee25331676834c8739bbc1ce7087a',
  'essl-300': 'c832f9615c10dce13576a4843cb3f4b9314072ca474aeb5abb0dbae8defb02d3',
});

const rawShaderGoldens = Object.freeze({
  'glsl-120': 'd82504c243210381b4163788cb4c1923859efc47bab8b6733294b5095e0e00e9',
  'essl-100': '4625d9a1ff2acd5f3b0cb3f5f9dcc7eb4c8ec8f05179c78e9f64d0ef16e51b81',
  'essl-300': 'ad8bad426f71f58d1b481dd078b06b2cc07cb68303e12a4e7f664530c5bf4578',
});

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    input: options.stdin,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function requireSuccess(label, result) {
  if (result.status !== 0)
    fail(
      `${label} failed with exit ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  return result;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function treeSnapshot(root) {
  const records = [];
  async function visit(relative = '') {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(root, child);
      const info = await lstat(absolute);
      if (info.isDirectory()) await visit(child);
      else if (info.isSymbolicLink()) records.push(['link', child, await readlink(absolute)]);
      else if (info.isFile()) records.push(['file', child, sha256(await readFile(absolute))]);
    }
  }
  await visit();
  return JSON.stringify(records);
}

async function materializeFixture(root) {
  await rm(root, { recursive: true, force: true });
  const result = run(process.execPath, [fixtureTool, '--root', root, '--target', 'web']);
  requireSuccess('fixture materialization', result);
}

async function makeShaderFree(root) {
  await rm(path.join(root, 'records', 'shaders'), { recursive: true, force: true });
  await rm(path.join(root, 'records', 'materials'), { recursive: true, force: true });
  const foyerPath = path.join(root, 'records', 'rooms', 'foyer.json');
  const foyer = JSON.parse(await readFile(foyerPath, 'utf8'));
  foyer.data.background.material = null;
  await writeJson(foyerPath, foyer);
  await writeFile(
    path.join(root, 'records', 'layouts', 'fixture-hud', 'layout.lua'),
    'local room_id = "gallery"\nfunction save_and_reload() Game.save("fixture"); Game.load("fixture") end\n',
  );
}

async function resetCase(pristine, root) {
  await rm(root, { recursive: true, force: true });
  await cp(pristine, root, { recursive: true });
}

function runNode(args, options = {}) {
  return run(process.execPath, [nodeCli, ...args], options);
}

function runNative(args, options = {}) {
  return run(nativeCli, args, options);
}

function runNativeWithStdinFile(args, stdinPath, options = {}) {
  const stdin = openSync(stdinPath, 'r');
  try {
    const result = spawnSync(nativeCli, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: [stdin, 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } finally {
    closeSync(stdin);
  }
}

async function prepareWritingRecovery(root) {
  const target = 'records/rooms/gallery.json';
  const absolute = path.join(root, target);
  const before = await readFile(absolute);
  const afterJson = JSON.parse(before.toString('utf8'));
  afterJson.label = 'Interrupted Gallery';
  const after = Buffer.from(`${JSON.stringify(afterJson, null, 2)}\n`);
  const transactionId = 'certification-recovery';
  const transactionRoot = path.join(root, '.noveltea', 'transactions', transactionId);
  await mkdir(path.join(transactionRoot, 'before'), { recursive: true });
  await mkdir(path.join(transactionRoot, 'after'), { recursive: true });
  await writeFile(path.join(transactionRoot, 'before', '0'), before);
  await writeFile(path.join(transactionRoot, 'after', '0'), after);
  await writeFile(absolute, after);
  await writeJson(path.join(transactionRoot, 'manifest.json'), {
    schema: 'noveltea.workspace.transaction',
    schemaVersion: 1,
    transactionId,
    state: 'writing',
    writerOwnerToken: 'certification-owner',
    writerPid: process.pid,
    operationLabel: 'CLI certification interrupted write',
    targets: [
      {
        path: target,
        operation: 'write',
        beforeRevision: `sha256:${sha256(before)}`,
        afterRevision: `sha256:${sha256(after)}`,
        beforeBlob: 'before/0',
        afterBlob: 'after/0',
      },
    ],
    completedTargets: [target],
  });
}

const differentialCases = [
  { name: 'version', args: () => ['--json', '--version'], project: false },
  { name: 'help', args: () => ['--help'], project: false },
  { name: 'validate-explicit', args: (root) => ['--project', root, '--json', 'validate'] },
  { name: 'validate-root', args: () => ['--json', 'validate'] },
  { name: 'agent-sync', args: (root) => ['--project', root, '--json', 'agent', 'sync'] },
  {
    name: 'validate-upward',
    args: () => ['--json', 'validate'],
    cwd: (root) => path.join(root, 'records', 'layouts', 'fixture-hud'),
  },
  {
    name: 'missing-project',
    args: (root) => ['--project', path.join(root, 'missing'), '--json', 'validate'],
  },
  {
    name: 'malformed-manifest',
    args: (root) => ['--project', root, '--json', 'validate'],
    prepare: async (root) => writeFile(path.join(root, 'project.json'), '{\n'),
  },
  {
    name: 'unsupported-manifest',
    args: (root) => ['--project', root, '--json', 'validate'],
    prepare: async (root) => {
      const file = path.join(root, 'project.json');
      const value = JSON.parse(await readFile(file, 'utf8'));
      value.schemaVersion = 999;
      await writeJson(file, value);
    },
  },
  { name: 'usages', args: (root) => ['--project', root, '--json', 'usages', 'rooms', 'gallery'] },
  {
    name: 'create-dry-run',
    args: (root) => [
      '--project',
      root,
      '--json',
      'entity',
      'create',
      'rooms',
      'hallway',
      '--dry-run',
    ],
  },
  {
    name: 'create-execute',
    args: (root) => ['--project', root, '--json', 'entity', 'create', 'rooms', 'hallway'],
  },
  {
    name: 'rename-blocked',
    args: (root) => [
      '--project',
      root,
      '--json',
      'entity',
      'rename',
      'rooms',
      'gallery',
      'exhibit',
      '--dry-run',
    ],
  },
  {
    name: 'rename-allowed-dry-run',
    args: (root) => [
      '--project',
      root,
      '--json',
      'entity',
      'rename',
      'rooms',
      'gallery',
      'exhibit',
      '--dry-run',
      '--allow-possible-source-references',
    ],
  },
  {
    name: 'rename-allowed-execute',
    args: (root) => [
      '--project',
      root,
      '--json',
      'entity',
      'rename',
      'rooms',
      'gallery',
      'exhibit',
      '--allow-possible-source-references',
    ],
  },
  {
    name: 'delete-blocked',
    args: (root) => ['--project', root, '--json', 'entity', 'delete', 'rooms', 'gallery'],
  },
  {
    name: 'delete-force-dry-run',
    args: (root) => [
      '--project',
      root,
      '--json',
      'entity',
      'delete',
      'rooms',
      'gallery',
      '--dry-run',
      '--force',
      '--allow-possible-source-references',
    ],
  },
  {
    name: 'delete-force-execute',
    args: (root) => [
      '--project',
      root,
      '--json',
      'entity',
      'delete',
      'rooms',
      'gallery',
      '--force',
      '--allow-possible-source-references',
    ],
  },
  {
    name: 'pending-journal-dry-run',
    args: (root) => [
      '--project',
      root,
      '--json',
      'entity',
      'create',
      'rooms',
      'hallway',
      '--dry-run',
    ],
    prepare: async (root) =>
      writeJson(path.join(root, '.noveltea', 'transactions', 'pending', 'manifest.json'), {}),
  },
  {
    name: 'live-writer',
    args: (root) => ['--project', root, '--json', 'validate'],
    prepare: async (root) =>
      writeJson(path.join(root, '.noveltea', 'transactions', '.writer-lock', 'owner.json'), {
        ownerToken: 'live-certification-owner',
        pid: process.pid,
        operationLabel: 'CLI certification live writer',
        transactionId: null,
      }),
  },
  {
    name: 'malformed-writer',
    args: (root) => ['--project', root, '--json', 'validate'],
    prepare: async (root) =>
      writeJson(path.join(root, '.noveltea', 'transactions', '.writer-lock', 'owner.json'), {}),
  },
  {
    name: 'stale-writer',
    args: (root) => ['--project', root, '--json', 'validate'],
    prepare: async (root) =>
      writeJson(path.join(root, '.noveltea', 'transactions', '.writer-lock', 'owner.json'), {
        ownerToken: 'stale-certification-owner',
        pid: 2147483647,
        operationLabel: 'CLI certification stale writer',
        transactionId: null,
      }),
  },
  {
    name: 'journal-recovery',
    args: (root) => ['--project', root, '--json', 'validate'],
    prepare: prepareWritingRecovery,
  },
  {
    name: 'usage-error',
    args: (root) => ['--project', root, '--json', 'entity', 'rename', 'rooms', 'gallery'],
  },
];

async function runDifferential(tempRoot) {
  const pristine = path.join(tempRoot, 'pristine');
  await materializeFixture(pristine);
  await makeShaderFree(pristine);
  const caseRoot = path.join(tempRoot, 'case');

  for (const test of differentialCases) {
    await resetCase(pristine, caseRoot);
    await test.prepare?.(caseRoot);
    const args = test.args(caseRoot);
    const cwd = test.cwd?.(caseRoot) ?? (test.project === false ? repositoryRoot : caseRoot);
    const nodeResult = runNode(args, { cwd });
    const nodeTree = test.project === false ? '' : await treeSnapshot(caseRoot);

    await resetCase(pristine, caseRoot);
    await test.prepare?.(caseRoot);
    const perryResult = runNative(args, { cwd: test.cwd?.(caseRoot) ?? cwd });
    const perryTree = test.project === false ? '' : await treeSnapshot(caseRoot);

    for (const field of ['status', 'stdout', 'stderr']) {
      if (perryResult[field] !== nodeResult[field])
        fail(
          `Node/Perry differential '${test.name}' differs in ${field}.\nNode: ${String(nodeResult[field])}\nPerry: ${String(perryResult[field])}`,
        );
    }
    if (perryTree !== nodeTree)
      fail(`Node/Perry differential '${test.name}' produced different filesystem state.`);
    process.stdout.write(`[differential] ${test.name}: PASS\n`);
  }
  return { pristine };
}

async function certifyTypedShaders(tempRoot) {
  const root = path.join(tempRoot, 'native-shaders');
  await materializeFixture(root);
  const result = requireSuccess(
    'typed shader compile',
    runNative(['--project', root, '--json', 'shaders', 'compile', '--force-rebuild']),
  );
  const payload = JSON.parse(result.stdout);
  const outputs = payload.native?.outputs;
  if (!Array.isArray(outputs) || outputs.length !== 6)
    fail(
      `Typed shader compile returned ${Array.isArray(outputs) ? outputs.length : 'invalid'} outputs.`,
    );
  for (const [variant, expected] of Object.entries(typedFragmentGoldens)) {
    const output = outputs.find(
      (candidate) =>
        candidate.variant === variant &&
        candidate.shader === 'fixture-shader' &&
        candidate.stage === 'fragment',
    );
    if (!output || output.byteHash !== `sha256:${expected}`)
      fail(`Typed shader golden mismatch for ${variant}: ${output?.byteHash ?? 'missing'}.`);
  }
}

async function certifyRawShaderc(tempRoot) {
  const source = path.join(repositoryRoot, 'engine', 'shaders', 'bgfx', 'vs_triangle.sc');
  const includeSource = path.join(repositoryRoot, 'engine', 'shaders', 'bgfx');
  const variants = [
    ['glsl-120', 'linux', '120'],
    ['essl-100', 'asm.js', '100_es'],
    ['essl-300', 'android', '300_es'],
  ];
  for (const [variant, platform, profile] of variants) {
    const output = path.join(tempRoot, `${variant}.bin`);
    requireSuccess(
      `raw shaderc ${variant}`,
      runNative([
        'shaderc',
        '-f',
        source,
        '-o',
        output,
        '--type',
        'vertex',
        '--platform',
        platform,
        '--profile',
        profile,
        '-i',
        includeSource,
        '-i',
        bgfxInclude,
      ]),
    );
    const actual = sha256(await readFile(output));
    if (actual !== rawShaderGoldens[variant])
      fail(
        `Raw shaderc golden mismatch for ${variant}: expected ${rawShaderGoldens[variant]}, got ${actual}.`,
      );
  }
  const invalid = runNative(['shaderc', '--noveltea-certification-invalid-option']);
  if (invalid.status === 0)
    fail('Raw shaderc invalid-option certification unexpectedly succeeded.');
}

async function certifyNativeOperations(tempRoot, pristine) {
  const root = path.join(tempRoot, 'native-operations');
  await resetCase(pristine, root);
  const playback = `${JSON.stringify({
    schema: 'noveltea.editor.playback',
    version: 2,
    id: 'certification-empty',
    steps: [],
  })}\n`;
  const playbackPath = path.join(tempRoot, 'empty-playback.json');
  await writeFile(playbackPath, playback);
  requireSuccess(
    'headless playback',
    runNativeWithStdinFile(['--project', root, '--json', 'test', 'run-spec'], playbackPath, {
      cwd: root,
    }),
  );
  requireSuccess(
    'UI playback',
    runNativeWithStdinFile(['--project', root, '--json', 'test', 'run-ui-spec'], playbackPath, {
      cwd: root,
    }),
  );
  const output = path.join(tempRoot, 'certification.ntpkg');
  requireSuccess(
    'package export',
    runNative(['--project', root, '--json', 'package', 'export', '--output', output], {
      cwd: root,
    }),
  );
  if (!(await stat(output)).isFile())
    fail('Package export did not produce the requested output file.');
}

async function certifyRelocation(tempRoot) {
  const relocated = path.join(tempRoot, 'relocated', 'bin', 'noveltea');
  await mkdir(path.dirname(relocated), { recursive: true });
  await cp(nativeCli, relocated);
  const env = {
    HOME: path.join(tempRoot, 'relocated-home'),
    LANG: 'C.UTF-8',
    PATH: '/usr/bin:/bin',
  };
  const result = requireSuccess('relocated CLI', run(relocated, ['--json', '--version'], { env }));
  const payload = JSON.parse(result.stdout);
  if (payload.version !== '1.0.0')
    fail(`Relocated CLI returned unexpected version '${payload.version}'.`);

  const closure = requireSuccess('CLI ldd audit', run('ldd', [relocated], { env })).stdout;
  if (/\b(?:node|perry|shaderc)\b/i.test(closure))
    fail(`Standalone CLI has a forbidden runtime dependency:\n${closure}`);
  return closure
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    fail(
      `CLI certification is currently admitted only on Linux x64; received ${process.platform}/${process.arch}.`,
    );
  if (!(await stat(nativeCli)).isFile()) fail(`NovelTea CLI is missing: ${nativeCli}`);
  if (!(await stat(path.join(bgfxInclude, 'bgfx_shader.sh'))).isFile())
    fail(`bgfx shader include is missing: ${bgfxInclude}`);

  requireSuccess(
    'Node-reference bundle build',
    run('pnpm', ['exec', 'vp', 'pack'], { cwd: editorRoot }),
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'noveltea-cli-certification-'));
  try {
    const { pristine } = await runDifferential(tempRoot);
    await certifyTypedShaders(tempRoot);
    await certifyRawShaderc(tempRoot);
    await certifyNativeOperations(tempRoot, pristine);
    const closure = await certifyRelocation(tempRoot);
    const binarySize = (await stat(nativeCli)).size;
    process.stdout.write(
      `${JSON.stringify({
        success: true,
        differentialCases: differentialCases.length,
        typedShaderVariants: Object.keys(typedFragmentGoldens),
        rawShaderVariants: Object.keys(rawShaderGoldens),
        nativeOperations: ['shader-compile', 'raw-shaderc', 'test', 'ui-test', 'package-export'],
        relocation: true,
        binarySize,
        linkedClosure: closure,
      })}\n`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
