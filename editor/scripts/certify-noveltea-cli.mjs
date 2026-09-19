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
  symlink,
  utimes,
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
  'materialize-platform-export-fixture.mjs',
);
const bgfxInclude = path.join(
  repositoryRoot,
  'build',
  releasePreset,
  '_deps',
  'bgfx.cmake-src',
  'bgfx',
  'src',
);

const typedFragmentGoldens = Object.freeze({
  'glsl-330': '74b7ccd9e4dd273e874a881c9f6ea1a31e0ca74cbea6f3aac1a5349202f5838e',
  'essl-300': 'dedfb504e17d8055ba47cc49985ec58c76b03378a3fb29a4c7d7187565c18d35',
  metal: 'ee0fdf7bbb3c6146d333b59c791b3784fa81ccf0305303c6edbc0d1eaf8bfd76',
});

const rawShaderGoldens = Object.freeze({
  'glsl-330': '321831391b668aef83484ce7364d043a49f13de2f423243567fc45719b17611c',
  'essl-300': '321831391b668aef83484ce7364d043a49f13de2f423243567fc45719b17611c',
  metal: '5ef111a60cef57b45a565750a20a8fa57d4edd8c801ebb610b8a45f3cc3b7dfe',
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
      // Immutable cache generations have process-local UUIDs and source timestamps.
      if (child === '.noveltea/cache/authoring') continue;
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
  return run(process.execPath, [nodeCli, ...args], {
    ...options,
    env: { ...process.env, ...options.env, NOVELTEA_CLI: nativeCli },
  });
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
    detached: options.detached ?? false,
    windowsHide: options.windowsHide ?? false,
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
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
  return {
    child,
    async result() {
      const status = await completion;
      return { status, stdout, stderr };
    },
  };
}

function sendWindowsConsoleCtrlC(pid) {
  const source = String.raw`
using System;
using System.Runtime.InteropServices;

public static class NovelTeaConsoleSignal {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleCtrlHandler(IntPtr handlerRoutine, bool add);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
}`;
  const command = [
    `Add-Type -TypeDefinition @'\n${source}\n'@`,
    '[NovelTeaConsoleSignal]::FreeConsole() | Out-Null',
    `if (-not [NovelTeaConsoleSignal]::AttachConsole(${pid})) { exit 2 }`,
    '[NovelTeaConsoleSignal]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null',
    'if (-not [NovelTeaConsoleSignal]::GenerateConsoleCtrlEvent(0, 0)) { exit 3 }',
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    fail(
      `Failed to send Windows console Ctrl+C to PID ${pid} (status ${result.status}).\n${result.stderr ?? ''}`,
    );
}

function quoteWindowsArgument(value) {
  if (!/[\s"]/u.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += '\\'.repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes);
    result += character;
    backslashes = 0;
  }
  result += '\\'.repeat(backslashes * 2);
  return `${result}"`;
}

async function runWindowsConsoleProcess(command, args, options) {
  const pidPath = path.join(options.cwd, `windows-console-child-${process.pid}.pid`);
  const commandLine = [command, ...args].map(quoteWindowsArgument).join(' ');
  const source = String.raw`
using System;
using System.Runtime.InteropServices;

public static class NovelTeaConsoleProcess {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct StartupInfo {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessInformation {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(
        string applicationName,
        string commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
}`;
  const encodedCommandLine = Buffer.from(commandLine, 'utf8').toString('base64');
  const encodedCommand = Buffer.from(command, 'utf8').toString('base64');
  const encodedCwd = Buffer.from(options.cwd, 'utf8').toString('base64');
  const encodedPidPath = Buffer.from(pidPath, 'utf8').toString('base64');
  const powerShellCommand = [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -TypeDefinition @'\n${source}\n'@`,
    `$applicationName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedCommand}'))`,
    `$commandLine = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedCommandLine}'))`,
    `$cwd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedCwd}'))`,
    `$pidPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPidPath}'))`,
    '$startupInfo = New-Object NovelTeaConsoleProcess+StartupInfo',
    '$startupInfo.cb = [Runtime.InteropServices.Marshal]::SizeOf($startupInfo)',
    '$processInformation = New-Object NovelTeaConsoleProcess+ProcessInformation',
    '$created = [NovelTeaConsoleProcess]::CreateProcess($applicationName, $commandLine, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0x10, [IntPtr]::Zero, $cwd, [ref]$startupInfo, [ref]$processInformation)',
    'if (-not $created) { exit 10 }',
    'Set-Content -LiteralPath $pidPath -Value $processInformation.dwProcessId',
    '[NovelTeaConsoleProcess]::WaitForSingleObject($processInformation.hProcess, [uint32]::MaxValue) | Out-Null',
    '$exitCode = [uint32]0',
    '[NovelTeaConsoleProcess]::GetExitCodeProcess($processInformation.hProcess, [ref]$exitCode) | Out-Null',
    '[NovelTeaConsoleProcess]::CloseHandle($processInformation.hThread) | Out-Null',
    '[NovelTeaConsoleProcess]::CloseHandle($processInformation.hProcess) | Out-Null',
    'exit [int]$exitCode',
  ].join('; ');
  const invocation = await runAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', powerShellCommand],
    { cwd: repositoryRoot, env: options.env, windowsHide: true },
  );
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt((await readFile(pidPath, 'utf8')).trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return { invocation, pid };
    } catch {
      // The launcher writes the PID as soon as CreateProcess succeeds.
    }
    if (invocation.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const launcherResult = await invocation.result();
  fail(
    `Windows console child failed to start (status ${launcherResult.status}).\n${launcherResult.stderr}`,
  );
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

function runWithStdinFile(command, args, stdinPath, options = {}) {
  const stdin = openSync(stdinPath, 'r');
  try {
    const result = spawnSync(command, args, {
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

function runNativeWithStdinFile(args, stdinPath, options = {}) {
  return runWithStdinFile(nativeCli, args, stdinPath, options);
}

function runNodeWithStdinFile(args, stdinPath, options = {}) {
  return runWithStdinFile(process.execPath, [nodeCli, ...args], stdinPath, {
    ...options,
    env: { ...process.env, ...options.env, NOVELTEA_CLI: nativeCli },
  });
}

function assertPublicCommandParity(label, nodeResult, scriptcResult) {
  if (
    nodeResult.status !== scriptcResult.status ||
    nodeResult.stdout !== scriptcResult.stdout ||
    nodeResult.stderr !== scriptcResult.stderr
  )
    fail(
      `Node/scriptc test parity '${label}' differs.\n` +
        `Node: status=${nodeResult.status}\nstdout:\n${nodeResult.stdout}\nstderr:\n${nodeResult.stderr}\n` +
        `scriptc: status=${scriptcResult.status}\nstdout:\n${scriptcResult.stdout}\nstderr:\n${scriptcResult.stderr}`,
    );
}

function assertIslandTrace(label, result, expected) {
  const imported = result.stderr.includes('[scriptc-host] dynamic island import starting');
  if (imported !== expected)
    fail(
      `${label} ${expected ? 'did not enter' : 'unexpectedly entered'} the dynamic island.\nstderr:\n${result.stderr}`,
    );
}

function assertIslandBoundaryTrace(label, result, marker, expected) {
  const observed = result.stderr.includes(`[scriptc-island] ${marker}`);
  if (observed !== expected)
    fail(
      `${label} ${expected ? 'did not reach' : 'unexpectedly reached'} island boundary '${marker}'.\nstderr:\n${result.stderr}`,
    );
}

function certifyBootstrapOnlyIslandFailures() {
  const env = { ...process.env, NOVELTEA_CLI_TRACE: '1' };
  for (const test of [
    { label: 'repeated global help', args: ['--help', '--help'], expectedStatus: 0 },
    { label: 'unknown global option', args: ['--not-a-global-option'], expectedStatus: 2 },
  ]) {
    const result = runNative(test.args, { env });
    if (result.status !== test.expectedStatus)
      fail(
        `${test.label} returned ${result.status ?? 'no status'} instead of ${test.expectedStatus}.`,
      );
    assertIslandTrace(test.label, result, true);
    assertIslandBoundaryTrace(test.label, result, 'platform host configuration starting', false);
    assertIslandBoundaryTrace(test.label, result, 'workspace services import starting', false);
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
  { name: 'repeated-help', args: () => ['--help', '--help'], project: false },
  { name: 'unknown-global', args: () => ['--not-a-global-option'], project: false },
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
    name: 'project-export',
    args: (root) => [
      '--project',
      root,
      '--json',
      'project',
      'export',
      '--output',
      path.join(root, 'portable.ntproject'),
    ],
  },
  {
    name: 'project-import',
    prepare: async (root) => {
      requireSuccess(
        'portable project differential fixture export',
        runNode([
          '--project',
          root,
          '--json',
          'project',
          'export',
          '--output',
          path.join(root, 'portable.ntproject'),
        ]),
      );
    },
    args: (root) => [
      '--json',
      'project',
      'import',
      path.join(root, 'portable.ntproject'),
      path.join(root, 'imported project'),
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
  if (!Array.isArray(outputs) || outputs.length !== 6)
    fail(
      `Typed shader compile returned ${Array.isArray(outputs) ? outputs.length : 'invalid'} outputs.`,
    );
  for (const [variant, expected] of Object.entries(typedFragmentGoldens)) {
    const output = outputs.find(
      (candidate) => candidate.variant === variant && candidate.stage === 'fragment',
    );
    if (!output || output.byteHash !== `sha256:${expected}`)
      fail(`Typed shader golden mismatch for ${variant}: ${output?.byteHash ?? 'missing'}.`);
  }
}

async function certifyRawShaderc(tempRoot) {
  const source = path.join(repositoryRoot, 'engine', 'shaders', 'bgfx', 'vs_triangle.sc');
  const includeSource = path.join(repositoryRoot, 'engine', 'shaders', 'bgfx');
  const variants = [
    ['glsl-330', 'linux', '330'],
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

async function certifyTestCommandParity(tempRoot, pristine) {
  const playbackPath = path.join(tempRoot, 'parity-empty-playback.json');
  await writeFile(
    playbackPath,
    `${JSON.stringify({
      schema: 'noveltea.editor.playback',
      version: 1,
      id: 'parity-empty',
      steps: [],
      finalExpectations: [],
    })}\n`,
  );

  const cases = [
    { name: 'targeted-test', command: ['test', 'run', 'cache-certification'], authored: true },
    { name: 'suite', command: ['test', 'run'], authored: true },
    { name: 'run-spec', command: ['test', 'run-spec'], stdinPath: playbackPath },
    { name: 'run-ui-spec', command: ['test', 'run-ui-spec'], stdinPath: playbackPath },
    {
      name: 'blocked-targeted-test',
      command: ['test', 'run', 'cache-certification'],
      authored: true,
      blocked: true,
    },
    { name: 'blocked-suite', command: ['test', 'run'], authored: true, blocked: true },
  ];

  for (const test of cases) {
    const baseline = path.join(tempRoot, `test-parity-${test.name}-baseline`);
    const root = path.join(tempRoot, `test-parity-${test.name}`);
    await resetCase(pristine, baseline);
    if (test.authored) {
      requireSuccess(
        `${test.name} authored Test setup`,
        runNode(
          ['--project', baseline, '--json', 'entity', 'create', 'tests', 'cache-certification'],
          { cwd: baseline },
        ),
      );
      if (test.blocked) {
        const testRecordPath = path.join(baseline, 'records', 'tests', 'cache-certification.json');
        const testRecord = JSON.parse(await readFile(testRecordPath, 'utf8'));
        testRecord.data.steps = [];
        await writeJson(testRecordPath, testRecord);
      }
    }
    const warningRoomPath = path.join(baseline, 'records', 'rooms', 'gallery.json');
    const warningRoom = JSON.parse(await readFile(warningRoomPath, 'utf8'));
    warningRoom.data.description.source.text = '';
    await writeJson(warningRoomPath, warningRoom);

    const args = ['--project', root, '--json', ...test.command];
    const invokeNode = () =>
      test.stdinPath
        ? runNodeWithStdinFile(args, test.stdinPath, { cwd: root })
        : runNode(args, { cwd: root });
    const invokeNative = () =>
      test.stdinPath
        ? runNativeWithStdinFile(args, test.stdinPath, { cwd: root })
        : runNative(args, { cwd: root });

    await resetCase(baseline, root);
    const nodeFallback = invokeNode();
    await resetCase(baseline, root);
    const scriptcFallback = invokeNative();
    assertPublicCommandParity(`${test.name} fallback`, nodeFallback, scriptcFallback);

    const nodeHit = invokeNode();
    const scriptcHit = invokeNative();
    assertPublicCommandParity(`${test.name} cache hit`, nodeHit, scriptcHit);
    const hitPayload = JSON.parse(scriptcHit.stdout);
    if (
      !hitPayload.diagnostics?.some(
        (item) => item.code === 'authoring.rooms.rooms.record.data.description',
      )
    )
      fail(`Static cache hit lost persisted authoring diagnostics: ${scriptcHit.stdout}`);

    const humanArgs = ['--project', root, ...test.command];
    const nodeHuman = test.stdinPath
      ? runNodeWithStdinFile(humanArgs, test.stdinPath, { cwd: root })
      : runNode(humanArgs, { cwd: root });
    const scriptcHuman = test.stdinPath
      ? runNativeWithStdinFile(humanArgs, test.stdinPath, { cwd: root })
      : runNative(humanArgs, { cwd: root });
    assertPublicCommandParity(`${test.name} human cache hit`, nodeHuman, scriptcHuman);
    process.stdout.write(`[test-parity] ${test.name}: PASS\n`);
  }
}

async function certifyAuthoringCache(tempRoot, pristine) {
  const root = path.join(tempRoot, 'authoring-cache');
  await resetCase(pristine, root);
  const cacheRoot = path.join(root, '.noveltea/cache/authoring');
  await writeFile(
    path.join(root, 'records/layouts/fixture-hud/layout.lua'),
    'local text = "unterminated',
  );
  const args = ['--project', root, '--json', 'validate'];
  const invoke = (label, island) => {
    const result = runNative(args, { cwd: root, env: { ...process.env, NOVELTEA_CLI_TRACE: '1' } });
    assertIslandTrace(label, result, island);
    const reference = runNode(args, { cwd: root });
    assertPublicCommandParity(label, reference, {
      ...result,
      stderr: result.stderr
        .split('\n')
        .filter((line) => !line.startsWith('[scriptc-'))
        .join('\n'),
    });
    assertPublicCommandParity(
      `${label} human`,
      runNode(['--project', root, 'validate'], { cwd: root }),
      runNative(['--project', root, 'validate'], { cwd: root }),
    );
    return result;
  };
  const cold = invoke('authoring cold validation', true);
  if (
    !JSON.parse(cold.stdout).diagnostics.some(
      (item) =>
        item.code === 'authoring.lua.lexical_incomplete' &&
        item.sourceUrl &&
        item.line === 1 &&
        item.column === 1,
    )
  )
    fail('Authoring validation fixture did not exercise source locations.');
  invoke('authoring warm validation', false);
  await writeFile(path.join(root, 'scripts/README.md'), 'ignored notes');
  invoke('authoring ignored file', false);
  const candidate = path.join(root, 'scripts/cache-candidate.lua');
  await writeFile(candidate, '-- new candidate\n');
  invoke('authoring added candidate', true);
  await rm(candidate);
  invoke('authoring removed candidate', true);
  const manifestPath = path.join(root, 'project.json');
  await writeFile(manifestPath, `${await readFile(manifestPath, 'utf8')}\n`);
  invoke('authoring changed metadata', true);
  const declaredAsset = path.join(root, 'assets/scripts/startup.lua');
  await writeFile(declaredAsset, `${await readFile(declaredAsset, 'utf8')}\n-- changed asset\n`);
  invoke('authoring changed declared Asset', true);
  const project = JSON.parse(await readFile(manifestPath, 'utf8'));
  const originalEntrypoint = project.entrypoint;
  project.entrypoint = { kind: 'room', id: 'missing-cache-room' };
  await writeJson(manifestPath, project);
  if (invoke('authoring semantic failure', true).status !== 4)
    fail('Authoring semantic-error fixture did not fail validation.');
  invoke('authoring cached semantic failure', false);
  project.entrypoint = originalEntrypoint;
  await writeJson(manifestPath, project);
  invoke('authoring semantic repair', true);
  const pointerPath = path.join(cacheRoot, 'current');
  const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
  await writeFile(path.join(cacheRoot, 'generations', pointer.generation, 'manifest.json'), '{}');
  invoke('authoring corrupt generation', true);
  await writeFile(pointerPath, '{broken');
  invoke('authoring malformed pointer', true);
  const incompatiblePointer = JSON.parse(await readFile(pointerPath, 'utf8'));
  const incompatiblePath = path.join(
    cacheRoot,
    'generations',
    incompatiblePointer.generation,
    'manifest.json',
  );
  const incompatible = JSON.parse(await readFile(incompatiblePath, 'utf8'));
  incompatible.buildIdentity = 'different-build';
  const text = JSON.stringify(incompatible);
  await writeFile(incompatiblePath, text);
  await writeJson(pointerPath, {
    ...incompatiblePointer,
    manifestSha256: `sha256:${sha256(text)}`,
  });
  invoke('authoring incompatible build', true);
  await rm(pointerPath);
  await mkdir(pointerPath);
  invoke('authoring best-effort publication', true);
  await rm(pointerPath, { recursive: true });
  invoke('authoring publication recovery', true);
  invoke('authoring recovered warm hit', false);
  const incompletePointer = JSON.parse(await readFile(pointerPath, 'utf8'));
  const incompleteManifestPath = path.join(
    cacheRoot,
    'generations',
    incompletePointer.generation,
    'manifest.json',
  );
  const incompleteManifest = JSON.parse(await readFile(incompleteManifestPath, 'utf8'));
  incompleteManifest.inputs = incompleteManifest.inputs.filter(
    (input) => input.path !== 'traits.json',
  );
  const incompleteText = JSON.stringify(incompleteManifest);
  await writeFile(incompleteManifestPath, incompleteText);
  await writeJson(pointerPath, {
    ...incompletePointer,
    manifestSha256: `sha256:${sha256(incompleteText)}`,
  });
  invoke('authoring missing authoritative root fragment', true);
  if (!isWindows) {
    const before = await readFile(pointerPath, 'utf8');
    const link = path.join(root, 'scripts/ignored-link.txt');
    await symlink(path.join(root, 'scripts/README.md'), link);
    invoke('authoring conservative native rejection', true);
    if ((await readFile(pointerPath, 'utf8')) === before)
      fail('Rejected native authoring admission reused the cache inside the island.');
    await rm(link);
    invoke('authoring native uncertainty resolved', false);
  }
  process.stdout.write('[authoring-cache] cold/warm, parity, invalidation, recovery: PASS\n');
}

async function certifyRuntimeCacheInvalidation(tempRoot, pristine) {
  const root = path.join(tempRoot, 'runtime-cache-invalidation');
  await resetCase(pristine, root);
  requireSuccess(
    'runtime-cache invalidation authored Test setup',
    runNative(['--project', root, '--json', 'entity', 'create', 'tests', 'cache-certification'], {
      cwd: root,
    }),
  );
  const tracedEnvironment = { ...process.env, NOVELTEA_CLI_TRACE: '1' };
  const cacheRoot = path.join(root, '.noveltea', 'cache', 'runtime');
  const runCached = (label, expectedIsland, expectedStatus) => {
    const result = requireSuccess(
      label,
      runNative(['--project', root, '--json', 'test', 'run', 'cache-certification'], {
        cwd: root,
        env: tracedEnvironment,
      }),
    );
    assertIslandTrace(label, result, expectedIsland);
    const payload = JSON.parse(result.stdout);
    if (expectedStatus && payload.runtimeCache?.status !== expectedStatus)
      fail(`${label} reported unexpected cache state: ${result.stdout}`);
    return { result, payload };
  };
  const currentManifestPath = async () => {
    const generation = (await readFile(path.join(cacheRoot, 'current'), 'utf8')).trim();
    return path.join(cacheRoot, 'generations', generation, 'manifest.json');
  };

  const cold = runCached('runtime-cache invalidation cold publish', true, 'miss');
  if (cold.payload.runtimeCache?.published !== true)
    fail(`Runtime-cache invalidation baseline was not published: ${cold.result.stdout}`);
  runCached('runtime-cache invalidation baseline hit', false, 'hit');

  await writeFile(path.join(root, 'scripts', 'README.md'), '# ignored cache notes\n', 'utf8');
  runCached('runtime-cache ignored README change', false, 'hit');

  const candidate = path.join(root, 'scripts', 'cache-certification-extra.lua');
  await writeFile(candidate, 'return {}\n', 'utf8');
  const candidateAdded = runCached('runtime-cache candidate source addition', true, 'stale');
  if (candidateAdded.payload.runtimeCache?.published !== true)
    fail(`Candidate-source addition did not republish: ${candidateAdded.result.stdout}`);
  await rm(candidate);
  const candidateDeleted = runCached('runtime-cache candidate source deletion', true, 'stale');
  if (candidateDeleted.payload.runtimeCache?.published !== true)
    fail(`Candidate-source deletion did not republish: ${candidateDeleted.result.stdout}`);

  const projectJson = path.join(root, 'project.json');
  const projectMetadata = await stat(projectJson);
  const moved = new Date(projectMetadata.mtimeMs + 5000);
  await utimes(projectJson, moved, moved);
  const mtimeChanged = runCached('runtime-cache tracked mtime change', true, 'stale');
  if (mtimeChanged.payload.runtimeCache?.published !== true)
    fail(`Tracked mtime change did not republish: ${mtimeChanged.result.stdout}`);

  await writeFile(projectJson, `${await readFile(projectJson, 'utf8')} `, 'utf8');
  const sizeChanged = runCached('runtime-cache tracked size change', true, 'stale');
  if (sizeChanged.payload.runtimeCache?.published !== true)
    fail(`Tracked size change did not republish: ${sizeChanged.result.stdout}`);

  const declaredAsset = path.join(root, 'assets', 'scripts', 'startup.lua');
  await writeFile(
    declaredAsset,
    `${await readFile(declaredAsset, 'utf8')}\n-- cache certification\n`,
  );
  const assetChanged = runCached('runtime-cache declared Asset source change', true, 'stale');
  if (assetChanged.payload.runtimeCache?.published !== true)
    fail(`Declared Asset change did not republish: ${assetChanged.result.stdout}`);

  let manifestPath = await currentManifestPath();
  let manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.compilerIdentity = 'noveltea-certification-incompatible-compiler';
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const compilerChanged = runCached('runtime-cache compiler incompatibility', true, 'stale');
  if (compilerChanged.payload.runtimeCache?.published !== true)
    fail(`Compiler incompatibility did not self-heal: ${compilerChanged.result.stdout}`);

  manifestPath = await currentManifestPath();
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.schema = 17;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const schemaChanged = runCached('runtime-cache malformed typed schema', true, 'unusable');
  if (schemaChanged.payload.runtimeCache?.published !== true)
    fail(`Cache-schema incompatibility did not self-heal: ${schemaChanged.result.stdout}`);

  manifestPath = await currentManifestPath();
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.compiledProject.formatVersion = 999;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const runtimeSchemaChanged = runCached(
    'runtime-cache compiled schema incompatibility',
    true,
    'unusable',
  );
  if (runtimeSchemaChanged.payload.runtimeCache?.published !== true)
    fail(
      `Compiled-schema incompatibility did not self-heal: ${runtimeSchemaChanged.result.stdout}`,
    );

  const corruptGeneration = (await readFile(path.join(cacheRoot, 'current'), 'utf8')).trim();
  await writeFile(
    path.join(cacheRoot, 'generations', corruptGeneration, 'artifact.json'),
    '{broken',
  );
  const corrupt = runCached('runtime-cache malformed artifact recovery', true, 'unusable');
  if (corrupt.payload.runtimeCache?.published !== true)
    fail(`Malformed cache artifact did not self-heal: ${corrupt.result.stdout}`);

  const currentPointer = path.join(cacheRoot, 'current');
  await rm(currentPointer, { force: true });
  await mkdir(currentPointer);
  const publicationFailure = runCached('runtime-cache publication failure', true, 'unusable');
  if (publicationFailure.payload.runtimeCache?.published !== false)
    fail(
      `Cache publication failure did not preserve execution: ${publicationFailure.result.stdout}`,
    );

  const deletionRoot = path.join(tempRoot, 'runtime-cache-tracked-deletion');
  await resetCase(pristine, deletionRoot);
  requireSuccess(
    'runtime-cache deletion authored Test setup',
    runNative(
      ['--project', deletionRoot, '--json', 'entity', 'create', 'tests', 'cache-certification'],
      { cwd: deletionRoot },
    ),
  );
  requireSuccess(
    'runtime-cache deletion baseline publish',
    runNative(['--project', deletionRoot, '--json', 'test', 'run', 'cache-certification'], {
      cwd: deletionRoot,
    }),
  );
  await rm(path.join(deletionRoot, 'records', 'rooms', 'gallery.json'));
  const deleted = runNative(
    ['--project', deletionRoot, '--json', 'test', 'run', 'cache-certification'],
    { cwd: deletionRoot, env: tracedEnvironment },
  );
  assertIslandTrace('runtime-cache tracked source deletion', deleted, true);
  if (deleted.stderr.includes('[scriptc-host] runtime cache hit: static/native test path admitted'))
    fail(`Tracked-source deletion incorrectly admitted stale cache state: ${deleted.stderr}`);
}

async function certifyFeatureLabAuthoredTests(tempRoot) {
  const source = path.join(repositoryRoot, 'tests', 'projects', 'feature-lab');
  const root = path.join(tempRoot, 'feature-lab');
  await rm(root, { recursive: true, force: true });
  await cp(source, root, { recursive: true });
  await rm(path.join(root, '.noveltea', 'cache', 'runtime'), { recursive: true, force: true });
  const tracedEnvironment = { ...process.env, NOVELTEA_CLI_TRACE: '1' };

  const suite = requireSuccess(
    'Feature Lab authored suite',
    runNative(['--project', root, '--json', 'test', 'run'], {
      cwd: root,
      env: tracedEnvironment,
    }),
  );
  assertIslandTrace('Feature Lab cold authored suite', suite, true);
  const suitePayload = JSON.parse(suite.stdout);
  const counts = suitePayload.native?.report?.counts;
  if (
    counts?.total !== 4 ||
    counts?.passed !== 4 ||
    counts?.failed !== 0 ||
    counts?.blocked !== 0 ||
    counts?.error !== 0
  )
    fail(`Feature Lab suite returned unexpected aggregate results: ${suite.stdout}`);

  const targeted = requireSuccess(
    'Feature Lab targeted authored Test',
    runNative(['--project', root, '--json', 'test', 'run', 'rooms-interactions-flow'], {
      cwd: root,
      env: tracedEnvironment,
    }),
  );
  assertIslandTrace('Feature Lab cached targeted authored Test', targeted, false);
  const targetedPayload = JSON.parse(targeted.stdout);
  if (targetedPayload.native?.report?.passed !== true)
    fail(
      `Feature Lab targeted Test did not retain single-test report semantics: ${targeted.stdout}`,
    );

  const humanSuite = requireSuccess(
    'Feature Lab human authored suite',
    runNative(['--project', root, 'test', 'run'], { cwd: root }),
  );
  if (!humanSuite.stdout.includes('Test suite: 4 passed, 0 failed, 0 blocked, 0 errors.'))
    fail(`Feature Lab human suite summary is not aggregate-driven: ${humanSuite.stdout}`);
}

async function certifyNativeOperations(tempRoot, pristine) {
  const root = path.join(tempRoot, 'native-operations');
  const cacheRoot = path.join(root, '.noveltea', 'cache', 'runtime');
  await resetCase(pristine, root);

  requireSuccess(
    'runtime-cache authored test creation',
    runNative(['--project', root, '--json', 'entity', 'create', 'tests', 'cache-certification'], {
      cwd: root,
    }),
  );
  const tracedEnvironment = { ...process.env, NOVELTEA_CLI_TRACE: '1' };
  const firstCachedTest = requireSuccess(
    'runtime-cache first authored test',
    runNative(['--project', root, '--json', 'test', 'run', 'cache-certification'], {
      cwd: root,
      env: tracedEnvironment,
    }),
  );
  assertIslandTrace('runtime-cache first authored test', firstCachedTest, true);
  const firstCachedPayload = JSON.parse(firstCachedTest.stdout);
  if (
    firstCachedPayload.runtimeCache?.status !== 'miss' ||
    firstCachedPayload.runtimeCache?.published !== true
  )
    fail(
      `Standalone runtime cache did not publish on first authored test: ${firstCachedTest.stdout}`,
    );
  const secondCachedTest = requireSuccess(
    'runtime-cache second authored test',
    runNative(['--project', root, '--json', 'test', 'run', 'cache-certification'], {
      cwd: root,
      env: tracedEnvironment,
    }),
  );
  assertIslandTrace('runtime-cache second authored test', secondCachedTest, false);
  const secondCachedPayload = JSON.parse(secondCachedTest.stdout);
  if (secondCachedPayload.runtimeCache?.status !== 'hit')
    fail(
      `Standalone runtime cache did not hit on second authored test: ${secondCachedTest.stdout}`,
    );
  if (
    !secondCachedTest.stderr.includes(
      '[scriptc-host] runtime cache hit: static/native test path admitted',
    )
  )
    fail(
      `Standalone runtime cache hit was not visible in trace output: ${secondCachedTest.stderr}`,
    );
  const missingCachedTest = runNative(
    ['--project', root, '--json', 'test', 'run', 'does-not-exist'],
    { cwd: root, env: tracedEnvironment },
  );
  if (missingCachedTest.status === 0)
    fail('Missing authored Test unexpectedly succeeded from the static cache path.');
  assertIslandTrace('runtime-cache missing authored Test', missingCachedTest, false);
  const missingCachedPayload = JSON.parse(missingCachedTest.stdout);
  if (!missingCachedPayload.diagnostics?.some((item) => item.code === 'native.test.spec'))
    fail(`Missing static cached Test did not preserve diagnostics: ${missingCachedTest.stdout}`);

  await rm(cacheRoot, { recursive: true, force: true });
  const coldSuite = requireSuccess(
    'runtime-cache cold authored test suite',
    runNative(['--project', root, '--json', 'test', 'run'], {
      cwd: root,
      env: tracedEnvironment,
    }),
  );
  assertIslandTrace('runtime-cache cold authored test suite', coldSuite, true);
  const coldSuitePayload = JSON.parse(coldSuite.stdout);
  if (
    coldSuitePayload.runtimeCache?.status !== 'miss' ||
    coldSuitePayload.runtimeCache?.published !== true ||
    coldSuitePayload.native?.report?.counts?.total !== 1
  )
    fail(`Cold authored test suite did not publish the canonical cache: ${coldSuite.stdout}`);
  const warmSuite = requireSuccess(
    'runtime-cache warm authored test suite',
    runNative(['--project', root, '--json', 'test', 'run'], {
      cwd: root,
      env: tracedEnvironment,
    }),
  );
  assertIslandTrace('runtime-cache warm authored test suite', warmSuite, false);

  const playback = `${JSON.stringify({
    schema: 'noveltea.editor.playback',
    version: 1,
    id: 'certification-empty',
    steps: [],
    finalExpectations: [],
  })}\n`;
  const playbackPath = path.join(tempRoot, 'empty-playback.json');
  await writeFile(playbackPath, playback);
  for (const [label, operation] of [
    ['headless playback', 'run-spec'],
    ['UI playback', 'run-ui-spec'],
  ]) {
    await rm(cacheRoot, { recursive: true, force: true });
    const cold = requireSuccess(
      `runtime-cache cold ${label}`,
      runNativeWithStdinFile(['--project', root, '--json', 'test', operation], playbackPath, {
        cwd: root,
        env: tracedEnvironment,
      }),
    );
    assertIslandTrace(`runtime-cache cold ${label}`, cold, true);
    const coldPayload = JSON.parse(cold.stdout);
    if (coldPayload.runtimeCache?.status !== 'miss' || coldPayload.runtimeCache?.published !== true)
      fail(`Cold ${label} did not publish the canonical cache: ${cold.stdout}`);
    const warm = requireSuccess(
      `runtime-cache warm ${label}`,
      runNativeWithStdinFile(['--project', root, '--json', 'test', operation], playbackPath, {
        cwd: root,
        env: tracedEnvironment,
      }),
    );
    assertIslandTrace(`runtime-cache warm ${label}`, warm, false);
  }

  const admittedGeneration = (await readFile(path.join(cacheRoot, 'current'), 'utf8')).trim();
  const admittedGenerationRoot = path.join(cacheRoot, 'generations', admittedGeneration);
  const admittedArtifactPath = path.join(admittedGenerationRoot, 'artifact.json');
  const admittedManifestPath = path.join(admittedGenerationRoot, 'manifest.json');
  const admittedArtifact = JSON.parse(await readFile(admittedArtifactPath, 'utf8'));
  admittedArtifact.compiledProject = {
    schema: 'noveltea.compiled.project',
    schemaVersion: 1,
  };
  const rejectedArtifactText = `${JSON.stringify(admittedArtifact)}\n`;
  await writeFile(admittedArtifactPath, rejectedArtifactText);
  const admittedManifest = JSON.parse(await readFile(admittedManifestPath, 'utf8'));
  admittedManifest.artifactSha256 = `sha256:${sha256(Buffer.from(rejectedArtifactText))}`;
  await writeFile(admittedManifestPath, `${JSON.stringify(admittedManifest)}\n`);

  const admissionRetry = requireSuccess(
    'runtime-cache native admission retry',
    runNative(['--project', root, '--json', 'test', 'run', 'cache-certification'], {
      cwd: root,
      env: tracedEnvironment,
    }),
  );
  assertIslandTrace('runtime-cache native admission retry', admissionRetry, true);
  if (
    !admissionRetry.stderr.includes(
      '[scriptc-host] runtime cache hit: static/native test path admitted',
    ) ||
    !admissionRetry.stderr.includes('forced canonical retry')
  )
    fail(
      `Standalone native admission retry did not force canonical recovery: ${admissionRetry.stderr}`,
    );
  const admissionRetryPayload = JSON.parse(admissionRetry.stdout);
  if (
    admissionRetryPayload.runtimeCache?.status !== 'unusable' ||
    admissionRetryPayload.runtimeCache?.reason !== 'cached-native-admission-rejected' ||
    admissionRetryPayload.runtimeCache?.published !== true
  )
    fail(`Standalone native admission retry did not rebuild canonically: ${admissionRetry.stdout}`);

  const suite = requireSuccess(
    'cached authored test suite',
    runNative(['--project', root, '--json', 'test', 'run'], {
      cwd: root,
      env: tracedEnvironment,
    }),
  );
  assertIslandTrace('cached authored test suite', suite, false);
  const suitePayload = JSON.parse(suite.stdout);
  if (suitePayload.native?.report?.counts?.total !== 1)
    fail(`Cached authored test suite returned an unexpected report: ${suite.stdout}`);

  const testRecordPath = path.join(root, 'records', 'tests', 'cache-certification.json');
  const testRecord = JSON.parse(await readFile(testRecordPath, 'utf8'));
  testRecord.label = 'Cache certification refreshed';
  await writeFile(testRecordPath, `${JSON.stringify(testRecord, null, 2)}\n`);
  const staleFallback = requireSuccess(
    'runtime-cache stale fallback',
    runNative(['--project', root, '--json', 'test', 'run', 'cache-certification'], {
      cwd: root,
      env: tracedEnvironment,
    }),
  );
  assertIslandTrace('runtime-cache stale fallback', staleFallback, true);
  const stalePayload = JSON.parse(staleFallback.stdout);
  if (
    stalePayload.runtimeCache?.testCatalogStatus !== 'stale' ||
    stalePayload.runtimeCache?.published !== true
  )
    fail(`Standalone stale cache fallback did not refresh the catalog: ${staleFallback.stdout}`);

  const runnableSteps = testRecord.data.steps;
  testRecord.data.steps = [];
  await writeFile(testRecordPath, `${JSON.stringify(testRecord, null, 2)}\n`);
  const blockedRefresh = runNative(
    ['--project', root, '--json', 'test', 'run', 'cache-certification'],
    { cwd: root, env: tracedEnvironment },
  );
  if (blockedRefresh.status === 0)
    fail('Blocked authored Test unexpectedly succeeded while refreshing the cache.');
  assertIslandTrace('blocked authored Test cache refresh', blockedRefresh, true);
  const blockedRefreshPayload = JSON.parse(blockedRefresh.stdout);
  if (blockedRefreshPayload.runtimeCache?.published !== true)
    fail(`Blocked authored Test did not publish its refreshed catalog: ${blockedRefresh.stdout}`);

  const blockedHit = runNative(
    ['--project', root, '--json', 'test', 'run', 'cache-certification'],
    { cwd: root, env: tracedEnvironment },
  );
  if (blockedHit.status === 0)
    fail('Blocked authored Test unexpectedly succeeded from the static cache path.');
  assertIslandTrace('blocked authored Test cache hit', blockedHit, false);
  const blockedHitPayload = JSON.parse(blockedHit.stdout);
  if (!blockedHitPayload.diagnostics?.some((item) => item.code === 'native.test.spec'))
    fail(`Blocked static cache hit lost readiness diagnostics: ${blockedHit.stdout}`);

  const blockedSuite = requireSuccess(
    'blocked-only cached authored test suite',
    runNative(['--project', root, '--json', 'test', 'run'], {
      cwd: root,
      env: tracedEnvironment,
    }),
  );
  assertIslandTrace('blocked-only cached authored test suite', blockedSuite, false);
  const blockedSuitePayload = JSON.parse(blockedSuite.stdout);
  if (
    blockedSuitePayload.native?.report?.counts?.blocked !== 1 ||
    blockedSuitePayload.native?.report?.counts?.failed !== 0 ||
    blockedSuitePayload.native?.report?.counts?.error !== 0
  )
    fail(`Blocked-only cached suite returned unexpected counts: ${blockedSuite.stdout}`);
  const blockedSuiteReadiness =
    blockedSuitePayload.native?.report?.entries?.[0]?.diagnostics?.[0]?.message;
  if (
    typeof blockedSuiteReadiness !== 'string' ||
    !blockedSuitePayload.diagnostics?.some((item) => item.message === blockedSuiteReadiness)
  )
    fail(`Blocked cached suite did not promote readiness diagnostics: ${blockedSuite.stdout}`);

  testRecord.data.steps = runnableSteps;
  await writeFile(testRecordPath, `${JSON.stringify(testRecord, null, 2)}\n`);

  const staleCatalogRoot = path.join(tempRoot, 'runtime-cache-stdin-stale-catalog');
  await resetCase(pristine, staleCatalogRoot);
  requireSuccess(
    'runtime-cache stale-catalog stdin setup',
    runNative(
      ['--project', staleCatalogRoot, '--json', 'entity', 'create', 'tests', 'cache-certification'],
      { cwd: staleCatalogRoot },
    ),
  );
  requireSuccess(
    'runtime-cache stale-catalog baseline publish',
    runNative(['--project', staleCatalogRoot, '--json', 'test', 'run', 'cache-certification'], {
      cwd: staleCatalogRoot,
      env: tracedEnvironment,
    }),
  );
  const staleCatalogTestPath = path.join(
    staleCatalogRoot,
    'records',
    'tests',
    'cache-certification.json',
  );
  const staleCatalogTest = JSON.parse(await readFile(staleCatalogTestPath, 'utf8'));
  staleCatalogTest.label = 'Changed without changing runtime';
  await writeJson(staleCatalogTestPath, staleCatalogTest);
  const staleCatalogSpec = requireSuccess(
    'runtime-cache stdin playback with stale authored-test catalog',
    runNativeWithStdinFile(
      ['--project', staleCatalogRoot, '--json', 'test', 'run-spec'],
      playbackPath,
      { cwd: staleCatalogRoot, env: tracedEnvironment },
    ),
  );
  assertIslandTrace(
    'runtime-cache stdin playback with stale authored-test catalog',
    staleCatalogSpec,
    false,
  );
  const staleCatalogSpecPayload = JSON.parse(staleCatalogSpec.stdout);
  if (
    staleCatalogSpecPayload.runtimeCache?.status !== 'hit' ||
    staleCatalogSpecPayload.runtimeCache?.testCatalogStatus !== 'stale'
  )
    fail(
      `Stdin playback did not preserve the native runtime hit across stale authored Tests: ${staleCatalogSpec.stdout}`,
    );

  const emptyStdin = runNative(['--project', staleCatalogRoot, '--json', 'test', 'run-spec'], {
    cwd: staleCatalogRoot,
    env: tracedEnvironment,
    stdin: '',
  });
  if (emptyStdin.status !== 2) fail(`Cached empty stdin returned exit ${emptyStdin.status}.`);
  assertIslandTrace('runtime-cache empty stdin usage error', emptyStdin, false);
  const emptyStdinPayload = JSON.parse(emptyStdin.stdout);
  if (
    emptyStdinPayload.diagnostics?.length !== 1 ||
    emptyStdinPayload.diagnostics[0]?.code !== 'CLI_USAGE' ||
    emptyStdinPayload.diagnostics[0]?.message !== 'Command requires one UTF-8 JSON value on stdin.'
  )
    fail(`Cached empty stdin changed CLI usage semantics: ${emptyStdin.stdout}`);

  const malformedStdin = runNative(['--project', staleCatalogRoot, '--json', 'test', 'run-spec'], {
    cwd: staleCatalogRoot,
    env: tracedEnvironment,
    stdin: '{bad',
  });
  if (malformedStdin.status !== 2)
    fail(`Cached malformed stdin returned exit ${malformedStdin.status}.`);
  assertIslandTrace('runtime-cache malformed stdin canonical diagnostics', malformedStdin, true);

  const output = path.join(tempRoot, 'certification.ntpkg');
  requireSuccess(
    'package export',
    runNative(['--project', root, '--json', 'package', 'export', '--output', output], {
      cwd: root,
    }),
  );
  if (!(await stat(output)).isFile())
    fail('Package export did not produce the requested output file.');

  const fontCoverageRequestPath = path.join(tempRoot, 'font-coverage-request.json');
  await writeJson(fontCoverageRequestPath, {
    projectRoot: root,
    systemRoot: path.join(repositoryRoot, 'engine', 'assets', 'system'),
    locales: [
      {
        locale: 'en',
        supported: true,
        fonts: [],
        messages: [{ messageId: 'certification', sourcePath: '/certification', text: 'Menu' }],
      },
    ],
  });
  const fontCoverage = requireSuccess(
    'internal font coverage',
    runNativeWithStdinFile(['__editor-native', 'font-coverage'], fontCoverageRequestPath, {
      cwd: root,
    }),
  );
  const fontCoverageResponse = JSON.parse(fontCoverage.stdout);
  if (fontCoverageResponse.ok !== true || fontCoverageResponse.success !== true)
    fail(`Internal font coverage certification failed: ${fontCoverage.stdout}`);
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
    shaderVariants: ['essl-300'],
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
  const env = {
    ...process.env,
    NOVELTEA_TEMPLATE_REGISTRY_ROOT: registry,
    NOVELTEA_CLI_TRACE: '1',
  };
  const installed = requireSuccess(
    'standalone template install',
    runNative(['--json', 'platform', 'template', 'install', archive, '--force'], {
      cwd: tempRoot,
      env,
    }),
  );
  assertIslandTrace('standalone template install', installed, true);
  assertIslandBoundaryTrace(
    'standalone template install',
    installed,
    'platform host configuration starting',
    true,
  );
  assertIslandBoundaryTrace(
    'standalone template install',
    installed,
    'workspace services import starting',
    false,
  );
  const listed = requireSuccess(
    'standalone template list',
    runNative(['--json', 'platform', 'template', 'list'], { cwd: tempRoot, env }),
  );
  assertIslandTrace('standalone template list', listed, true);
  assertIslandBoundaryTrace(
    'standalone template list',
    listed,
    'platform host configuration starting',
    false,
  );
  assertIslandBoundaryTrace(
    'standalone template list',
    listed,
    'workspace services import starting',
    false,
  );
  const templates = JSON.parse(listed.stdout).templates;
  if (!Array.isArray(templates) || templates[0]?.id !== 'certification-web-template@build-1')
    fail('Standalone template registry did not return the installed template identity.');
  const config = path.join(tempRoot, 'platform-export-config.json');
  const configured = requireSuccess(
    'standalone platform config',
    runNative(['--json', 'platform', 'config', 'init', config], { cwd: tempRoot, env }),
  );
  assertIslandTrace('standalone platform config', configured, true);
  assertIslandBoundaryTrace(
    'standalone platform config',
    configured,
    'platform host configuration starting',
    false,
  );
  assertIslandBoundaryTrace(
    'standalone platform config',
    configured,
    'workspace services import starting',
    false,
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
  assertIslandTrace('standalone platform export', exported, true);
  assertIslandBoundaryTrace(
    'standalone platform export',
    exported,
    'platform host configuration starting',
    true,
  );
  assertIslandBoundaryTrace(
    'standalone platform export',
    exported,
    'workspace services import starting',
    true,
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
    const nodeEnvironment = {
      ...process.env,
      NOVELTEA_USER_CONFIG_ROOT: nodeConfigRoot,
    };
    const windowsNode = isWindows
      ? await runWindowsConsoleProcess(process.execPath, [nodeCli, ...cancelArgs], {
          cwd: tempRoot,
          env: nodeEnvironment,
        })
      : null;
    const nodeInvocation = windowsNode
      ? windowsNode.invocation
      : await runAsync(process.execPath, [nodeCli, ...cancelArgs], {
          cwd: tempRoot,
          env: nodeEnvironment,
        });
    const nodeResultPromise = nodeInvocation.result();
    await waitForComfyUiRequest(cancellationServer.logPath, '/prompt');
    if (windowsNode) sendWindowsConsoleCtrlC(windowsNode.pid);
    else nodeInvocation.child.kill('SIGINT');
    const nodeResult = await nodeResultPromise;
    if (nodeResult.status !== 130)
      fail(`Node ComfyUI cancellation exited ${nodeResult.status}, expected 130.`);
    let requests = await readComfyUiRequests(cancellationServer.logPath);
    if (!requests.some((request) => request.method === 'POST' && request.path === '/queue'))
      fail('Node ComfyUI cancellation did not issue prompt-specific queue deletion.');
    if (requests.some((request) => request.path === '/interrupt'))
      fail('Node ComfyUI cancellation used the forbidden global /interrupt endpoint.');
    process.stdout.write('[comfyui cancellation] Node Ctrl+C: PASS\n');

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
  let primaryError = null;
  let cleanupError = null;
  try {
    const { pristine } = await runDifferential(tempRoot);
    certifyBootstrapOnlyIslandFailures();
    await certifyTypedShaders(tempRoot);
    await certifyRawShaderc(tempRoot);
    await certifyAuthoringCache(tempRoot, pristine);
    await certifyTestCommandParity(tempRoot, pristine);
    await certifyRuntimeCacheInvalidation(tempRoot, pristine);
    await certifyNativeOperations(tempRoot, pristine);
    await certifyFeatureLabAuthoredTests(tempRoot);
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
          'font-coverage',
          'package-export',
          'platform-template-registry',
          'platform-config',
          'platform-export',
        ],
        testCommandParity: true,
        runtimeCacheCertification: true,
        authoringCacheCertification: true,
        featureLabSuite: true,
        relocation: true,
        sourceLeakageAudit: true,
        binarySize,
        windowsPeStackReserve,
        linkedClosure: closure,
      })}\n`,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await rm(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: isWindows ? 20 : 0,
        retryDelay: 100,
      });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError !== null) {
    if (cleanupError !== null)
      process.stderr.write(
        `[certification] Temp cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : 'unknown cleanup error'}\n`,
      );
    throw primaryError;
  }
  if (cleanupError !== null) throw cleanupError;
}

await main();
