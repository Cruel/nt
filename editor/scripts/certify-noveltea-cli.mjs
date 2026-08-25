import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
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

import { readNovelTeaVersion } from '../../scripts/noveltea-version.mjs';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(editorRoot, '..');
const { version: productVersion } = readNovelTeaVersion(repositoryRoot);
const isWindows = process.platform === 'win32';
const releasePlatform = isWindows ? 'windows' : 'linux';
const releasePreset = isWindows ? 'windows-cli-gnu' : 'linux-release';
const releaseTriplet = isWindows ? 'x64-mingw-static-noveltea' : 'x64-linux-noveltea';
const executableName = isWindows ? 'noveltea.exe' : 'noveltea';
const nativeCli = path.resolve(
  process.env.NOVELTEA_CLI_PATH ??
    path.join(repositoryRoot, 'build', 'cli', releasePlatform, executableName),
);
const nodeCli = path.join(editorRoot, 'dist-electron', 'tools', 'noveltea.mjs');
const comfyUiCertificationServer = path.join(
  editorRoot,
  'scripts',
  'comfyui-certification-server.mjs',
);
const fixtureTool = path.join(
  editorRoot,
  'dist-electron',
  'tools',
  'materialize-android-export-fixture.mjs',
);
const bgfxInclude = path.join(
  repositoryRoot,
  'build',
  releasePreset,
  'vcpkg_installed',
  releaseTriplet,
  'include',
  'bgfx',
);

const typedFragmentGoldens = Object.freeze({
  'glsl-120': '0c6e9745c2d8c970e6712ff589ded92984997585b0292d44fe3d2ffb1edb79d8',
  'essl-100': '60761370f25ccc732c1589d57bdb72be60aee25331676834c8739bbc1ce7087a',
  'essl-300': 'c832f9615c10dce13576a4843cb3f4b9314072ca474aeb5abb0dbae8defb02d3',
  metal: '7e0b1c86f64928f0b9c60fc2a849f831d81351af713d8b7a7872cb97fe9fa917',
});

const rawShaderGoldens = Object.freeze({
  'glsl-120': 'd82504c243210381b4163788cb4c1923859efc47bab8b6733294b5095e0e00e9',
  'essl-100': '4625d9a1ff2acd5f3b0cb3f5f9dcc7eb4c8ec8f05179c78e9f64d0ef16e51b81',
  'essl-300': 'ad8bad426f71f58d1b481dd078b06b2cc07cb68303e12a4e7f664530c5bf4578',
  metal: 'e95a26f5c321473cada296c5e0b936a8cf26d88e9412ae3dd73e7c61f0a7cf82',
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

function runPnpm(args, options = {}) {
  const pnpmEntrypoint = process.env.npm_execpath;
  if (pnpmEntrypoint) return run(process.execPath, [pnpmEntrypoint, ...args], options);
  return run(isWindows ? 'pnpm.cmd' : 'pnpm', args, options);
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

async function verifyWindowsPeStackReserve() {
  if (!isWindows) return null;
  const binary = await readFile(nativeCli);
  if (binary.length < 0x40) fail('Standalone CLI is too small to contain a PE header.');
  const peOffset = binary.readUInt32LE(0x3c);
  const optionalHeaderOffset = peOffset + 24;
  if (optionalHeaderOffset + 80 > binary.length)
    fail('Standalone CLI has a truncated PE optional header.');
  if (binary.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0')
    fail('Standalone CLI is not a valid PE image.');
  const magic = binary.readUInt16LE(optionalHeaderOffset);
  if (magic !== 0x20b)
    fail(`Standalone CLI is not PE32+ (optional header magic 0x${magic.toString(16)}).`);
  const stackReserveBytes = Number(binary.readBigUInt64LE(optionalHeaderOffset + 72));
  if (!Number.isSafeInteger(stackReserveBytes) || stackReserveBytes < 8 * 1024 * 1024)
    fail(
      `Standalone CLI PE stack reserve is ${stackReserveBytes} bytes; at least 8388608 is required for ScriptC's dynamic island.`,
    );
  console.log(`[certification] Windows PE stack reserve: ${stackReserveBytes} bytes`);
  return stackReserveBytes;
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

async function startComfyUiCertificationServer(tempRoot, mode = 'success') {
  const logPath = path.join(
    tempRoot,
    `comfyui-${mode}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  const child = spawn(process.execPath, [comfyUiCertificationServer], {
    cwd: tempRoot,
    env: {
      ...process.env,
      NOVELTEA_COMFYUI_CERT_LOG: logPath,
      NOVELTEA_COMFYUI_CERT_MODE: mode,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(
      () => reject(new Error(`Timed out starting fake ComfyUI server. ${stderr}`)),
      5000,
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Fake ComfyUI server exited ${code}. ${stderr}`));
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/u)[0];
      const value = Number(line);
      if (Number.isInteger(value) && value > 0) {
        clearTimeout(timeout);
        resolve(value);
      }
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    logPath,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

async function runAsync(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    async result() {
      const status = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
      });
      return { status, stdout, stderr };
    },
  };
}

async function waitForComfyUiRequest(logPath, expectedPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requests = await readComfyUiRequests(logPath);
    if (requests.some((request) => request.path === expectedPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  fail(`Timed out waiting for fake ComfyUI request '${expectedPath}'.`);
}

async function readComfyUiRequests(logPath) {
  try {
    return (await readFile(logPath, 'utf8'))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
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
  { name: 'no-command', args: () => [], project: false },
  { name: 'version', args: () => ['--json', '--version'], project: false },
  { name: 'help', args: () => ['--help'], project: false },
  { name: 'validate-explicit', args: (root) => ['--project', root, '--json', 'validate'] },
  { name: 'validate-root', args: () => ['--json', 'validate'] },
  { name: 'agent-sync', args: (root) => ['--project', root, '--json', 'agent', 'sync'] },
  {
    name: 'agent-sync-fix',
    args: (root) => ['--project', root, '--json', 'agent', 'sync', '--fix'],
  },
  {
    name: 'project-create',
    args: (root) => [
      '--json',
      'project',
      'create',
      path.join(root, 'created project'),
      '--name',
      'Created Project',
    ],
  },
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
    const scriptcResult = runNative(args, { cwd: test.cwd?.(caseRoot) ?? cwd });
    const scriptcTree = test.project === false ? '' : await treeSnapshot(caseRoot);

    if (
      scriptcResult.status !== nodeResult.status ||
      scriptcResult.stdout !== nodeResult.stdout ||
      scriptcResult.stderr !== nodeResult.stderr
    ) {
      await resetCase(pristine, caseRoot);
      await test.prepare?.(caseRoot);
      const traced = runNative(args, {
        cwd: test.cwd?.(caseRoot) ?? cwd,
        env: { ...process.env, NOVELTEA_CLI_TRACE: '1' },
      });
      fail(
        `Node/scriptc differential '${test.name}' differs.\n` +
          `Node: status=${nodeResult.status}\nstdout:\n${nodeResult.stdout}\nstderr:\n${nodeResult.stderr}\n` +
          `scriptc: status=${scriptcResult.status}\nstdout:\n${scriptcResult.stdout}\nstderr:\n${scriptcResult.stderr}\n` +
          `scriptc traced retry: status=${traced.status}\nstdout:\n${traced.stdout}\nstderr:\n${traced.stderr}`,
      );
    }
    if (scriptcTree !== nodeTree)
      fail(`Node/scriptc differential '${test.name}' produced different filesystem state.`);
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
  if (!Array.isArray(outputs) || outputs.length !== 8)
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
    ['metal', 'osx', 'metal'],
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
    version: 1,
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

async function certifyPlatformHost(tempRoot, projectRoot) {
  const source = path.join(tempRoot, 'platform-template-source');
  const archive = path.join(tempRoot, 'platform-template.tar.gz');
  const registry = path.join(tempRoot, 'platform-template-registry');
  await mkdir(path.join(source, 'licenses'), { recursive: true });
  const inputs = [
    ['licenses/NOTICE.txt', Buffer.from('NovelTea platform host certification\n'), 'notice'],
    ['player.js', Buffer.from('globalThis.Module = globalThis.Module || {};\n'), 'player'],
    ['player.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), 'player'],
    ['player.data', Buffer.from('certification-data\n'), 'system-asset'],
  ];
  const inventory = [];
  for (const [relative, data, role] of inputs) {
    const filePath = path.join(source, relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    inventory.push({
      path: relative,
      size: data.length,
      mode: (await stat(filePath)).mode & 0o777,
      sha256: sha256(data),
      role,
    });
  }
  await writeJson(path.join(source, 'template.json'), {
    format: 'noveltea.player-template',
    formatVersion: 1,
    templateId: 'certification-web-template',
    buildId: 'build-1',
    engineVersion: productVersion,
    platform: 'web',
    architecture: 'wasm32',
    minimumPlatformVersion: 'certification',
    graphicsBackends: ['webgl2'],
    shaderVariants: ['essl-100'],
    compiledProjectFormatVersion: 1,
    playerRuntimeApiVersion: 1,
    compiledFeatures: ['lua', 'web-threads'],
    capabilities: ['external-url'],
    buildFlavor: 'debug',
    packageAccessModes: ['web-fetch'],
    files: inventory,
    runtimeDependencies: [{ path: 'licenses/NOTICE.txt', kind: 'notice' }],
    artifacts: {
      archive: path.basename(archive),
      symbols: 'symbols.tar.gz',
      sbom: 'licenses/NOTICE.txt',
      notices: 'licenses/NOTICE.txt',
    },
    provenance: { provider: 'local', source: 'certification' },
    host: { assembly: 'any', requiresToolchain: false, tools: [] },
  });
  requireSuccess(
    'platform template archive creation',
    run('cmake', ['-E', 'tar', 'czf', archive, '.'], { cwd: source }),
  );
  const env = { ...process.env, NOVELTEA_TEMPLATE_REGISTRY_ROOT: registry };
  requireSuccess(
    'standalone template install',
    runNative(['--json', 'platform', 'template', 'install', archive, '--force'], {
      cwd: tempRoot,
      env,
    }),
  );
  const listed = requireSuccess(
    'standalone template list',
    runNative(['--json', 'platform', 'template', 'list'], { cwd: tempRoot, env }),
  );
  const templates = JSON.parse(listed.stdout).templates;
  if (!Array.isArray(templates) || templates[0]?.id !== 'certification-web-template@build-1')
    fail('Standalone template registry did not return the installed template identity.');
  const config = path.join(tempRoot, 'platform-export-config.json');
  requireSuccess(
    'standalone platform config',
    runNative(['--json', 'platform', 'config', 'init', config], { cwd: tempRoot, env }),
  );
  if (!(await stat(config)).isFile()) fail('Standalone platform config was not created.');
  const output = path.join(tempRoot, 'standalone-web-export');
  const exported = requireSuccess(
    'standalone platform export',
    runNative(
      [
        '--project',
        projectRoot,
        '--json',
        'platform',
        'export',
        '--output',
        output,
        '--template',
        'certification-web-template@build-1',
        '--allow-untrusted-template',
      ],
      { cwd: projectRoot, env },
    ),
  );
  const exportPayload = JSON.parse(exported.stdout);
  if (exportPayload.signingRequested !== false || exportPayload.signingApplied !== false)
    fail('Standalone platform export reported unexpected signing.');
  for (const required of ['index.html', 'manifest.webmanifest', 'player.json'])
    if (!(await stat(path.join(output, required))).isFile())
      fail(`Standalone platform export is missing '${required}'.`);
}

function canonicalComfyUiResult(result) {
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return result.stdout;
  }
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    const normalized = {};
    for (const [key, next] of Object.entries(item)) {
      if (
        ['clientId', 'promptId', 'assetId', 'importedAt', 'createdAt', 'checkedAt'].includes(key)
      ) {
        normalized[key] = `<${key}>`;
        continue;
      }
      if (
        key === 'projectRelativePath' &&
        typeof next === 'string' &&
        next.startsWith('assets/generated/')
      ) {
        normalized[key] = '<generated-asset-path>';
        continue;
      }
      normalized[key] = normalize(next);
    }
    return normalized;
  };
  return JSON.stringify(normalize(value));
}

function canonicalComfyUiRequests(requests) {
  const normalized = requests.map((request) => ({
    method: request.method,
    path: request.path.startsWith('/history/') ? '/history/<prompt>' : request.path,
    search: request.path === '/view' ? '<view-query>' : request.search,
    bodyBytes: request.bodyBytes,
  }));
  if (
    normalized.length >= 2 &&
    new Set(normalized.slice(0, 2).map((request) => request.path)).size === 2 &&
    normalized
      .slice(0, 2)
      .every((request) => ['/object_info', '/system_stats'].includes(request.path))
  )
    normalized.splice(
      0,
      2,
      ...normalized.slice(0, 2).sort((left, right) => left.path.localeCompare(right.path, 'en')),
    );
  return JSON.stringify(normalized);
}

async function comfyUiStateSnapshot(root) {
  const generated = [];
  async function collectGenerated(directory) {
    try {
      for (const name of (await readdir(directory)).sort((left, right) =>
        left.localeCompare(right, 'en'),
      )) {
        const absolute = path.join(directory, name);
        const info = await stat(absolute);
        if (info.isFile()) generated.push(sha256(await readFile(absolute)));
        else if (info.isDirectory()) await collectGenerated(absolute);
      }
    } catch {
      // Missing publication directories are valid for non-execution cases.
    }
  }
  await collectGenerated(path.join(root, 'assets', 'generated'));

  const filesystem = [];
  async function collectFilesystem(relative) {
    const absolute = path.join(root, relative);
    try {
      const info = await stat(absolute);
      if (info.isFile()) {
        filesystem.push([relative.split(path.sep).join('/'), sha256(await readFile(absolute))]);
        return;
      }
      if (!info.isDirectory()) return;
      for (const name of (await readdir(absolute)).sort((left, right) =>
        left.localeCompare(right, 'en'),
      ))
        await collectFilesystem(path.join(relative, name));
    } catch {
      // Missing explicit publication targets are valid for non-execution cases.
    }
  }
  for (const relative of ['out', 'edit-out', 'default-out', 'mixed.png'])
    await collectFilesystem(relative);

  let assetCount = 0;
  try {
    assetCount = (await readdir(path.join(root, 'records', 'assets'))).filter((name) =>
      name.endsWith('.json'),
    ).length;
  } catch {
    // Project-less cases have no Asset records.
  }
  return JSON.stringify({
    generated: generated.sort((left, right) => left.localeCompare(right, 'en')),
    filesystem,
    assetCount,
  });
}

async function installCertificationMultiOutputWorkflow(projectRoot) {
  const sourceRoot = path.join(editorRoot, 'assets', 'comfyui', 'workflows');
  const workflowText = await readFile(
    path.join(sourceRoot, 'flux2-klein-text-to-image.workflow.json'),
    'utf8',
  );
  const manifest = JSON.parse(
    await readFile(path.join(sourceRoot, 'flux2-klein-text-to-image.manifest.json'), 'utf8'),
  );
  manifest.id = 'certification-multi';
  manifest.label = 'Certification Multi Output';
  manifest.workflowFile = 'certification-multi.workflow.json';
  manifest.contract.outputs = {
    primary: { mediaType: 'image', required: true, cardinality: 'one' },
    secondary: { mediaType: 'image', required: true, cardinality: 'one' },
  };
  manifest.outputBindings = {
    primary: manifest.outputBindings.images,
    secondary: manifest.outputBindings.images,
  };
  const workflowRoot = path.join(projectRoot, 'workflows');
  await mkdir(workflowRoot, { recursive: true });
  await writeFile(path.join(workflowRoot, manifest.workflowFile), workflowText);
  await writeJson(path.join(workflowRoot, 'certification-multi.manifest.json'), manifest);
}

async function certifyComfyUiStandalone(tempRoot, pristine) {
  const server = await startComfyUiCertificationServer(tempRoot);
  const sourceImage = path.join(tempRoot, 'comfyui-source.png');
  await writeFile(
    sourceImage,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const cases = [
    {
      name: 'status',
      args: () => ['--json', 'comfyui', 'status', '--server', server.url],
      project: false,
    },
    { name: 'workflow-list', args: () => ['--json', 'comfyui', 'workflows'], project: false },
    {
      name: 'workflow-inspect',
      args: () => ['--json', 'comfyui', 'workflows', 'flux2-klein-text-to-image'],
      project: false,
    },
    {
      name: 'verify',
      args: () => [
        '--json',
        'comfyui',
        'verify',
        'flux2-klein-text-to-image',
        '--server',
        server.url,
      ],
      project: false,
    },
    {
      name: 'scalar-filesystem',
      args: (root) => [
        '--json',
        'comfyui',
        'run',
        'flux2-klein-text-to-image',
        '--server',
        server.url,
        '--input',
        'prompt=certification',
        '--output',
        `images=${path.join(root, 'out')}`,
      ],
      project: false,
    },
    {
      name: 'local-image-edit',
      args: (root) => [
        '--json',
        'comfyui',
        'run',
        'flux2-klein-image-edit',
        '--server',
        server.url,
        '--input',
        `sourceImage=${sourceImage}`,
        '--input',
        'prompt=certification edit',
        '--output',
        `images=${path.join(root, 'edit-out')}`,
      ],
      project: false,
    },
    {
      name: 'default-resolution',
      args: (root) => [
        '--json',
        'comfyui',
        'run',
        '--type',
        'image.generate',
        '--server',
        server.url,
        '--input',
        'prompt=default certification',
        '--output',
        `images=${path.join(root, 'default-out')}`,
      ],
      project: false,
      defaults: true,
    },
    {
      name: 'project-asset-publication',
      args: (root) => [
        '--project',
        root,
        '--json',
        'comfyui',
        'run',
        'flux2-klein-text-to-image',
        '--server',
        server.url,
        '--input',
        'prompt=asset certification',
      ],
      project: true,
    },
    {
      name: 'named-mixed-publication',
      args: (root) => [
        '--project',
        root,
        '--json',
        'comfyui',
        'run',
        'certification-multi',
        '--server',
        server.url,
        '--input',
        'prompt=mixed certification',
        '--output',
        `primary=${path.join(root, 'mixed.png')}`,
      ],
      project: true,
      multi: true,
    },
    {
      name: 'unknown-workflow-failure',
      args: () => [
        '--json',
        'comfyui',
        'run',
        'missing-workflow',
        '--server',
        server.url,
        '--output',
        'out.png',
      ],
      project: false,
    },
  ];
  try {
    for (const test of cases) {
      const root = path.join(tempRoot, `comfyui-${test.name}`);
      const runOne = async (runner, configSuffix) => {
        if (test.project) await resetCase(pristine, root);
        else {
          await rm(root, { recursive: true, force: true });
          await mkdir(root, { recursive: true });
        }
        if (test.multi) await installCertificationMultiOutputWorkflow(root);
        const configRoot = path.join(tempRoot, `comfyui-config-${test.name}-${configSuffix}`);
        await rm(configRoot, { recursive: true, force: true });
        if (test.defaults)
          await writeJson(path.join(configRoot, 'comfyui', 'config-v1.json'), {
            format: 'noveltea.comfyui-user-config',
            formatVersion: 1,
            serverUrl: server.url,
            requestTimeoutMs: 2000,
            defaultWorkflows: { 'image.generate': 'flux2-klein-text-to-image' },
          });
        await writeFile(server.logPath, '');
        const result = runner(test.args(root), {
          cwd: root,
          env: { ...process.env, NOVELTEA_USER_CONFIG_ROOT: configRoot },
        });
        const requests = await readComfyUiRequests(server.logPath);
        const state = await comfyUiStateSnapshot(root);
        return { result, requests, state };
      };
      const node = await runOne(runNode, 'node');
      const native = await runOne(runNative, 'native');
      if (
        node.result.status !== native.result.status ||
        node.result.stderr !== native.result.stderr
      )
        fail(`ComfyUI differential '${test.name}' exit/stderr differs.`);
      if (canonicalComfyUiResult(node.result) !== canonicalComfyUiResult(native.result))
        fail(
          `ComfyUI differential '${test.name}' stdout differs.\nNode: ${node.result.stdout}\nScriptC: ${native.result.stdout}`,
        );
      if (node.state !== native.state)
        fail(`ComfyUI differential '${test.name}' filesystem/Project state differs.`);
      if (canonicalComfyUiRequests(node.requests) !== canonicalComfyUiRequests(native.requests))
        fail(
          `ComfyUI differential '${test.name}' fake-server request trace differs.\nNode: ${JSON.stringify(node.requests)}\nScriptC: ${JSON.stringify(native.requests)}`,
        );
      if (node.result.stdout && !node.result.stdout.endsWith('\n'))
        fail(`ComfyUI '${test.name}' stdout is not one JSON line.`);
      if (node.result.stderr !== '') fail(`ComfyUI '${test.name}' emitted stderr in --json mode.`);
      process.stdout.write(`[comfyui differential] ${test.name}: PASS\n`);
    }
  } finally {
    await server.stop();
  }

  const failureCases = [
    {
      mode: 'upload-failure',
      args: (url, root) => [
        '--json',
        'comfyui',
        'run',
        'flux2-klein-image-edit',
        '--server',
        url,
        '--input',
        `sourceImage=${sourceImage}`,
        '--input',
        'prompt=upload failure',
        '--output',
        `images=${path.join(root, 'out')}`,
      ],
    },
    {
      mode: 'history-failure',
      args: (url, root) => [
        '--json',
        'comfyui',
        'run',
        'flux2-klein-text-to-image',
        '--server',
        url,
        '--input',
        'prompt=history failure',
        '--output',
        `images=${path.join(root, 'out')}`,
      ],
    },
    {
      mode: 'oversized-output',
      args: (url, root) => [
        '--json',
        'comfyui',
        'run',
        'flux2-klein-text-to-image',
        '--server',
        url,
        '--input',
        'prompt=oversized output',
        '--output',
        `images=${path.join(root, 'out')}`,
      ],
    },
  ];
  for (const failureCase of failureCases) {
    const failureServer = await startComfyUiCertificationServer(tempRoot, failureCase.mode);
    try {
      const root = path.join(tempRoot, `comfyui-${failureCase.mode}`);
      const runFailure = async (runner, suffix) => {
        await rm(root, { recursive: true, force: true });
        await mkdir(root, { recursive: true });
        const configRoot = path.join(tempRoot, `comfyui-config-${failureCase.mode}-${suffix}`);
        await rm(configRoot, { recursive: true, force: true });
        await writeFile(failureServer.logPath, '');
        const result = runner(failureCase.args(failureServer.url, root), {
          cwd: root,
          env: { ...process.env, NOVELTEA_USER_CONFIG_ROOT: configRoot },
        });
        return { result, requests: await readComfyUiRequests(failureServer.logPath) };
      };
      const node = await runFailure(runNode, 'node');
      const native = await runFailure(runNative, 'native');
      if (node.result.status === 0 || native.result.status === 0)
        fail(`ComfyUI failure certification '${failureCase.mode}' unexpectedly succeeded.`);
      if (
        node.result.status !== native.result.status ||
        node.result.stderr !== native.result.stderr ||
        canonicalComfyUiResult(node.result) !== canonicalComfyUiResult(native.result)
      )
        fail(
          `ComfyUI failure differential '${failureCase.mode}' differs.\n` +
            `Node: status=${node.result.status}\nstdout:\n${node.result.stdout}\nstderr:\n${node.result.stderr}\n` +
            `ScriptC: status=${native.result.status}\nstdout:\n${native.result.stdout}\nstderr:\n${native.result.stderr}`,
        );
      if (canonicalComfyUiRequests(node.requests) !== canonicalComfyUiRequests(native.requests))
        fail(`ComfyUI failure differential '${failureCase.mode}' request trace differs.`);
      process.stdout.write(`[comfyui differential] ${failureCase.mode}: PASS\n`);
    } finally {
      await failureServer.stop();
    }
  }

  const timeoutServer = await startComfyUiCertificationServer(tempRoot, 'request-timeout');
  try {
    const runTimeout = async (runner, suffix) => {
      const configRoot = path.join(tempRoot, `comfyui-config-timeout-${suffix}`);
      await writeJson(path.join(configRoot, 'comfyui', 'config-v1.json'), {
        format: 'noveltea.comfyui-user-config',
        formatVersion: 1,
        serverUrl: timeoutServer.url,
        requestTimeoutMs: 100,
        defaultWorkflows: {},
      });
      return runner(['--json', 'comfyui', 'status'], {
        cwd: tempRoot,
        env: { ...process.env, NOVELTEA_USER_CONFIG_ROOT: configRoot },
      });
    };
    const node = await runTimeout(runNode, 'node');
    const native = await runTimeout(runNative, 'native');
    if (
      node.status !== native.status ||
      canonicalComfyUiResult(node) !== canonicalComfyUiResult(native)
    )
      fail('ComfyUI request-timeout differential differs.');
    process.stdout.write('[comfyui differential] request-timeout: PASS\n');
  } finally {
    await timeoutServer.stop();
  }

  const cancellationServer = await startComfyUiCertificationServer(tempRoot, 'never-complete');
  try {
    const cancelArgs = [
      '--json',
      'comfyui',
      'run',
      'flux2-klein-text-to-image',
      '--server',
      cancellationServer.url,
      '--input',
      'prompt=cancel certification',
      '--output',
      `images=${path.join(tempRoot, 'cancel-out')}`,
    ];
    await writeFile(cancellationServer.logPath, '');
    const nodeConfigRoot = path.join(tempRoot, 'comfyui-config-cancel-node');
    const nodeInvocation = await runAsync(process.execPath, [nodeCli, ...cancelArgs], {
      cwd: tempRoot,
      env: { ...process.env, NOVELTEA_USER_CONFIG_ROOT: nodeConfigRoot },
    });
    const nodeResultPromise = nodeInvocation.result();
    await waitForComfyUiRequest(cancellationServer.logPath, '/prompt');
    nodeInvocation.child.kill('SIGINT');
    const nodeResult = await nodeResultPromise;
    if (nodeResult.status !== 130)
      fail(`Node ComfyUI cancellation exited ${nodeResult.status}, expected 130.`);
    let requests = await readComfyUiRequests(cancellationServer.logPath);
    if (!requests.some((request) => request.method === 'POST' && request.path === '/queue'))
      fail('Node ComfyUI cancellation did not issue prompt-specific queue deletion.');
    if (requests.some((request) => request.path === '/interrupt'))
      fail('Node ComfyUI cancellation used the forbidden global /interrupt endpoint.');
    process.stdout.write('[comfyui cancellation] Node SIGINT: PASS\n');

    await writeFile(cancellationServer.logPath, '');
    const scriptcConfigRoot = path.join(tempRoot, 'comfyui-config-cancel-scriptc');
    const scriptcResult = runNative(['__comfyui-cancel-certification', ...cancelArgs], {
      cwd: tempRoot,
      env: {
        ...process.env,
        NOVELTEA_USER_CONFIG_ROOT: scriptcConfigRoot,
        NOVELTEA_CLI_CERTIFICATION: '1',
      },
    });
    if (scriptcResult.status !== 130)
      fail(`ScriptC ComfyUI abort seam exited ${scriptcResult.status}, expected 130.`);
    requests = await readComfyUiRequests(cancellationServer.logPath);
    if (!requests.some((request) => request.method === 'POST' && request.path === '/queue'))
      fail('ScriptC ComfyUI abort seam did not issue prompt-specific queue deletion.');
    if (requests.some((request) => request.path === '/interrupt'))
      fail('ScriptC ComfyUI abort seam used the forbidden global /interrupt endpoint.');
    process.stdout.write('[comfyui cancellation] ScriptC abort seam: PASS\n');
  } finally {
    await cancellationServer.stop();
  }

  return cases.length + failureCases.length + 2;
}

async function certifyRelocation(tempRoot) {
  const relocated = path.join(tempRoot, 'relocated', 'bin', executableName);
  await mkdir(path.dirname(relocated), { recursive: true });
  await cp(nativeCli, relocated);
  const env = isWindows
    ? {
        ...process.env,
        HOME: path.join(tempRoot, 'relocated-home'),
        USERPROFILE: path.join(tempRoot, 'relocated-home'),
      }
    : {
        HOME: path.join(tempRoot, 'relocated-home'),
        LANG: 'C.UTF-8',
        PATH: '/usr/bin:/bin',
      };
  const result = requireSuccess('relocated CLI', run(relocated, ['--json', '--version'], { env }));
  const payload = JSON.parse(result.stdout);
  if (payload.version !== productVersion)
    fail(`Relocated CLI returned unexpected version '${payload.version}'.`);
  const workflowList = requireSuccess(
    'relocated built-in ComfyUI workflow catalog',
    run(relocated, ['--json', 'comfyui', 'workflows'], {
      cwd: path.dirname(relocated),
      env: { ...env, NOVELTEA_USER_CONFIG_ROOT: path.join(tempRoot, 'relocated-config') },
    }),
  );
  const workflowPayload = JSON.parse(workflowList.stdout);
  const workflowIds = Array.isArray(workflowPayload.workflows)
    ? workflowPayload.workflows.map((entry) => entry.id)
    : [];
  for (const required of ['flux2-klein-text-to-image', 'flux2-klein-image-edit'])
    if (!workflowIds.includes(required))
      fail(`Relocated CLI is missing embedded ComfyUI workflow '${required}'.`);

  const comfyUiServer = await startComfyUiCertificationServer(tempRoot);
  try {
    const outputRoot = path.join(tempRoot, 'relocated-comfyui-output');
    const executed = requireSuccess(
      'relocated embedded ComfyUI execution',
      run(
        relocated,
        [
          '--json',
          'comfyui',
          'run',
          'flux2-klein-text-to-image',
          '--server',
          comfyUiServer.url,
          '--input',
          'prompt=relocated certification',
          '--output',
          `images=${outputRoot}`,
        ],
        {
          cwd: path.dirname(relocated),
          env: { ...env, NOVELTEA_USER_CONFIG_ROOT: path.join(tempRoot, 'relocated-config') },
        },
      ),
    );
    const executionPayload = JSON.parse(executed.stdout);
    if (executionPayload.success !== true)
      fail('Relocated embedded ComfyUI execution did not report success.');
    const outputFiles = await readdir(outputRoot);
    if (outputFiles.length !== 1 || !(await stat(path.join(outputRoot, outputFiles[0]))).isFile())
      fail('Relocated embedded ComfyUI execution did not publish exactly one image.');
  } finally {
    await comfyUiServer.stop();
  }

  const closure = isWindows
    ? requireSuccess('CLI PE dependency audit', run('dumpbin', ['/dependents', relocated], { env }))
        .stdout
    : requireSuccess('CLI ldd audit', run('ldd', [relocated], { env })).stdout;
  const forbiddenRuntimeDependency = isWindows
    ? /\b(?:node|shaderc)\b|libstdc\+\+|libgcc_s|libwinpthread/i
    : /\b(?:node|shaderc)\b/i;
  if (forbiddenRuntimeDependency.test(closure))
    fail(`Standalone CLI has a forbidden runtime dependency:\n${closure}`);

  const binary = await readFile(relocated);
  for (const marker of [
    'sourceMappingURL',
    'scripts/noveltea-scriptc-island.ts',
    'NovelTea command failed',
    'Fragment layout RML should not include',
  ]) {
    if (binary.includes(Buffer.from(marker)))
      fail(`Standalone CLI exposes prohibited first-party source marker '${marker}'.`);
  }

  return closure
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function main() {
  if (!['linux', 'win32'].includes(process.platform) || process.arch !== 'x64')
    fail(
      `CLI certification is admitted on Linux and Windows x64; received ${process.platform}/${process.arch}.`,
    );
  if (!(await stat(nativeCli)).isFile()) fail(`NovelTea CLI is missing: ${nativeCli}`);
  if (!(await stat(path.join(bgfxInclude, 'bgfx_shader.sh'))).isFile())
    fail(`bgfx shader include is missing: ${bgfxInclude}`);

  const windowsPeStackReserve = await verifyWindowsPeStackReserve();

  requireSuccess(
    'Node-reference bundle build',
    runPnpm(['exec', 'vp', 'pack'], { cwd: editorRoot }),
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'noveltea-cli-certification-'));
  try {
    const { pristine } = await runDifferential(tempRoot);
    await certifyTypedShaders(tempRoot);
    await certifyRawShaderc(tempRoot);
    await certifyNativeOperations(tempRoot, pristine);
    await certifyPlatformHost(tempRoot, pristine);
    const comfyUiDifferentialCases = await certifyComfyUiStandalone(tempRoot, pristine);
    const closure = await certifyRelocation(tempRoot);
    const binarySize = (await stat(nativeCli)).size;
    process.stdout.write(
      `${JSON.stringify({
        success: true,
        differentialCases: differentialCases.length,
        comfyUiDifferentialCases,
        typedShaderVariants: Object.keys(typedFragmentGoldens),
        rawShaderVariants: Object.keys(rawShaderGoldens),
        nativeOperations: [
          'shader-compile',
          'raw-shaderc',
          'test',
          'ui-test',
          'package-export',
          'platform-template-registry',
          'platform-config',
          'platform-export',
        ],
        relocation: true,
        sourceLeakageAudit: true,
        binarySize,
        windowsPeStackReserve,
        linkedClosure: closure,
      })}\n`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
