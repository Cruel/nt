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
import { resolvePnpmInvocation } from './pnpm-invocation.mjs';

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
    timeout: options.timeout,
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
  const invocation = resolvePnpmInvocation(args);
  return run(invocation.command, invocation.args, options);
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

async function treeSnapshot(root, normalizeFile = null) {
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
      else if (info.isFile()) {
        const bytes = await readFile(absolute);
        records.push(['file', child, sha256(normalizeFile?.(child, bytes) ?? bytes)]);
      }
    }
  }
  await visit();
  return JSON.stringify(records);
}

function describeTreeDifference(expectedJson, actualJson) {
  const expected = JSON.parse(expectedJson);
  const actual = JSON.parse(actualJson);
  const count = Math.max(expected.length, actual.length);
  for (let index = 0; index < count; index += 1) {
    if (JSON.stringify(expected[index]) !== JSON.stringify(actual[index]))
      return `first difference at ${index}: expected=${JSON.stringify(expected[index])} actual=${JSON.stringify(actual[index])}`;
  }
  return 'tree snapshots differ';
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

function runNativeNoDaemon(args, options = {}) {
  return runNative(args, {
    ...options,
    env: { ...process.env, ...options.env, NOVELTEA_NO_DAEMON: '1' },
  });
}

function runNodeAsync(args, options = {}) {
  return runAsync(process.execPath, [nodeCli, ...args], {
    ...options,
    env: { ...process.env, ...options.env, NOVELTEA_CLI: nativeCli },
  }).then((process) => process.result());
}

function runNativeAsync(args, options = {}) {
  return runAsync(nativeCli, args, options).then((process) => process.result());
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
    stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
  if (options.stdin !== undefined) child.stdin.end(options.stdin);
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

async function waitForComfyUiRequestPrefix(logPath, expectedPrefix, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    latest = await readComfyUiRequests(logPath);
    if (latest.some((request) => request.path.startsWith(expectedPrefix))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  fail(
    `Timed out waiting for fake ComfyUI request prefix '${expectedPrefix}'. ` +
      `Observed requests: ${JSON.stringify(latest.map((request) => request.path))}`,
  );
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await stat(filePath)).isFile()) return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fail(`Timed out waiting for file: ${filePath}`);
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
  const env = { ...process.env, NOVELTEA_CLI_TRACE: '1', NOVELTEA_NO_DAEMON: '1' };
  for (const test of [
    {
      label: 'repeated global help',
      args: ['--help', '--help'],
      expectedStatus: 0,
      expectedIsland: false,
    },
    {
      label: 'unknown global option',
      args: ['--not-a-global-option'],
      expectedStatus: 2,
      expectedIsland: true,
    },
  ]) {
    const result = runNative(test.args, { env });
    if (result.status !== test.expectedStatus)
      fail(
        `${test.label} returned ${result.status ?? 'no status'} instead of ${test.expectedStatus}.`,
      );
    assertIslandTrace(test.label, result, test.expectedIsland);
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

function canonicalOperationJson(stdout) {
  if (!stdout) return stdout;
  const value = JSON.parse(stdout);
  if (value && typeof value === 'object' && !Array.isArray(value)) delete value.operationId;
  return `${JSON.stringify(value)}\n`;
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
    name: 'asset-audit',
    args: (root) => ['--project', root, '--json', 'asset', 'audit'],
  },
  {
    name: 'asset-audit-unrelated-malformed',
    args: (root) => ['--project', root, '--json', 'asset', 'audit'],
    prepare: async (root) => {
      const manifestPath = path.join(root, 'project.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.settings = null;
      await writeJson(manifestPath, manifest);
      const dialoguesRoot = path.join(root, 'records', 'dialogues');
      await mkdir(dialoguesRoot, { recursive: true });
      await writeFile(path.join(dialoguesRoot, 'broken.json'), '{"id":');
    },
  },
  {
    name: 'asset-audit-malformed-asset',
    args: (root) => ['--project', root, '--json', 'asset', 'audit'],
    prepare: async (root) => {
      const assetsRoot = path.join(root, 'records', 'assets');
      await mkdir(assetsRoot, { recursive: true });
      await writeJson(path.join(assetsRoot, 'broken.json'), {
        id: 'broken',
        label: 'Broken',
        data: {
          kind: 'not-an-asset-kind',
          source: { type: 'project-file', path: 'assets/text/broken.txt' },
          aliases: [],
          imageMetadata: null,
        },
      });
    },
  },
  {
    name: 'asset-import-execute',
    mutation: true,
    normalizeTree(relativePath, bytes) {
      if (relativePath !== 'records/assets/daemon-parity.json') return bytes;
      const record = JSON.parse(bytes.toString('utf8'));
      delete record.data.importedAt;
      return Buffer.from(JSON.stringify(record));
    },
    prepare: async (root) => {
      const source = path.join(root, 'assets', 'text', 'daemon-parity.txt');
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, 'daemon parity asset\n');
    },
    args: (root) => [
      '--project',
      root,
      '--json',
      'asset',
      'import',
      path.join(root, 'assets', 'text', 'daemon-parity.txt'),
    ],
  },
  {
    name: 'localization-sync-dry-run',
    args: (root) => ['--project', root, '--json', 'localization', 'sync', '--dry-run'],
  },
  {
    name: 'localization-reconcile',
    args: (root) => ['--project', root, '--json', 'localization', 'reconcile'],
  },
  {
    name: 'localization-reconcile-apply-stale',
    args: (root) => ['--project', root, '--json', 'localization', 'reconcile', '--apply'],
    stdin: `${JSON.stringify({
      expectedWorkspaceRevision: 'sha256:stale',
      expectedFingerprint: 'sha256:stale',
      resolutions: {},
    })}\n`,
  },
  {
    name: 'localization-view',
    args: (root) => ['--project', root, '--json', 'localization', 'view', 'fr'],
  },
  {
    name: 'localization-accept-dry-run',
    args: (root) => [
      '--project',
      root,
      '--json',
      'localization',
      'accept',
      'fr',
      '11111111-1111-4111-8111-111111111111',
      '--dry-run',
    ],
  },
  {
    name: 'localization-review-dry-run',
    args: (root) => [
      '--project',
      root,
      '--json',
      'localization',
      'review',
      'fr',
      '11111111-1111-4111-8111-111111111111',
      '--dry-run',
    ],
  },
  {
    name: 'shaders-compile',
    args: (root) => ['--project', root, '--json', 'shaders', 'compile', '--force-rebuild'],
  },
  {
    name: 'package-export',
    args: (root) => [
      '--project',
      root,
      '--json',
      'package',
      'export',
      '--output',
      path.join(root, 'daemon-parity.ntpkg'),
    ],
  },
  {
    name: 'platform-template-list',
    args: () => ['--json', 'platform', 'template', 'list'],
    project: false,
  },
  {
    name: 'platform-template-inspect-missing',
    args: () => ['--json', 'platform', 'template', 'inspect', 'missing@missing'],
    project: false,
  },
  {
    name: 'platform-template-install-missing',
    args: (root) => [
      '--json',
      'platform',
      'template',
      'install',
      path.join(root, 'missing-template.tar.gz'),
    ],
    project: false,
  },
  {
    name: 'platform-template-remove-missing',
    args: () => ['--json', 'platform', 'template', 'remove', 'missing@missing', '--force'],
    project: false,
  },
  {
    name: 'platform-config-init',
    args: (root) => ['--json', 'platform', 'config', 'init', path.join(root, 'daemon-parity.json')],
  },
  {
    name: 'platform-export-check',
    canonicalStdout: canonicalOperationJson,
    args: (root) => [
      '--project',
      root,
      '--json',
      'platform',
      'export',
      '--output',
      path.join(root, 'daemon-platform-parity'),
      '--check',
    ],
  },
  {
    name: 'platform-profiles',
    args: (root) => ['--project', root, '--json', 'platform', 'profiles'],
  },
  {
    name: 'platform-profiles-unrelated-malformed',
    args: (root) => ['--project', root, '--json', 'platform', 'profiles'],
    prepare: async (root) => {
      const manifestPath = path.join(root, 'project.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.settings = null;
      await writeJson(manifestPath, manifest);
      const dialoguesRoot = path.join(root, 'records', 'dialogues');
      await mkdir(dialoguesRoot, { recursive: true });
      await writeFile(path.join(dialoguesRoot, 'broken.json'), '{"id":');
    },
  },
  {
    name: 'platform-profiles-malformed-profile',
    args: (root) => ['--project', root, '--json', 'platform', 'profiles'],
    prepare: async (root) => {
      const manifestPath = path.join(root, 'project.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.export.profiles[0].target = 'not-a-platform';
      await writeJson(manifestPath, manifest);
    },
  },
  {
    name: 'platform-profiles-missing-memory-policy',
    args: (root) => ['--project', root, '--json', 'platform', 'profiles'],
    prepare: async (root) => {
      const manifestPath = path.join(root, 'project.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.export.profiles[0].assetMemory = {
        kind: 'policy',
        policyId: 'missing-policy',
      };
      await writeJson(manifestPath, manifest);
    },
  },
  {
    name: 'platform-profiles-multiple-export-diagnostics',
    args: (root) => ['--project', root, '--json', 'platform', 'profiles'],
    prepare: async (root) => {
      const manifestPath = path.join(root, 'project.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.export.assetMemoryPolicies = [
        {
          id: 'too-warm',
          label: 'Too warm',
          basePreset: 'low',
          overrides: { warmPreparedCpuBytes: 40 * 1024 * 1024 },
        },
      ];
      manifest.export.profiles[0].assetMemory = {
        kind: 'policy',
        policyId: 'missing-policy',
      };
      await writeJson(manifestPath, manifest);
    },
  },
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
    mutation: true,
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
    mutation: true,
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
    mutation: true,
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
  const daemonEnvironment = {
    ...process.env,
    NOVELTEA_CLI_CERTIFICATION: '1',
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `differential-${process.pid}-${Date.now()}`,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(tempRoot, 'differential-daemon'),
    NOVELTEA_CLI_CERTIFICATION_DAEMON_IDLE_MS: '60000',
    NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS: '60000',
  };
  runNative(['daemon', 'stop'], { env: daemonEnvironment });
  const roots = Object.freeze({
    node: path.join(tempRoot, 'case-node'),
    daemon: path.join(tempRoot, 'case-daemon'),
    noDaemon: path.join(tempRoot, 'case-no-daemon'),
  });
  const canonicalizeLaneText = (value, root) => {
    const escapedRoot = JSON.stringify(root).slice(1, -1);
    return value.split(escapedRoot).join('<project-root>').split(root).join('<project-root>');
  };
  const replaceBuffer = (input, needle, replacement) => {
    const parts = [];
    let offset = 0;
    let index = input.indexOf(needle, offset);
    if (index === -1) return input;
    while (index !== -1) {
      parts.push(input.subarray(offset, index), replacement);
      offset = index + needle.length;
      index = input.indexOf(needle, offset);
    }
    parts.push(input.subarray(offset));
    return Buffer.concat(parts);
  };
  const canonicalizeLaneBytes = (bytes, root) => {
    const replacement = Buffer.from('<project-root>');
    const escapedRoot = JSON.stringify(root).slice(1, -1);
    let result = Buffer.from(bytes);
    result = replaceBuffer(result, Buffer.from(escapedRoot), replacement);
    return replaceBuffer(result, Buffer.from(root), replacement);
  };

  for (const test of differentialCases) {
    runNative(['daemon', 'stop'], { env: daemonEnvironment });
    await Promise.all(
      Object.values(roots).map(async (root) => {
        await resetCase(pristine, root);
        await test.prepare?.(root);
      }),
    );
    const lane = (root) => ({
      root,
      args: test.args(root),
      cwd: test.cwd?.(root) ?? (test.project === false ? repositoryRoot : root),
    });
    const nodeLane = lane(roots.node);
    const daemonLane = lane(roots.daemon);
    const noDaemonLane = lane(roots.noDaemon);
    const [nodeResultRaw, scriptcResultRaw, noDaemonResultRaw] = await Promise.all([
      runNodeAsync(nodeLane.args, { cwd: nodeLane.cwd, stdin: test.stdin }),
      runNativeAsync(daemonLane.args, {
        cwd: daemonLane.cwd,
        env: daemonEnvironment,
        stdin: test.stdin,
      }),
      runNativeAsync(noDaemonLane.args, {
        cwd: noDaemonLane.cwd,
        env: { ...daemonEnvironment, NOVELTEA_NO_DAEMON: '1' },
        stdin: test.stdin,
      }),
    ]);
    const normalizeResult = (result, root) => ({
      ...result,
      stdout: canonicalizeLaneText(result.stdout, root),
      stderr: canonicalizeLaneText(result.stderr, root),
    });
    const nodeResult = normalizeResult(nodeResultRaw, roots.node);
    const scriptcResult = normalizeResult(scriptcResultRaw, roots.daemon);
    const noDaemonResult = normalizeResult(noDaemonResultRaw, roots.noDaemon);
    const [nodeTree, scriptcTree, noDaemonTree] = await Promise.all(
      [roots.node, roots.daemon, roots.noDaemon].map((root) =>
        test.project === false
          ? Promise.resolve('')
          : treeSnapshot(root, (relativePath, bytes) =>
              canonicalizeLaneBytes(
                test.normalizeTree ? test.normalizeTree(relativePath, bytes) : bytes,
                root,
              ),
            ),
      ),
    );

    const canonicalStdout = test.canonicalStdout ?? ((value) => value);
    if (
      scriptcResult.status !== nodeResult.status ||
      canonicalStdout(scriptcResult.stdout) !== canonicalStdout(nodeResult.stdout) ||
      scriptcResult.stderr !== nodeResult.stderr
    ) {
      await resetCase(pristine, roots.daemon);
      await test.prepare?.(roots.daemon);
      const tracedRaw = runNative(test.args(roots.daemon), {
        cwd: test.cwd?.(roots.daemon) ?? (test.project === false ? repositoryRoot : roots.daemon),
        env: { ...daemonEnvironment, NOVELTEA_CLI_TRACE: '1' },
        stdin: test.stdin,
      });
      const traced = normalizeResult(tracedRaw, roots.daemon);
      fail(
        `Node/scriptc differential '${test.name}' differs.\n` +
          `Node: status=${nodeResult.status}\nstdout:\n${nodeResult.stdout}\nstderr:\n${nodeResult.stderr}\n` +
          `scriptc: status=${scriptcResult.status}\nstdout:\n${scriptcResult.stdout}\nstderr:\n${scriptcResult.stderr}\n` +
          `scriptc traced retry: status=${traced.status}\nstdout:\n${traced.stdout}\nstderr:\n${traced.stderr}`,
      );
    }
    if (scriptcTree !== nodeTree)
      fail(
        `Node/scriptc differential '${test.name}' produced different filesystem state: ${describeTreeDifference(nodeTree, scriptcTree)}.`,
      );
    if (
      noDaemonResult.status !== nodeResult.status ||
      canonicalStdout(noDaemonResult.stdout) !== canonicalStdout(nodeResult.stdout) ||
      noDaemonResult.stderr !== nodeResult.stderr
    )
      fail(`Node/no-daemon differential '${test.name}' differs.`);
    if (noDaemonTree !== nodeTree)
      fail(
        `Node/no-daemon differential '${test.name}' produced different filesystem state: ${describeTreeDifference(nodeTree, noDaemonTree)}.`,
      );
    process.stdout.write(`[differential] ${test.name}: PASS\n`);
  }
  runNative(['daemon', 'stop'], { env: daemonEnvironment });
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
    const invokeNative = (environment = process.env) =>
      test.stdinPath
        ? runNativeWithStdinFile(args, test.stdinPath, { cwd: root, env: environment })
        : runNative(args, { cwd: root, env: environment });

    await resetCase(baseline, root);
    const nodeFallback = invokeNode();
    await resetCase(baseline, root);
    const scriptcFallback = invokeNative();
    assertPublicCommandParity(`${test.name} fallback`, nodeFallback, scriptcFallback);
    await resetCase(baseline, root);
    const localFallback = invokeNative({ ...process.env, NOVELTEA_NO_DAEMON: '1' });
    assertPublicCommandParity(`${test.name} no-daemon fallback`, nodeFallback, localFallback);

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
    const result = runNative(args, {
      cwd: root,
      env: { ...process.env, NOVELTEA_CLI_TRACE: '1', NOVELTEA_NO_DAEMON: '1' },
    });
    if (island !== null) assertIslandTrace(label, result, island);
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
  // Removing the unadmitted candidate restores the previous source set. Filesystems that preserve
  // every exact metadata proof can reuse the previous current.json immediately; a conservative
  // physical-metadata mismatch is also allowed to recompute once. The repaired generation must
  // then be an exact warm hit.
  invoke('authoring removed candidate', null);
  invoke('authoring removed candidate warm', false);
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
  const currentPath = path.join(cacheRoot, 'current.json');
  await writeFile(currentPath, '{}');
  invoke('authoring corrupt exact result', true);
  await writeFile(currentPath, '{broken');
  invoke('authoring malformed exact result', true);
  const incompatible = JSON.parse(await readFile(currentPath, 'utf8'));
  incompatible.semanticKey = 'different-validation-semantics';
  await writeJson(currentPath, incompatible);
  invoke('authoring incompatible semantic identity', true);
  await rm(currentPath);
  await mkdir(currentPath);
  invoke('authoring best-effort publication', true);
  await rm(currentPath, { recursive: true });
  // The preceding best-effort publication is intentionally detached from command completion. Once
  // the blocking directory is removed, that publication may win the race and make this invocation
  // an immediate exact hit, or this invocation may perform the recovery itself. Either outcome is
  // valid; the following invocation must observe the recovered warm cache.
  invoke('authoring publication recovery', null);
  invoke('authoring recovered warm hit', false);
  const incompleteManifest = JSON.parse(await readFile(currentPath, 'utf8'));
  incompleteManifest.inputs = incompleteManifest.inputs.filter(
    (input) => input.path !== 'traits.json',
  );
  await writeJson(currentPath, incompleteManifest);
  invoke('authoring missing authoritative root fragment', true);
  if (!isWindows) {
    const link = path.join(root, 'scripts/ignored-link.txt');
    await symlink(path.join(root, 'scripts/README.md'), link);
    invoke('authoring conservative native rejection', true);
    await rm(link);
    invoke('authoring native uncertainty resolved', false);
  }
  process.stdout.write('[authoring-cache] cold/warm, parity, invalidation, recovery: PASS\n');
}

async function certifyDaemonAuthoringCacheResidency(tempRoot, pristine) {
  const root = path.join(tempRoot, 'daemon-authoring-exact-cache');
  const runtimeRoot = path.join(os.tmpdir(), `nt-authoring-exact-${process.pid}-${Date.now()}`);
  await resetCase(pristine, root);
  const args = ['--project', root, '--json', 'validate'];
  const environment = {
    ...process.env,
    NOVELTEA_CLI_CERTIFICATION: '1',
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `authoring-exact-${process.pid}-${Date.now()}`,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: runtimeRoot,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_IDLE_MS: '60000',
    NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS: '250',
  };
  const traced = {
    ...environment,
    NOVELTEA_CLI_TRACE: '1',
    NOVELTEA_CLI_VALIDATION_PROFILE: '1',
  };
  runNative(['daemon', 'stop'], { env: environment });
  try {
    const cacheRoot = path.join(root, '.noveltea/cache/authoring');
    await mkdir(cacheRoot, { recursive: true });
    // Block only optional disk publication. Native RAM retention must still answer unchanged
    // validation, proving persistence is not the owner fast path.
    await mkdir(path.join(cacheRoot, 'current.json'));

    const cold = requireSuccess(
      'daemon authoring exact cold admission',
      runNative(args, { cwd: root, env: traced }),
    );
    if (!cold.stderr.includes('[scriptc-host] daemon invocation forwarding'))
      fail(`Cold exact-validation certification did not route through the daemon.\n${cold.stderr}`);
    const coldProfile = validationProfile(cold);
    if (
      !coldProfile ||
      coldProfile.sourceWork.parsedJsonSources <= 0 ||
      coldProfile.sourceWork.wholeProjectSchemaParses !== 1
    )
      fail(`Cold resident validation was not canonical: ${cold.stderr}`);

    const memoryHit = requireSuccess(
      'daemon authoring exact native-memory hit',
      runNative(args, { cwd: root, env: traced }),
    );
    if (
      !memoryHit.stderr.includes('[scriptc-host] daemon invocation forwarding') ||
      validationProfile(memoryHit) ||
      memoryHit.stderr.includes('authoring cache hit: static/native validate path admitted')
    )
      fail(`Exact validation did not return from daemon-native memory: ${memoryHit.stderr}`);

    if (!isWindows) {
      const aliasRoot = path.join(tempRoot, 'daemon-authoring-exact-alias');
      await rm(aliasRoot, { recursive: true, force: true });
      await symlink(root, aliasRoot, 'dir');
      const aliasHit = requireSuccess(
        'daemon authoring exact logical-alias hit',
        runNative(['--project', aliasRoot, '--json', 'validate'], {
          cwd: aliasRoot,
          env: traced,
        }),
      );
      if (
        !aliasHit.stderr.includes('[scriptc-host] daemon invocation forwarding') ||
        validationProfile(aliasHit)
      )
        fail(`Logical alias did not use the retained native exact result: ${aliasHit.stderr}`);
      const aliasEnvelope = JSON.parse(aliasHit.stdout);
      if (aliasEnvelope.projectRoot !== aliasRoot)
        fail(
          `Retained exact validation leaked the first caller's Project root: ${aliasHit.stdout}`,
        );
      const aliasNode = runNode(['--project', aliasRoot, '--json', 'validate'], { cwd: aliasRoot });
      if (aliasNode.status !== aliasHit.status || aliasNode.stdout !== aliasHit.stdout)
        fail('Node/scriptc logical-alias public output differs.');
    }

    let evictedStatus = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      evictedStatus = requireSuccess(
        'daemon authoring owner eviction status',
        runNative(['--json', 'daemon', 'status'], { env: environment }),
      );
      if (JSON.parse(evictedStatus.stdout).daemon.projectSessions === 0) break;
    }
    if (!evictedStatus || JSON.parse(evictedStatus.stdout).daemon.projectSessions !== 0)
      fail(`Exact-validation owner did not evict while idle: ${evictedStatus?.stdout ?? ''}`);
    const evictedMemoryHit = requireSuccess(
      'daemon authoring exact hit after owner eviction',
      runNative(args, { cwd: root, env: traced }),
    );
    if (
      !evictedMemoryHit.stderr.includes('[scriptc-host] daemon invocation forwarding') ||
      validationProfile(evictedMemoryHit)
    )
      fail(
        `Exact validation did not survive owner eviction in native state: ${evictedMemoryHit.stderr}`,
      );

    const projectPath = path.join(root, 'project.json');
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    const originalEntrypoint = project.entrypoint;
    project.entrypoint = { kind: 'room', id: 'missing-daemon-cache-room' };
    await writeJson(projectPath, project);
    const invalid = runNative(args, { cwd: root, env: traced });
    if (invalid.status !== 4 || !validationProfile(invalid))
      fail(`Changed invalid Project was not recomputed canonically: ${invalid.stderr}`);
    const cachedInvalid = runNative(args, { cwd: root, env: traced });
    if (
      cachedInvalid.status !== 4 ||
      !cachedInvalid.stderr.includes('[scriptc-host] daemon invocation forwarding') ||
      validationProfile(cachedInvalid)
    )
      fail(
        `Exact deterministic failure was not retained in native memory: ${cachedInvalid.stderr}`,
      );

    project.entrypoint = originalEntrypoint;
    await writeJson(projectPath, project);
    await rm(path.join(cacheRoot, 'current.json'), { recursive: true, force: true });
    const recovered = requireSuccess(
      'daemon authoring persistent publication recovery',
      runNative(args, { cwd: root, env: traced }),
    );
    if (!validationProfile(recovered))
      fail(`Repaired Project did not recompute before persistent publication: ${recovered.stderr}`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(path.join(cacheRoot, 'current.json'), 'utf8');
        break;
      } catch {
        if (attempt === 99) fail('Daemon did not publish the narrow exact cache while idle.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    requireSuccess(
      'daemon authoring stop before restart cache hit',
      runNative(['--json', 'daemon', 'stop'], { env: environment }),
    );
    const restartHit = requireSuccess(
      'daemon authoring persistent restart hit',
      runNative(args, { cwd: root, env: traced }),
    );
    if (
      !restartHit.stderr.includes('authoring cache hit: static/native validate path admitted') ||
      restartHit.stderr.includes('[scriptc-host] daemon invocation forwarding') ||
      validationProfile(restartHit)
    )
      fail(
        `Whole-daemon restart did not use the narrow persistent exact cache: ${restartHit.stderr}`,
      );

    const fallbackRoot = path.join(tempRoot, 'daemon-authoring-cache-fallback');
    await resetCase(pristine, fallbackRoot);
    const fallbackCacheRoot = path.join(fallbackRoot, '.noveltea/cache/authoring');
    await mkdir(fallbackCacheRoot, { recursive: true });
    await writeFile(path.join(fallbackCacheRoot, 'current.json'), '{broken');
    const fallback = requireSuccess(
      'daemon authoring canonical cold fallback',
      runNative(['--project', fallbackRoot, '--json', 'validate'], {
        cwd: fallbackRoot,
        env: traced,
      }),
    );
    const fallbackProfile = validationProfile(fallback);
    if (
      !fallbackProfile ||
      fallbackProfile.sourceWork.parsedJsonSources <= 0 ||
      fallbackProfile.sourceWork.wholeProjectSchemaParses !== 1
    )
      fail(
        `Unusable persistent exact state did not fall back to canonical cold admission: ${fallback.stderr}`,
      );

    const freshDirectoryRoot = path.join(tempRoot, 'daemon-authoring-cache-fresh-directory');
    await resetCase(pristine, freshDirectoryRoot);
    await rm(path.join(freshDirectoryRoot, '.noveltea/cache/authoring'), {
      recursive: true,
      force: true,
    });
    requireSuccess(
      'daemon authoring fresh cache-directory publication',
      runNative(['--project', freshDirectoryRoot, '--json', 'validate'], {
        cwd: freshDirectoryRoot,
        env: traced,
      }),
    );
    const freshCurrentPath = path.join(
      freshDirectoryRoot,
      '.noveltea/cache/authoring/current.json',
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(freshCurrentPath, 'utf8');
        break;
      } catch {
        if (attempt === 99)
          fail('Daemon did not create and publish the fresh authoring-cache directory hierarchy.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    process.stdout.write(
      '[daemon-authoring-cache] native proof, alias formatting, eviction, fresh publication, restart persistence, recovery: PASS\n',
    );
  } finally {
    runNative(['daemon', 'stop'], { env: environment });
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function certifyDaemonAuthoringCachePressure(tempRoot, pristine) {
  const root = path.join(tempRoot, 'daemon-authoring-exact-pressure');
  const runtimeRoot = path.join(os.tmpdir(), `nt-authoring-pressure-${process.pid}-${Date.now()}`);
  await resetCase(pristine, root);
  const environment = {
    ...process.env,
    NOVELTEA_CLI_CERTIFICATION: '1',
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `authoring-pressure-${process.pid}-${Date.now()}`,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: runtimeRoot,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_IDLE_MS: '60000',
    NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS: '250',
    NOVELTEA_CLI_CERTIFICATION_EXACT_VALIDATION_BUDGET_BYTES: '1',
    NOVELTEA_CLI_SCHEDULER_PROFILE: '1',
  };
  runNative(['daemon', 'stop'], { env: environment });
  try {
    const cold = requireSuccess(
      'daemon authoring exact pressure cold admission',
      runNative(['--project', root, '--json', 'validate'], { cwd: root, env: environment }),
    );
    const coldProfile = schedulerProfile(cold);
    if (!coldProfile || coldProfile.resident.exactValidationResults < 1)
      fail(
        `Cold validation did not retain an exact result under active-owner protection: ${cold.stderr}`,
      );

    let evicted = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const status = requireSuccess(
        'daemon authoring exact pressure owner status',
        runNative(['--json', 'daemon', 'status'], { env: environment }),
      );
      if (JSON.parse(status.stdout).daemon.projectSessions !== 0) continue;
      const engineering = requireSuccess(
        'daemon authoring exact pressure engineering probe',
        runNative(['--json', 'platform', 'template', 'list'], { env: environment }),
      );
      const profile = schedulerProfile(engineering);
      if (
        profile &&
        profile.resident.exactValidationResults === 0 &&
        profile.resident.projectAuthorities === 0
      ) {
        evicted = true;
        break;
      }
    }
    if (!evicted)
      fail(
        'Dormant exact-validation pressure did not evict its retained result and native authority.',
      );
    process.stdout.write(
      '[daemon-authoring-cache-pressure] dormant exact result and authority eviction: PASS\n',
    );
  } finally {
    runNative(['daemon', 'stop'], { env: environment });
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function certifyEditorAuthoringCacheSharing() {
  requireSuccess(
    'editor authoring-cache sharing integration',
    runPnpm(
      [
        'exec',
        'vp',
        'test',
        'run',
        'src/renderer/test/editor-authoring-validation-service.test.ts',
      ],
      { cwd: editorRoot },
    ),
  );
  process.stdout.write('[editor-authoring-cache] clean sharing and dirty isolation: PASS\n');
}

function elapsedMilliseconds(operation) {
  const started = process.hrtime.bigint();
  const result = operation();
  const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
  return { result, elapsed };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function summarizeBenchmark(values) {
  return {
    medianMs: Math.round(median(values) * 10) / 10,
    p95Ms: Math.round(percentile(values, 95) * 10) / 10,
    minimumMs: Math.round(Math.min(...values) * 10) / 10,
    maximumMs: Math.round(Math.max(...values) * 10) / 10,
  };
}

function validationProfile(result) {
  const line = result.stderr
    .split(/\r?\n/u)
    .find((entry) => entry.startsWith('[validation-profile] '));
  if (!line) return null;
  return JSON.parse(line.slice('[validation-profile] '.length));
}

function schedulerProfile(result) {
  const line = result.stderr
    .split(/\r?\n/u)
    .find((entry) => entry.startsWith('[scheduler-profile] '));
  if (!line) return null;
  return JSON.parse(line.slice('[scheduler-profile] '.length));
}

function workerProfile(result) {
  const line = result.stderr.split(/\r?\n/u).find((entry) => entry.startsWith('[worker-profile] '));
  if (!line) return null;
  return JSON.parse(line.slice('[worker-profile] '.length));
}

function requireIncrementalValidationWork(label, profile) {
  if (!profile?.usefulWork) fail(`${label} did not emit validation useful-work counters.`);
  const work = profile.usefulWork;
  if (work.authoredFilesReread !== 1 || work.jsonSourcesParsed !== 1 || work.textSourcesRead !== 0)
    fail(`${label} reread more than the isolated changed JSON source: ${JSON.stringify(work)}`);
  if (
    work.fullProjectTraversals !== 0 ||
    work.fullProjectProjections !== 0 ||
    work.foregroundSerializations !== 0 ||
    work.foregroundSerializedBytes !== 0
  )
    fail(`${label} performed forbidden whole-Project foreground work: ${JSON.stringify(work)}`);
  return work;
}

function maxUsefulWork(profiles, field) {
  return Math.max(...profiles.map((profile) => profile.usefulWork[field]));
}

async function inflateValidationBenchmark(root, count = 120) {
  const source = JSON.parse(
    await readFile(path.join(root, 'records', 'rooms', 'foyer.json'), 'utf8'),
  );
  for (let index = 0; index < count; index += 1) {
    const id = `validation-benchmark-${String(index).padStart(3, '0')}`;
    await writeJson(path.join(root, 'records', 'rooms', `${id}.json`), {
      ...source,
      id,
      label: `Validation benchmark ${index}`,
    });
  }
}

async function editValidationBenchmarkRecord(root, label) {
  const file = path.join(root, 'records', 'rooms', 'validation-benchmark-000.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.label = label;
  await writeJson(file, record);
}

async function daemonRssBytes(pid) {
  try {
    if (isWindows) {
      const result = run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid}).WorkingSet64`,
      ]);
      if (result.status !== 0) return null;
      const value = Number(result.stdout.trim());
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    }
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

async function rssForProcesses(pids) {
  const entries = [];
  for (const pid of pids) entries.push({ pid, rssBytes: await daemonRssBytes(pid) });
  return {
    processes: entries,
    totalBytes: entries.every((entry) => entry.rssBytes !== null)
      ? entries.reduce((total, entry) => total + entry.rssBytes, 0)
      : null,
  };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function certifyProjectOwnerScheduling(tempRoot, pristine) {
  const runtimeRoot = path.join(tempRoot, 'project-owner-runtime');
  const firstRoot = path.join(tempRoot, 'project-owner-first');
  const secondRoot = path.join(tempRoot, 'project-owner-second');
  const aliasRoot = path.join(tempRoot, 'project-owner-alias');
  await resetCase(pristine, firstRoot);
  await resetCase(pristine, secondRoot);
  const environment = {
    ...process.env,
    NOVELTEA_CLI_CERTIFICATION: '1',
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `project-owner-${process.pid}-${Date.now()}`,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: runtimeRoot,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_IDLE_MS: '60000',
    NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS: '10000',
  };
  const traceEnvironment = { ...environment, NOVELTEA_CLI_TRACE: '1' };
  runNative(['daemon', 'stop'], { env: environment });
  try {
    requireSuccess(
      'Project-owner first Project admission',
      runNative(['--project', firstRoot, '--json', 'asset', 'audit'], {
        cwd: firstRoot,
        env: traceEnvironment,
      }),
    );
    let status = requireSuccess(
      'Project-owner first Project status',
      runNative(['--json', 'daemon', 'status'], { env: environment }),
    );
    const initialDaemon = JSON.parse(status.stdout).daemon;
    if (initialDaemon.projectSessions !== 1)
      fail(`First Project did not establish exactly one owner: ${status.stdout}`);

    if (!isWindows) {
      await rm(aliasRoot, { recursive: true, force: true });
      await symlink(firstRoot, aliasRoot, 'dir');
      requireSuccess(
        'Project-owner physical alias admission',
        runNative(['--project', aliasRoot, '--json', 'asset', 'audit'], {
          cwd: aliasRoot,
          env: traceEnvironment,
        }),
      );
      status = requireSuccess(
        'Project-owner alias status',
        runNative(['--json', 'daemon', 'status'], { env: environment }),
      );
      if (JSON.parse(status.stdout).daemon.projectSessions !== 1)
        fail(`Physical Project alias created a duplicate owner: ${status.stdout}`);
    }

    const [first, second] = await Promise.all([
      runAsync(nativeCli, ['--project', firstRoot, '--json', 'platform', 'profiles'], {
        cwd: firstRoot,
        env: traceEnvironment,
      }).then((invocation) => invocation.result()),
      runAsync(nativeCli, ['--project', secondRoot, '--json', 'platform', 'profiles'], {
        cwd: secondRoot,
        env: traceEnvironment,
      }).then((invocation) => invocation.result()),
    ]);
    requireSuccess('Project-owner concurrent first Project', first);
    requireSuccess('Project-owner concurrent second Project', second);
    status = requireSuccess(
      'Project-owner multi-Project status',
      runNative(['--json', 'daemon', 'status'], { env: environment }),
    );
    if (JSON.parse(status.stdout).daemon.projectSessions !== 2)
      fail(`Two physical Projects did not establish two owners: ${status.stdout}`);

    const processInventoryResult = requireSuccess(
      'Project-owner engineering process inventory',
      runNative(['--project', firstRoot, '--json', 'asset', 'audit'], {
        cwd: firstRoot,
        env: { ...traceEnvironment, NOVELTEA_CLI_SCHEDULER_PROFILE: '1' },
      }),
    );
    const processInventory = schedulerProfile(processInventoryResult);
    if (
      !processInventory ||
      processInventory.resident?.ownerPids?.length !== 2 ||
      processInventory.resident?.owners?.length !== 2 ||
      processInventory.resident?.disposablePids?.length < 1
    )
      fail(`Project-owner process inventory was incomplete: ${processInventoryResult.stderr}`);
    const ownerMemory = await rssForProcesses(processInventory.resident.ownerPids);
    const standbyMemory = await rssForProcesses(processInventory.resident.disposablePids);
    const brokerMemory = await daemonRssBytes(initialDaemon.pid);

    const ownerFor = (profile, root) =>
      profile?.resident?.owners?.find((owner) => owner.canonicalRoot === root) ?? null;
    const firstOwnerBeforeCrash = ownerFor(processInventory, firstRoot);
    const secondOwnerBeforeCrash = ownerFor(processInventory, secondRoot);
    if (!firstOwnerBeforeCrash || !secondOwnerBeforeCrash)
      fail(
        `Project-owner process inventory did not map owners to Projects: ${processInventoryResult.stderr}`,
      );
    const killedOwnerPid = firstOwnerBeforeCrash.pid;
    process.kill(killedOwnerPid, 'SIGKILL');
    for (let attempt = 0; attempt < 100 && processExists(killedOwnerPid); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (processExists(killedOwnerPid))
      fail('Killed Project-owner process did not exit before crash-recovery certification.');
    const crashProfileEnvironment = {
      ...traceEnvironment,
      NOVELTEA_CLI_SCHEDULER_PROFILE: '1',
    };
    const recoveredFirst = requireSuccess(
      'Project-owner crash recovery first Project',
      runNative(['--project', firstRoot, '--json', 'asset', 'audit'], {
        cwd: firstRoot,
        env: crashProfileEnvironment,
      }),
    );
    const recoveredSecond = requireSuccess(
      'Project-owner crash recovery second Project',
      runNative(['--project', secondRoot, '--json', 'asset', 'audit'], {
        cwd: secondRoot,
        env: crashProfileEnvironment,
      }),
    );
    if (
      !recoveredFirst.stderr.includes('[scriptc-host] daemon invocation forwarding') ||
      !recoveredSecond.stderr.includes('[scriptc-host] daemon invocation forwarding')
    )
      fail('Project-owner crash recovery did not remain on daemon routing.');
    const recoveryProfiles = [schedulerProfile(recoveredFirst), schedulerProfile(recoveredSecond)];
    if (!recoveryProfiles.some((profile) => (profile?.workerSpawns?.owner ?? 0) === 1))
      fail('Owner-process death did not produce exactly one replacement owner admission.');
    const recoveredInventory = recoveryProfiles[1];
    const firstOwnerAfterCrash = ownerFor(recoveredInventory, firstRoot);
    const secondOwnerAfterCrash = ownerFor(recoveredInventory, secondRoot);
    if (
      !firstOwnerAfterCrash ||
      !secondOwnerAfterCrash ||
      firstOwnerAfterCrash.pid === firstOwnerBeforeCrash.pid ||
      secondOwnerAfterCrash.pid !== secondOwnerBeforeCrash.pid
    )
      fail(
        `Owner-process crash did not replace only the affected Project owner: ${recoveredSecond.stderr}`,
      );
    const recoveredStatus = requireSuccess(
      'Project-owner crash recovery status',
      runNative(['--json', 'daemon', 'status'], { env: environment }),
    );
    const recoveredDaemon = JSON.parse(recoveredStatus.stdout).daemon;
    if (recoveredDaemon.pid !== initialDaemon.pid || recoveredDaemon.projectSessions !== 2)
      fail(`Owner crash disturbed daemon or sibling owner: ${recoveredStatus.stdout}`);
    const crashRecovery = true;

    requireSuccess(
      'Project-owner scheduler stop before activity certification',
      runNative(['--json', 'daemon', 'stop'], { env: environment }),
    );
    const activityEnvironment = {
      ...environment,
      NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `${environment.NOVELTEA_CLI_CERTIFICATION_DAEMON_ID}-activity`,
      NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS: '700',
    };
    const activityTraceEnvironment = { ...activityEnvironment, NOVELTEA_CLI_TRACE: '1' };
    requireSuccess(
      'Project-owner watcher activity admission',
      runNative(['--project', firstRoot, '--json', 'usages', 'rooms', 'gallery'], {
        cwd: firstRoot,
        env: activityTraceEnvironment,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const beforeHandoff = requireSuccess(
      'Project-owner idle snapshot status',
      runNative(['--project', firstRoot, '--json', 'usages', 'rooms', 'gallery'], {
        cwd: firstRoot,
        env: { ...activityTraceEnvironment, NOVELTEA_CLI_SCHEDULER_PROFILE: '1' },
      }),
    );
    if (schedulerProfile(beforeHandoff)?.resident?.snapshots !== 0)
      fail('Short owner work triggered unsolicited whole-Project snapshot serialization.');
    requireSuccess(
      'Project-owner on-demand snapshot preparation',
      runNative(
        [
          '--project',
          firstRoot,
          '--json',
          'package',
          'export',
          '--output',
          path.join(tempRoot, 'owner-rehydration.ntpkg'),
          '--allow-localization-warnings',
        ],
        {
          cwd: firstRoot,
          env: activityTraceEnvironment,
        },
      ),
    );
    requireSuccess(
      'Project-owner activity after snapshot handoff',
      runNative(['--project', firstRoot, '--json', 'usages', 'rooms', 'gallery'], {
        cwd: firstRoot,
        env: activityTraceEnvironment,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    const foyerPath = path.join(firstRoot, 'records', 'rooms', 'foyer.json');
    const foyer = JSON.parse(await readFile(foyerPath, 'utf8'));
    foyer.label = `${foyer.label} watcher activity`;
    await writeJson(foyerPath, foyer);
    await new Promise((resolve) => setTimeout(resolve, 400));
    let activityStatus = requireSuccess(
      'Project-owner watcher activity status',
      runNative(['--json', 'daemon', 'status'], { env: activityEnvironment }),
    );
    if (JSON.parse(activityStatus.stdout).daemon.projectSessions !== 1)
      fail(
        `Meaningful watcher reconciliation did not refresh owner activity: ${activityStatus.stdout}`,
      );

    await writeFile(
      path.join(firstRoot, 'scripts', 'watcher-noise.txt'),
      'ignored watcher noise\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 850));
    activityStatus = requireSuccess(
      'Project-owner watcher-noise eviction status',
      runNative(['--json', 'daemon', 'status'], { env: activityEnvironment }),
    );
    if (JSON.parse(activityStatus.stdout).daemon.projectSessions !== 0)
      fail(`Watcher noise kept an idle Project owner alive: ${activityStatus.stdout}`);
    const rehydrated = requireSuccess(
      'Project-owner retained snapshot rehydration',
      runNative(['--project', firstRoot, '--json', 'usages', 'rooms', 'gallery'], {
        cwd: firstRoot,
        env: { ...activityTraceEnvironment, NOVELTEA_CLI_SCHEDULER_PROFILE: '1' },
      }),
    );
    const rehydrationProfile = schedulerProfile(rehydrated);
    if (!rehydrationProfile?.ownerRehydration || rehydrationProfile.ownerColdAdmission)
      fail(`Idle owner did not rehydrate its retained RAM snapshot: ${rehydrated.stderr}`);
    requireSuccess(
      'Project-owner activity daemon stop',
      runNative(['--json', 'daemon', 'stop'], { env: activityEnvironment }),
    );

    const coldFallbackEnvironment = {
      ...environment,
      NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `${environment.NOVELTEA_CLI_CERTIFICATION_DAEMON_ID}-cold-fallback`,
      NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS: '400',
      NOVELTEA_CLI_CERTIFICATION_PROJECT_SNAPSHOT_BUDGET_BYTES: '1',
    };
    const coldFallbackTraceEnvironment = {
      ...coldFallbackEnvironment,
      NOVELTEA_CLI_TRACE: '1',
    };
    requireSuccess(
      'Project-owner cold-fallback snapshot preparation',
      runNative(
        [
          '--project',
          firstRoot,
          '--json',
          'package',
          'export',
          '--output',
          path.join(tempRoot, 'owner-cold-fallback.ntpkg'),
          '--allow-localization-warnings',
        ],
        { cwd: firstRoot, env: coldFallbackTraceEnvironment },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    const coldFallbackStatus = requireSuccess(
      'Project-owner cold-fallback pressure status',
      runNative(['--json', 'daemon', 'status'], { env: coldFallbackEnvironment }),
    );
    const coldFallbackDaemon = JSON.parse(coldFallbackStatus.stdout).daemon;
    if (coldFallbackDaemon.projectSessions !== 0)
      fail(
        `Dormant snapshot pressure did not evict the Project owner: ${coldFallbackStatus.stdout}`,
      );
    const coldFallback = requireSuccess(
      'Project-owner true cold fallback after snapshot pressure',
      runNative(['--project', firstRoot, '--json', 'usages', 'rooms', 'gallery'], {
        cwd: firstRoot,
        env: { ...coldFallbackTraceEnvironment, NOVELTEA_CLI_SCHEDULER_PROFILE: '1' },
      }),
    );
    const coldFallbackProfile = schedulerProfile(coldFallback);
    if (!coldFallbackProfile?.ownerColdAdmission || coldFallbackProfile.ownerRehydration)
      fail(`Snapshot pressure did not force a true cold owner admission: ${coldFallback.stderr}`);
    requireSuccess(
      'Project-owner cold-fallback daemon stop',
      runNative(['--json', 'daemon', 'stop'], { env: coldFallbackEnvironment }),
    );

    const pressureEnvironment = {
      ...environment,
      NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `${environment.NOVELTEA_CLI_CERTIFICATION_DAEMON_ID}-pressure`,
      NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS: '60000',
    };
    const pressureTraceEnvironment = { ...pressureEnvironment, NOVELTEA_CLI_TRACE: '1' };
    for (let index = 0; index < 9; index += 1) {
      const pressureRoot = path.join(tempRoot, `project-owner-pressure-${index}`);
      await resetCase(pristine, pressureRoot);
      requireSuccess(
        `Project-owner pressure admission ${index + 1}`,
        runNative(['--project', pressureRoot, '--json', 'asset', 'audit'], {
          cwd: pressureRoot,
          env: pressureTraceEnvironment,
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    const pressureStatus = requireSuccess(
      'Project-owner pressure status',
      runNative(['--json', 'daemon', 'status'], { env: pressureEnvironment }),
    );
    const pressureDaemon = JSON.parse(pressureStatus.stdout).daemon;
    if (
      pressureDaemon.projectSessions + pressureDaemon.disposableWorkers > 8 ||
      pressureDaemon.projectSessions !== 7
    )
      fail(
        `Project-owner memory pressure did not preserve the daemon-wide worker budget: ${pressureStatus.stdout}`,
      );
    requireSuccess(
      'Project-owner pressure daemon stop',
      runNative(['--json', 'daemon', 'stop'], { env: pressureEnvironment }),
    );

    return {
      canonicalAliasDeduplication: !isWindows,
      distinctProjectOwners: true,
      ownerCrashRecovery: crashRecovery,
      dormantSnapshotRehydration: true,
      coldFallbackAfterSnapshotPressure: true,
      activityAwareEviction: true,
      pressureEviction: true,
      memory: {
        brokerRssBytes: brokerMemory,
        ownerRss: ownerMemory,
        standbyRss: standbyMemory,
        retainedSnapshotBytes: processInventory.resident.snapshotBytes,
      },
    };
  } finally {
    runNative(['daemon', 'stop'], { env: environment });
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(aliasRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function certifyDaemonBuildProtocolIsolation(tempRoot) {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'nt-daemon-isolation-'));
  const common = {
    ...process.env,
    NOVELTEA_CLI_CERTIFICATION: '1',
    NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: runtimeRoot,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_IDLE_MS: '10000',
    NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS: '10000',
    NOVELTEA_CLI_TRACE: '1',
  };
  const buildA = {
    ...common,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `isolation-a-${process.pid}`,
  };
  const buildB = {
    ...common,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `isolation-b-${process.pid}`,
  };
  const protocolB = {
    ...buildA,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_PROTOCOL: '2',
  };
  const environments = [buildA, buildB, protocolB];
  try {
    for (const environment of environments) runNative(['daemon', 'stop'], { env: environment });
    for (const [label, environment] of [
      ['build A', buildA],
      ['build B', buildB],
      ['protocol B', protocolB],
    ]) {
      const started = requireSuccess(
        `daemon isolation ${label}`,
        runNative(['--json', 'comfyui', 'workflows'], { cwd: tempRoot, env: environment }),
      );
      if (!started.stderr.includes('[scriptc-host] daemon invocation forwarding'))
        fail(`Daemon isolation ${label} did not route through its resident daemon.`);
    }
    const statusFor = (label, environment) => {
      const status = requireSuccess(
        `daemon isolation ${label} status`,
        runNative(['--json', 'daemon', 'status'], { env: environment }),
      );
      const daemon = JSON.parse(status.stdout).daemon;
      if (daemon.running !== true || daemon.state !== 'ready' || !Number.isSafeInteger(daemon.pid))
        fail(`Daemon isolation ${label} did not report a ready daemon: ${status.stdout}`);
      return daemon;
    };
    const a = statusFor('build A', buildA);
    const b = statusFor('build B', buildB);
    const p = statusFor('protocol B', protocolB);
    if (new Set([a.pid, b.pid, p.pid]).size !== 3)
      fail('Distinct daemon build/protocol identities did not coexist in separate processes.');
    if (a.build === b.build || a.protocol !== 1 || p.protocol !== 2 || a.build !== p.build)
      fail('Daemon build/protocol isolation identities were not established as intended.');

    requireSuccess('daemon isolation stop build B', runNative(['daemon', 'stop'], { env: buildB }));
    const aAfterBuildStop = statusFor('build A after build B stop', buildA);
    const pAfterBuildStop = statusFor('protocol B after build B stop', protocolB);
    if (aAfterBuildStop.pid !== a.pid || pAfterBuildStop.pid !== p.pid)
      fail('Stopping one build identity disturbed another compatible daemon endpoint.');

    requireSuccess(
      'daemon isolation stop protocol B',
      runNative(['daemon', 'stop'], { env: protocolB }),
    );
    const aAfterProtocolStop = statusFor('build A after protocol B stop', buildA);
    if (aAfterProtocolStop.pid !== a.pid)
      fail('Stopping one protocol identity disturbed the canonical protocol daemon.');
    return true;
  } finally {
    for (const environment of environments) runNative(['daemon', 'stop'], { env: environment });
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function certifyDisposableTestScheduling(tempRoot) {
  const source = path.join(repositoryRoot, 'tests', 'projects', 'feature-lab');
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'nt-disposable-'));
  const environment = {
    ...process.env,
    NOVELTEA_CLI_CERTIFICATION: '1',
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `disposable-test-${process.pid}-${Date.now()}`,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: runtimeRoot,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_IDLE_MS: '60000',
    NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS: '60000',
    NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_IDLE_MS: '250',
  };
  const traceEnvironment = { ...environment, NOVELTEA_CLI_TRACE: '1' };
  const resetFeatureLab = async (name) => {
    const root = path.join(tempRoot, name);
    await rm(root, { recursive: true, force: true });
    await cp(source, root, { recursive: true });
    await rm(path.join(root, '.noveltea', 'cache'), { recursive: true, force: true });
    return root;
  };
  const status = () => {
    const result = requireSuccess(
      'disposable Test scheduler status',
      runNative(['--json', 'daemon', 'status'], { env: environment }),
    );
    return JSON.parse(result.stdout).daemon;
  };
  const waitForStatus = async (label, predicate, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = status();
      if (predicate(latest)) return latest;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    fail(`${label} timed out; last daemon status: ${JSON.stringify(latest)}`);
  };

  runNative(['daemon', 'stop'], { env: environment });
  try {
    const generationRoot = await resetFeatureLab('disposable-test-generation');
    requireSuccess(
      'Disposable Test pinned-cache baseline',
      runNative(['--project', generationRoot, '--json', 'test', 'run', 'rooms-interactions-flow'], {
        cwd: generationRoot,
        env: traceEnvironment,
      }),
    );
    await rm(path.join(generationRoot, '.noveltea', 'cache', 'runtime'), {
      recursive: true,
      force: true,
    });
    const longEnvironment = {
      ...traceEnvironment,
      NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_DELAY_MS: '5000',
      NOVELTEA_CLI_SCHEDULER_PROFILE: '1',
    };
    const longTest = await runAsync(
      nativeCli,
      ['--project', generationRoot, '--json', 'test', 'run', 'rooms-interactions-flow'],
      { cwd: generationRoot, env: longEnvironment },
    );
    const activeStatus = await waitForStatus(
      'Disposable Test warm-standby certification',
      (daemon) => daemon.disposableBusyWorkers >= 1 && daemon.disposableStandbyWorkers >= 1,
    );
    const daemonPid = activeStatus.pid;
    const bootstrapPath = path.join(generationRoot, 'scripts', 'feature-lab-bootstrap.lua');
    await writeFile(
      bootstrapPath,
      'error("generation-two")\nreturn { route_startup = function() end }\n',
    );
    const newerTarget = runNative(
      ['--project', generationRoot, '--json', 'test', 'run', 'rooms-interactions-flow'],
      { cwd: generationRoot, env: traceEnvironment },
    );
    if (
      newerTarget.status === 0 ||
      !`${newerTarget.stdout}${newerTarget.stderr}`.includes('generation-two')
    )
      fail('Newer disposable Test generation did not establish observably different semantics.');
    const runtimeCurrentPath = path.join(
      generationRoot,
      '.noveltea',
      'cache',
      'runtime',
      'current',
    );
    const newerGeneration = (await readFile(runtimeCurrentPath, 'utf8')).trim();
    if (!newerGeneration)
      fail('Newer disposable Test generation did not publish a runtime cache generation.');
    const longResult = await longTest.result();
    requireSuccess('Disposable Test generation-pinned execution', longResult);
    if (JSON.parse(longResult.stdout).native?.report?.passed !== true)
      fail('Pinned disposable Test did not preserve generation-N runtime semantics.');
    const generationAfterPinnedCompletion = (await readFile(runtimeCurrentPath, 'utf8')).trim();
    if (generationAfterPinnedCompletion !== newerGeneration)
      fail(
        `Pinned Test generation replaced the newer runtime cache generation: ` +
          `${newerGeneration} -> ${generationAfterPinnedCompletion}`,
      );

    const malformedRoot = await resetFeatureLab('disposable-test-malformed-latest');
    requireSuccess(
      'Disposable Test malformed-latest retained baseline',
      runNative(['--project', malformedRoot, '--json', 'test', 'run', 'rooms-interactions-flow'], {
        cwd: malformedRoot,
        env: environment,
      }),
    );
    const malformedRoom = path.join(malformedRoot, 'records', 'rooms', 'feature-lab-home.json');
    await writeFile(malformedRoom, '{ malformed current generation');
    const retainedFailure = runNative(
      ['--project', malformedRoot, '--json', 'test', 'run', 'rooms-interactions-flow'],
      { cwd: malformedRoot, env: environment },
    );
    const localFailure = runNative(
      ['--project', malformedRoot, '--json', 'test', 'run', 'rooms-interactions-flow'],
      {
        cwd: malformedRoot,
        env: { ...environment, NOVELTEA_NO_DAEMON: '1' },
      },
    );
    if (
      retainedFailure.status === 0 ||
      retainedFailure.status !== localFailure.status ||
      retainedFailure.stdout !== localFailure.stdout
    )
      fail(
        `Malformed newest Project generation did not preserve the original heavy-command failure semantics.\n` +
          `daemon=${retainedFailure.status}: ${retainedFailure.stdout}\n` +
          `local=${localFailure.status}: ${localFailure.stdout}`,
      );
    if (
      `${retainedFailure.stdout}${retainedFailure.stderr}`.includes(
        'Project owner did not publish the requested portable snapshot',
      )
    )
      fail(
        'Malformed newest Project generation collapsed into a generic snapshot-preparation error.',
      );
    if (!longResult.stderr.includes('[scriptc-host] daemon invocation forwarding'))
      fail('Generation-pinned Test did not exercise the resident daemon route.');
    const longSchedulerProfile = schedulerProfile(longResult);
    const longWorkerProfile = workerProfile(longResult);
    if (
      !longSchedulerProfile?.snapshotHandoff ||
      longSchedulerProfile.queuedDisposableJobs < 1 ||
      longWorkerProfile?.workerKind !== 'disposable' ||
      longWorkerProfile.hasProjectSnapshot !== true ||
      longWorkerProfile.snapshotBytes <= 0 ||
      longWorkerProfile.snapshotReadMs < 0
    )
      fail(`Disposable Test did not expose snapshot/worker diagnostics: ${longResult.stderr}`);
    await waitForStatus(
      'Disposable Test standby replenishment',
      (daemon) => daemon.disposableBusyWorkers === 0 && daemon.disposableStandbyWorkers >= 1,
    );

    const queueRoot = await resetFeatureLab('disposable-test-cap');
    const cappedEnvironment = {
      ...traceEnvironment,
      NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_DELAY_MS: '2000',
    };
    const queuedRuns = [];
    for (let index = 0; index < 9; index += 1) {
      queuedRuns.push(
        await runAsync(
          nativeCli,
          ['--project', queueRoot, '--json', 'test', 'run', 'rooms-interactions-flow'],
          { cwd: queueRoot, env: cappedEnvironment },
        ),
      );
    }
    await waitForStatus(
      'Disposable Test worker-cap queue certification',
      (daemon) =>
        daemon.projectSessions + daemon.disposableWorkers === 8 &&
        daemon.disposableBusyWorkers >= 1 &&
        daemon.disposableQueuedJobs >= 1,
      8000,
    );
    for (let index = 0; index < queuedRuns.length; index += 1)
      requireSuccess(`Disposable Test capped run ${index + 1}`, await queuedRuns[index].result());
    await waitForStatus(
      'Disposable Test post-cap standby replenishment',
      (daemon) => daemon.disposableBusyWorkers === 0 && daemon.disposableStandbyWorkers >= 1,
    );
    await waitForStatus(
      'Disposable Test excess-idle retirement',
      (daemon) =>
        daemon.disposableWorkers === 1 &&
        daemon.disposableBusyWorkers === 0 &&
        daemon.disposableStandbyWorkers === 1,
      5000,
    );

    const cancellationRoot = await resetFeatureLab('disposable-test-cancellation');
    const cancellationEnvironment = {
      ...traceEnvironment,
      NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_DELAY_MS: '5000',
    };
    const cancellationArgs = [
      '--project',
      cancellationRoot,
      '--json',
      'test',
      'run',
      'rooms-interactions-flow',
    ];
    const cancellation = isWindows
      ? await runWindowsConsoleProcess(nativeCli, cancellationArgs, {
          cwd: cancellationRoot,
          env: cancellationEnvironment,
        })
      : {
          invocation: await runAsync(nativeCli, cancellationArgs, {
            cwd: cancellationRoot,
            env: cancellationEnvironment,
          }),
          pid: null,
        };
    await waitForStatus(
      'Disposable Test cancellation admission',
      (daemon) => daemon.disposableBusyWorkers >= 1,
    );
    if (isWindows) sendWindowsConsoleCtrlC(cancellation.pid);
    else cancellation.invocation.child.kill('SIGINT');
    const cancellationResult = await cancellation.invocation.result();
    if (cancellationResult.status !== 130)
      fail(
        `Disposable Test cancellation exited ${cancellationResult.status}, expected 130.\n` +
          `${cancellationResult.stdout}\n${cancellationResult.stderr}`,
      );
    await waitForStatus(
      'Disposable Test cancellation standby replenishment',
      (daemon) => daemon.disposableBusyWorkers === 0 && daemon.disposableStandbyWorkers >= 1,
    );

    const snapshotlessCrash = runNative(['--json', 'platform', 'template', 'list'], {
      timeout: 15000,
      env: { ...traceEnvironment, NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_CRASH: '1' },
    });
    if (
      snapshotlessCrash.status === 0 ||
      !`${snapshotlessCrash.stdout}${snapshotlessCrash.stderr}`.includes(
        'daemon disposable worker exited unexpectedly',
      )
    )
      fail(
        `Snapshotless disposable crash did not promptly report the failed job: ` +
          `status=${snapshotlessCrash.status}.\nstdout:\n${snapshotlessCrash.stdout}\nstderr:\n${snapshotlessCrash.stderr}`,
      );
    await waitForStatus(
      'Snapshotless disposable crash standby replenishment',
      (daemon) => daemon.disposableBusyWorkers === 0 && daemon.disposableStandbyWorkers >= 1,
    );

    const crashRoot = await resetFeatureLab('disposable-test-crash');
    const crashOwnerAdmission = requireSuccess(
      'Disposable Test crash owner baseline',
      runNative(['--project', crashRoot, '--json', 'validate'], {
        cwd: crashRoot,
        env: { ...traceEnvironment, NOVELTEA_CLI_SCHEDULER_PROFILE: '1' },
      }),
    );
    const crashOwnerProfile = schedulerProfile(crashOwnerAdmission);
    const crashOwnerBefore = crashOwnerProfile?.resident?.owners?.find(
      (owner) => owner.canonicalRoot === crashRoot,
    );
    if (!crashOwnerBefore)
      fail(
        `Disposable Test crash baseline did not expose its Project owner: ${crashOwnerAdmission.stderr}`,
      );
    const crashResult = runNative(
      ['--project', crashRoot, '--json', 'test', 'run', 'rooms-interactions-flow'],
      {
        cwd: crashRoot,
        env: {
          ...traceEnvironment,
          NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_CRASH: '1',
        },
      },
    );
    if (crashResult.status === 0)
      fail('Disposable Test worker crash unexpectedly reported success.');
    const recovered = await waitForStatus(
      'Disposable Test crash standby replenishment',
      (daemon) => daemon.disposableBusyWorkers === 0 && daemon.disposableStandbyWorkers >= 1,
    );
    if (recovered.pid !== daemonPid)
      fail('Disposable Test worker crash replaced or terminated the daemon broker.');
    const ownerAfterDisposableCrash = requireSuccess(
      'Disposable Test crash isolation owner read',
      runNative(['--project', crashRoot, '--json', 'usages', 'rooms', 'feature-lab-home'], {
        cwd: crashRoot,
        env: { ...traceEnvironment, NOVELTEA_CLI_SCHEDULER_PROFILE: '1' },
      }),
    );
    const ownerAfterDisposableCrashProfile = schedulerProfile(ownerAfterDisposableCrash);
    const crashOwnerAfter = ownerAfterDisposableCrashProfile?.resident?.owners?.find(
      (owner) => owner.canonicalRoot === crashRoot,
    );
    if (
      !crashOwnerAfter ||
      crashOwnerAfter.pid !== crashOwnerBefore.pid ||
      (ownerAfterDisposableCrashProfile?.workerSpawns?.owner ?? 0) !== 0
    )
      fail(
        `Disposable worker crash replaced or disturbed the live Project owner: ${ownerAfterDisposableCrash.stderr}`,
      );

    return {
      generationPinned: true,
      foregroundPriority: true,
      warmStandby: true,
      cappedQueue: true,
      idleExcessRetirement: true,
      cancellationIsolation: true,
      crashIsolation: true,
      diagnostics: {
        scheduler: longSchedulerProfile,
        worker: longWorkerProfile,
      },
    };
  } finally {
    runNative(['daemon', 'stop'], { env: environment });
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function certifyDisposableOutputScheduling(tempRoot) {
  const source = path.join(repositoryRoot, 'tests', 'projects', 'feature-lab');
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'nt-output-disposable-'));
  const environment = {
    ...process.env,
    NOVELTEA_CLI_CERTIFICATION: '1',
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `disposable-output-${process.pid}-${Date.now()}`,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: runtimeRoot,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_IDLE_MS: '60000',
    NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS: '60000',
  };
  const traceEnvironment = { ...environment, NOVELTEA_CLI_TRACE: '1' };
  const resetFeatureLab = async (name) => {
    const root = path.join(tempRoot, name);
    await rm(root, { recursive: true, force: true });
    await cp(source, root, { recursive: true });
    await rm(path.join(root, '.noveltea', 'cache'), { recursive: true, force: true });
    return root;
  };
  const status = () => {
    const result = requireSuccess(
      'disposable output scheduler status',
      runNative(['--json', 'daemon', 'status'], { env: environment }),
    );
    return JSON.parse(result.stdout).daemon;
  };
  const waitForStatus = async (label, predicate, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = status();
      if (predicate(latest)) return latest;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    fail(`${label} timed out; last daemon status: ${JSON.stringify(latest)}`);
  };
  const packageArguments = (root, output) => [
    '--project',
    root,
    '--json',
    'package',
    'export',
    '--output',
    output,
    '--allow-localization-warnings',
  ];

  runNative(['daemon', 'stop'], { env: environment });
  try {
    const portableRoot = await resetFeatureLab('disposable-portable-project-export');
    const portableOutput = path.join(tempRoot, 'disposable-portable-project.ntproject');
    await rm(portableOutput, { force: true });
    const portableEnvironment = {
      ...traceEnvironment,
      NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_DELAY_MS: '1500',
      NOVELTEA_CLI_SCHEDULER_PROFILE: '1',
    };
    const portableExport = await runAsync(
      nativeCli,
      ['--project', portableRoot, '--json', 'project', 'export', '--output', portableOutput],
      { cwd: portableRoot, env: portableEnvironment },
    );
    await waitForStatus(
      'Portable Project export disposable admission',
      (daemon) => daemon.disposableBusyWorkers >= 1,
    );
    requireSuccess(
      'Portable Project export concurrent foreground validation',
      runNative(['--project', portableRoot, '--json', 'validate'], {
        cwd: portableRoot,
        env: traceEnvironment,
      }),
    );
    const portableResult = requireSuccess(
      'Portable Project export disposable completion',
      await portableExport.result(),
    );
    const portableSchedulerProfile = schedulerProfile(portableResult);
    const portableWorkerProfile = workerProfile(portableResult);
    if (
      !portableSchedulerProfile?.snapshotHandoff ||
      portableWorkerProfile?.workerKind !== 'disposable' ||
      portableWorkerProfile.hasProjectSnapshot !== true
    )
      fail(
        `Portable Project export did not use a pinned disposable generation: ${portableResult.stderr}`,
      );
    if (!(await stat(portableOutput).catch(() => null)))
      fail('Disposable Portable Project export did not publish its bundle.');

    const portableDriftRoot = await resetFeatureLab('disposable-portable-project-drift');
    const portableDriftOutput = path.join(tempRoot, 'disposable-portable-project-drift.ntproject');
    await rm(portableDriftOutput, { force: true });
    const portableDrift = await runAsync(
      nativeCli,
      [
        '--project',
        portableDriftRoot,
        '--json',
        'project',
        'export',
        '--output',
        portableDriftOutput,
      ],
      { cwd: portableDriftRoot, env: portableEnvironment },
    );
    await waitForStatus(
      'Portable Project export drift admission',
      (daemon) => daemon.disposableBusyWorkers >= 1,
    );
    const driftRoomPath = path.join(portableDriftRoot, 'records', 'rooms', 'feature-lab-home.json');
    const driftRoom = JSON.parse(await readFile(driftRoomPath, 'utf8'));
    driftRoom.label = `${driftRoom.label} portable drift`;
    await writeJson(driftRoomPath, driftRoom);
    requireSuccess(
      'Portable Project drift concurrent foreground validation',
      runNative(['--project', portableDriftRoot, '--json', 'validate'], {
        cwd: portableDriftRoot,
        env: traceEnvironment,
      }),
    );
    const portableDriftResult = await portableDrift.result();
    if (
      portableDriftResult.status === 0 ||
      !`${portableDriftResult.stdout}${portableDriftResult.stderr}`.includes(
        'changed while preparing the bundle',
      )
    )
      fail(
        `Disposable Portable Project export did not preserve source-change authority: ${portableDriftResult.stdout}${portableDriftResult.stderr}`,
      );
    if (await stat(portableDriftOutput).catch(() => null))
      fail('Disposable Portable Project export published after source drift.');

    const shaderRoot = await resetFeatureLab('disposable-shader-compile');
    const shaderCompile = await runAsync(
      nativeCli,
      ['--project', shaderRoot, '--json', 'shaders', 'compile', '--force-rebuild'],
      { cwd: shaderRoot, env: portableEnvironment },
    );
    await waitForStatus(
      'Shader compile disposable admission',
      (daemon) => daemon.disposableBusyWorkers >= 1,
    );
    requireSuccess(
      'Shader compile concurrent foreground validation',
      runNative(['--project', shaderRoot, '--json', 'validate'], {
        cwd: shaderRoot,
        env: traceEnvironment,
      }),
    );
    const shaderResult = requireSuccess(
      'Shader compile disposable completion',
      await shaderCompile.result(),
    );
    const shaderSchedulerProfile = schedulerProfile(shaderResult);
    const shaderWorkerProfile = workerProfile(shaderResult);
    if (
      !shaderSchedulerProfile?.snapshotHandoff ||
      shaderWorkerProfile?.workerKind !== 'disposable' ||
      shaderWorkerProfile.hasProjectSnapshot !== true
    )
      fail(`Shader compile did not use a pinned disposable generation: ${shaderResult.stderr}`);

    const generationRoot = await resetFeatureLab('disposable-output-generation');
    const layoutRecordPath = path.join(
      generationRoot,
      'records',
      'layouts',
      'feature-lab-hud',
      'layout.json',
    );
    const layoutRecord = JSON.parse(await readFile(layoutRecordPath, 'utf8'));
    layoutRecord.data.dependencies.scripts.push('scripts/disposable-layout-helper.lua');
    await writeJson(layoutRecordPath, layoutRecord);
    const layoutHelperPath = path.join(generationRoot, 'scripts', 'disposable-layout-helper.lua');
    await writeFile(layoutHelperPath, 'return { generation = "one" }\n');
    const generationBaselineOutput = path.join(tempRoot, 'disposable-generation-baseline.ntpkg');
    const generationOutput = path.join(tempRoot, 'disposable-generation.ntpkg');
    await rm(generationBaselineOutput, { force: true });
    await rm(generationOutput, { force: true });
    requireSuccess(
      'Disposable output generation baseline',
      runNative(packageArguments(generationRoot, generationBaselineOutput), {
        cwd: generationRoot,
        env: traceEnvironment,
      }),
    );
    const generationBaselineBytes = await readFile(generationBaselineOutput);
    const delayedEnvironment = {
      ...traceEnvironment,
      NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_DELAY_MS: '1500',
    };
    const generationExport = await runAsync(
      nativeCli,
      packageArguments(generationRoot, generationOutput),
      { cwd: generationRoot, env: delayedEnvironment },
    );
    await waitForStatus(
      'Disposable output concurrent-owner admission',
      (daemon) => daemon.disposableBusyWorkers >= 1 && daemon.disposableStandbyWorkers >= 1,
    );
    const roomPath = path.join(generationRoot, 'records', 'rooms', 'feature-lab-home.json');
    const room = JSON.parse(await readFile(roomPath, 'utf8'));
    room.label = `${room.label} output generation advance`;
    await writeJson(roomPath, room);
    const bootstrapPath = path.join(generationRoot, 'scripts', 'feature-lab-bootstrap.lua');
    await writeFile(
      bootstrapPath,
      `${await readFile(bootstrapPath, 'utf8')}\n-- disposable generation two\n`,
    );
    await writeFile(layoutHelperPath, 'return { generation = "two" }\n');
    const addedRoomPath = path.join(
      generationRoot,
      'records',
      'rooms',
      'disposable-generation-live-only.json',
    );
    await writeJson(addedRoomPath, {
      ...room,
      id: 'disposable-generation-live-only',
      label: 'Disposable Generation Live Only',
    });
    requireSuccess(
      'Disposable output concurrent foreground validation',
      runNative(['--project', generationRoot, '--json', 'validate'], {
        cwd: generationRoot,
        env: traceEnvironment,
      }),
    );
    requireSuccess(
      'Disposable output generation-pinned package export',
      await generationExport.result(),
    );
    if (!(await stat(generationOutput).catch(() => null)))
      fail('Generation-pinned disposable package export did not publish its final output.');
    const generationBytes = await readFile(generationOutput);
    if (!generationBytes.equals(generationBaselineBytes))
      fail(
        'Generation-pinned disposable package export observed the newer live Project generation.',
      );

    const driftRoot = await resetFeatureLab('disposable-output-drift');
    const driftOutput = path.join(tempRoot, 'disposable-drift.ntpkg');
    await rm(driftOutput, { force: true });
    const driftExport = await runAsync(nativeCli, packageArguments(driftRoot, driftOutput), {
      cwd: driftRoot,
      env: delayedEnvironment,
    });
    await waitForStatus(
      'Disposable output Asset-drift admission',
      (daemon) => daemon.disposableBusyWorkers >= 1,
    );
    const assetPath = path.join(driftRoot, 'assets', 'images', 'bedroom.webp');
    const assetStat = await stat(assetPath);
    const changedTime = new Date(assetStat.mtimeMs + 2000);
    await utimes(assetPath, changedTime, changedTime);
    const driftResult = await driftExport.result();
    if (driftResult.status === 0)
      fail('Disposable package export published successfully after pinned Asset drift.');
    if (await stat(driftOutput).catch(() => null))
      fail('Disposable package export published a final output after pinned Asset drift.');

    const cancellationRoot = await resetFeatureLab('disposable-output-cancellation');
    const cancellationOutput = path.join(tempRoot, 'disposable-cancellation.ntpkg');
    await rm(cancellationOutput, { force: true });
    const stagedOutputs = async (output) =>
      (await readdir(path.dirname(output))).filter((name) =>
        name.startsWith(`${path.basename(output)}.tmp-`),
      );
    const publicationDebris = async (output) => {
      const parent = path.dirname(output);
      const basename = path.basename(output);
      return (await readdir(parent)).filter(
        (name) =>
          name.startsWith(`${basename}.tmp-`) ||
          name === `${basename}.noveltea-publication-backup` ||
          name === `${basename}.noveltea-publication-transaction.json`,
      );
    };
    const cancellationEnvironment = {
      ...traceEnvironment,
      NOVELTEA_CLI_CERTIFICATION_STAGED_OUTPUT_DELAY_MS: '10000',
    };
    const cancellationArgs = packageArguments(cancellationRoot, cancellationOutput);
    const cancellation = isWindows
      ? await runWindowsConsoleProcess(nativeCli, cancellationArgs, {
          cwd: cancellationRoot,
          env: cancellationEnvironment,
        })
      : {
          invocation: await runAsync(nativeCli, cancellationArgs, {
            cwd: cancellationRoot,
            env: cancellationEnvironment,
          }),
          pid: null,
        };
    const stagedDeadline = Date.now() + 30000;
    while ((await stagedOutputs(cancellationOutput)).length === 0) {
      if (Date.now() >= stagedDeadline)
        fail('Disposable cancellation never created a staged package.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (isWindows) sendWindowsConsoleCtrlC(cancellation.pid);
    else cancellation.invocation.child.kill('SIGINT');
    const cancellationResult = await cancellation.invocation.result();
    if (cancellationResult.status !== 130)
      fail(
        `Disposable output cancellation exited ${cancellationResult.status}, expected 130.\n` +
          `${cancellationResult.stdout}\n${cancellationResult.stderr}`,
      );
    await waitForStatus(
      'Disposable output cancellation cleanup',
      (daemon) => daemon.disposableBusyWorkers === 0 && daemon.disposableStandbyWorkers >= 1,
    );
    if (await stat(cancellationOutput).catch(() => null))
      fail('Cancelled disposable package export published a final output.');
    const cleanupDeadline = Date.now() + 5000;
    while ((await stagedOutputs(cancellationOutput)).length !== 0) {
      if (Date.now() >= cleanupDeadline)
        fail('Cancelled disposable package export leaked staging files.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const crashRoot = await resetFeatureLab('disposable-output-crash');
    const crashOutput = path.join(tempRoot, 'disposable-crash.ntpkg');
    await rm(crashOutput, { force: true });
    requireSuccess(
      'Disposable output crash previous publication',
      runNative(packageArguments(crashRoot, crashOutput), {
        cwd: crashRoot,
        env: traceEnvironment,
      }),
    );
    const crashPreviousBytes = await readFile(crashOutput);
    const crashResult = runNative(packageArguments(crashRoot, crashOutput), {
      cwd: crashRoot,
      env: {
        ...traceEnvironment,
        NOVELTEA_CLI_CERTIFICATION_STAGED_OUTPUT_CRASH: '1',
      },
    });
    if (crashResult.status === 0)
      fail('Disposable package worker crash unexpectedly reported success.');
    const crashRecoveredBytes = await readFile(crashOutput).catch(() => null);
    if (!crashRecoveredBytes?.equals(crashPreviousBytes))
      fail('Crashed disposable package export did not preserve the previous complete output.');
    await waitForStatus(
      'Disposable output crash standby replenishment',
      (daemon) => daemon.disposableBusyWorkers === 0 && daemon.disposableStandbyWorkers >= 1,
    );
    if ((await publicationDebris(crashOutput)).length !== 0)
      fail('Crashed disposable package export leaked staging/recovery state.');
    requireSuccess(
      'Disposable output crash isolation owner validation',
      runNative(['--project', crashRoot, '--json', 'validate'], {
        cwd: crashRoot,
        env: traceEnvironment,
      }),
    );
    requireSuccess(
      'Disposable output post-crash recovery publication',
      runNative(packageArguments(crashRoot, crashOutput), {
        cwd: crashRoot,
        env: traceEnvironment,
      }),
    );
    if ((await publicationDebris(crashOutput)).length !== 0)
      fail('Post-crash disposable package export left recovery debris.');

    return {
      portableProjectExportPinned: true,
      portableProjectExportAuthority: true,
      shaderCompilePinned: true,
      foregroundOwnerResponsive: true,
      generationPinned: true,
      foregroundOwnerProgress: true,
      assetDriftBlocksPublication: true,
      cancellationBlocksPublication: true,
      crashBlocksPublication: true,
      crashPreservesPreviousPublication: true,
      postCrashPublicationRecovers: true,
    };
  } finally {
    runNative(['daemon', 'stop'], { env: environment });
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function certifyStandaloneAuthorityAndMutationHandling(tempRoot, pristine) {
  const root = path.join(tempRoot, 'authority-mutation-certification');
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'nt-auth-'));
  await resetCase(pristine, root);
  const environment = {
    ...process.env,
    NOVELTEA_CLI_CERTIFICATION: '1',
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `authority-mutation-${process.pid}-${Date.now()}`,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: runtimeRoot,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_IDLE_MS: '60000',
    NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS: '500',
  };
  const traceEnvironment = { ...environment, NOVELTEA_CLI_TRACE: '1' };
  const galleryPath = path.join(root, 'records', 'rooms', 'gallery.json');
  const originalGallery = JSON.parse(await readFile(galleryPath, 'utf8'));
  runNative(['daemon', 'stop'], { env: environment });
  try {
    requireSuccess(
      'authority certification owner admission',
      runNative(['--project', root, '--json', 'asset', 'audit'], {
        cwd: root,
        env: traceEnvironment,
      }),
    );

    const overflowGallery = structuredClone(originalGallery);
    overflowGallery.label = `${overflowGallery.label} overflow recovery`;
    await writeJson(galleryPath, overflowGallery);
    const overflow = requireSuccess(
      'watcher overflow/unknown bulk-rescan recovery',
      runNative(['--project', root, '--json', 'usages', 'rooms', 'gallery'], {
        cwd: root,
        env: {
          ...traceEnvironment,
          NOVELTEA_CLI_SCHEDULER_PROFILE: '1',
          NOVELTEA_CLI_CERTIFICATION_FORCE_AUTHORITY_UNKNOWN: '1',
        },
      }),
    );
    const overflowProfile = schedulerProfile(overflow);
    if (
      !overflowProfile ||
      overflowProfile.authorityFullRescans < 1 ||
      overflowProfile.changedPathCount < 1 ||
      overflowProfile.generationPromotions < 1
    )
      fail(
        `Watcher-unknown recovery did not bulk-rescan and promote the disk change: ${overflow.stderr}`,
      );

    requireSuccess(
      'stale snapshot baseline preparation',
      runNative(
        [
          '--project',
          root,
          '--json',
          'package',
          'export',
          '--output',
          path.join(tempRoot, 'stale-snapshot-baseline.ntpkg'),
          '--allow-localization-warnings',
        ],
        { cwd: root, env: traceEnvironment },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 850));
    const dormantStatus = requireSuccess(
      'stale snapshot dormant status',
      runNative(['--json', 'daemon', 'status'], { env: environment }),
    );
    const dormantDaemon = JSON.parse(dormantStatus.stdout).daemon;
    if (dormantDaemon.projectSessions !== 0)
      fail(`Stale-snapshot certification did not evict the Project owner: ${dormantStatus.stdout}`);
    const staleGallery = JSON.parse(await readFile(galleryPath, 'utf8'));
    staleGallery.label = `${staleGallery.label} changed while dormant`;
    await writeJson(galleryPath, staleGallery);
    const staleDispatch = requireSuccess(
      'stale snapshot rejection before heavy dispatch',
      runNative(
        [
          '--project',
          root,
          '--json',
          'package',
          'export',
          '--output',
          path.join(tempRoot, 'stale-snapshot-reconciled.ntpkg'),
          '--allow-localization-warnings',
        ],
        {
          cwd: root,
          env: { ...traceEnvironment, NOVELTEA_CLI_SCHEDULER_PROFILE: '1' },
        },
      ),
    );
    const staleProfile = schedulerProfile(staleDispatch);
    if (
      !staleProfile?.ownerRehydration ||
      staleProfile.changedPathCount < 1 ||
      staleProfile.generationPromotions < 1 ||
      !staleProfile.snapshotHandoff
    )
      fail(
        `Stale retained snapshot was not reconciled before heavy handoff: ${staleDispatch.stderr}`,
      );

    const raceGalleryText = await readFile(galleryPath, 'utf8');
    const raceInvocation = await runAsync(
      nativeCli,
      ['--project', root, '--json', 'usages', 'rooms', 'gallery'],
      {
        cwd: root,
        env: {
          ...traceEnvironment,
          NOVELTEA_CLI_CERTIFICATION_BEFORE_READ_PROOF_DELAY_MS: '500',
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(galleryPath, '{"id":');
    const raceResult = await raceInvocation.result();
    if (raceResult.status === 0)
      fail(
        `Authority race returned a stale pre-edit result: ${raceResult.stdout}${raceResult.stderr}`,
      );
    await writeFile(galleryPath, raceGalleryText);
    requireSuccess(
      'authority race repair',
      runNative(['--project', root, '--json', 'usages', 'rooms', 'gallery'], {
        cwd: root,
        env: traceEnvironment,
      }),
    );

    let churn = true;
    let churnIndex = 0;
    const churnTask = (async () => {
      while (churn) {
        const current = JSON.parse(await readFile(galleryPath, 'utf8'));
        current.label = `authority churn ${churnIndex++}`;
        await writeJson(galleryPath, current);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    const churnStarted = Date.now();
    const churnInvocation = await runAsync(
      nativeCli,
      ['--project', root, '--json', 'usages', 'rooms', 'gallery'],
      {
        cwd: root,
        env: {
          ...traceEnvironment,
          NOVELTEA_CLI_CERTIFICATION_FORCE_READ_AUTHORITY_MISMATCH: '1',
        },
      },
    );
    const churnResult = await churnInvocation.result();
    churn = false;
    await churnTask;
    const churnMs = Date.now() - churnStarted;
    if (churnResult.status === 0 || churnMs > 5_000)
      fail(
        `Continuous authority churn did not fail through bounded retries: status=${churnResult.status} elapsed=${churnMs}ms.`,
      );
    const scopedChurnStarted = Date.now();
    const scopedChurn = runNative(['--project', root, '--json', 'platform', 'profiles'], {
      cwd: root,
      env: {
        ...traceEnvironment,
        NOVELTEA_CLI_CERTIFICATION_FORCE_READ_AUTHORITY_MISMATCH: '1',
      },
    });
    const scopedChurnMs = Date.now() - scopedChurnStarted;
    if (scopedChurn.status === 0 || scopedChurnMs > 5_000)
      fail(
        `Scoped read authority churn did not fail through bounded retries: status=${scopedChurn.status} elapsed=${scopedChurnMs}ms.`,
      );
    await writeJson(galleryPath, originalGallery);
    requireSuccess(
      'authority churn repair',
      runNative(['--project', root, '--json', 'usages', 'rooms', 'gallery'], {
        cwd: root,
        env: traceEnvironment,
      }),
    );

    const mutationSource = path.join(root, 'assets', 'text', 'mutation-proof.txt');
    await mkdir(path.dirname(mutationSource), { recursive: true });
    await writeFile(mutationSource, 'mutation proof\n');
    const mutation = requireSuccess(
      'owner mutation transaction/proof/promotion',
      runNative(['--project', root, '--json', 'asset', 'import', mutationSource], {
        cwd: root,
        env: { ...traceEnvironment, NOVELTEA_CLI_SCHEDULER_PROFILE: '1' },
      }),
    );
    const mutationProfile = schedulerProfile(mutation);
    const mutationRecord = path.join(root, 'records', 'assets', 'mutation-proof.json');
    if (
      !mutationProfile ||
      mutationProfile.generationPromotions < 1 ||
      !(await stat(mutationRecord)).isFile()
    )
      fail(`Successful owner mutation was not proven/promoted: ${mutation.stderr}`);

    const raceMutationSource = path.join(root, 'assets', 'text', 'mutation-race-proof.txt');
    await writeFile(raceMutationSource, 'mutation race proof\n');
    const mutationRaceStarted = await runAsync(
      nativeCli,
      ['--project', root, '--json', 'asset', 'import', raceMutationSource],
      {
        cwd: root,
        env: {
          ...traceEnvironment,
          NOVELTEA_CLI_SCHEDULER_PROFILE: '1',
          NOVELTEA_CLI_CERTIFICATION_BEFORE_MUTATION_PROOF_DELAY_MS: '700',
        },
      },
    );
    await waitForFile(path.join(root, 'records', 'assets', 'mutation-race-proof.json'));
    const externalGallery = JSON.parse(await readFile(galleryPath, 'utf8'));
    externalGallery.label = 'external mutation race edit';
    await writeJson(galleryPath, externalGallery);
    const mutationRace = await mutationRaceStarted.result();
    if (mutationRace.status === 0)
      fail(`External edit race incorrectly promoted the mutation: ${mutationRace.stdout}`);
    const mutationRaceProfile = schedulerProfile(mutationRace);
    if ((mutationRaceProfile?.generationPromotions ?? 0) !== 0)
      fail(`Failed mutation race promoted a resident generation: ${mutationRace.stderr}`);
    const preservedExternalGallery = JSON.parse(await readFile(galleryPath, 'utf8'));
    if (preservedExternalGallery.label !== 'external mutation race edit')
      fail('Owner mutation race overwrote the concurrent external Project edit.');
    requireSuccess(
      'mutation race reconciliation',
      runNative(['--project', root, '--json', 'asset', 'audit'], {
        cwd: root,
        env: traceEnvironment,
      }),
    );

    return {
      watcherOverflowRecovery: true,
      staleSnapshotRejection: true,
      authorityRaceRetry: true,
      boundedChurnFailure: true,
      mutationProofAndPromotion: true,
      mutationExternalEditRace: true,
    };
  } finally {
    runNative(['daemon', 'stop'], { env: environment });
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function certifyComfyUiDisposableOwnerIsolation(tempRoot, pristine) {
  const root = path.join(tempRoot, 'comfyui-owner-isolation');
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'nt-comfy-'));
  const configRoot = path.join(tempRoot, 'comfyui-owner-isolation-config');
  await resetCase(pristine, root);
  await rm(configRoot, { recursive: true, force: true });
  const server = await startComfyUiCertificationServer(tempRoot, 'success');
  const environment = {
    ...process.env,
    NOVELTEA_CLI_CERTIFICATION: '1',
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `comfyui-owner-isolation-${process.pid}-${Date.now()}`,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: runtimeRoot,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_IDLE_MS: '60000',
    NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS: '60000',
    NOVELTEA_USER_CONFIG_ROOT: configRoot,
  };
  const traceEnvironment = { ...environment, NOVELTEA_CLI_TRACE: '1' };
  runNative(['daemon', 'stop'], { env: environment });
  try {
    requireSuccess(
      'ComfyUI owner-isolation owner admission',
      runNative(['--project', root, '--json', 'asset', 'audit'], {
        cwd: root,
        env: traceEnvironment,
      }),
    );
    await writeFile(server.logPath, '');
    const invocation = await runAsync(
      nativeCli,
      [
        '--project',
        root,
        '--json',
        'comfyui',
        'run',
        'flux2-klein-text-to-image',
        '--server',
        server.url,
        '--input',
        'prompt=owner isolation certification',
      ],
      {
        cwd: root,
        env: { ...traceEnvironment, NOVELTEA_CLI_SCHEDULER_PROFILE: '1' },
      },
    );
    const resultPromise = invocation.result();
    try {
      await Promise.race([
        waitForComfyUiRequestPrefix(server.logPath, '/history/', 15_000),
        resultPromise.then((result) =>
          fail(
            `Project-backed ComfyUI generation exited before reaching history polling: ` +
              `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          ),
        ),
      ]);
    } catch (error) {
      const daemon = runNative(['--json', 'daemon', 'status'], { env: environment });
      fail(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `daemon status=${daemon.status}\nstdout:\n${daemon.stdout}\nstderr:\n${daemon.stderr}`,
      );
    }
    const shortRead = requireSuccess(
      'ComfyUI concurrent short Project read',
      runNative(['--project', root, '--json', 'usages', 'rooms', 'gallery'], {
        cwd: root,
        env: { ...traceEnvironment, NOVELTEA_CLI_SCHEDULER_PROFILE: '1' },
      }),
    );
    if (invocation.child.exitCode !== null)
      fail(
        'Project-backed ComfyUI generation completed before the concurrent owner read was served.',
      );
    const shortProfile = schedulerProfile(shortRead);
    if (!shortProfile?.ownerHit)
      fail(
        `ComfyUI generation prevented the existing Project owner from serving short work: ${shortRead.stderr}`,
      );
    const afterShortReadStatus = requireSuccess(
      'ComfyUI owner-isolation status after short read',
      runNative(['--json', 'daemon', 'status'], { env: environment }),
    );
    const afterShortReadDaemon = JSON.parse(afterShortReadStatus.stdout).daemon;
    if (afterShortReadDaemon.projectSessions !== 1)
      fail(
        `ComfyUI concurrent short read did not leave the Project owner resident: ${afterShortReadStatus.stdout}`,
      );
    const result = requireSuccess('ComfyUI disposable Project run', await resultPromise);
    const profile = schedulerProfile(result);
    if (profile?.routingClass !== 'disposable-heavy' || !profile.snapshotHandoff)
      fail(
        `Project-backed ComfyUI did not execute as generation-pinned disposable work: ${result.stderr}`,
      );
    const payload = JSON.parse(result.stdout);
    const publishedAssets = Object.values(payload.outputs ?? {})
      .flat()
      .filter((output) => output?.target === 'asset');
    if (publishedAssets.length < 1)
      fail(
        `Project-backed ComfyUI did not commit its generated Asset through the owner: ${result.stdout}`,
      );
    return { disposableHeavy: true, concurrentOwnerRead: true, ownerCommit: true };
  } finally {
    runNative(['daemon', 'stop'], { env: environment });
    await server.stop();
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function certifyResidentDaemon(tempRoot, pristine) {
  const root = path.join(tempRoot, 'resident-daemon');
  const runtimeRoot = path.join(tempRoot, 'resident-daemon-runtime');
  await resetCase(pristine, root);
  const projectOwners = await certifyProjectOwnerScheduling(tempRoot, pristine);
  const disposableTests = await certifyDisposableTestScheduling(tempRoot);
  const disposableOutputs = await certifyDisposableOutputScheduling(tempRoot);
  const buildProtocolIsolation = await certifyDaemonBuildProtocolIsolation(tempRoot);
  const authorityAndMutation = await certifyStandaloneAuthorityAndMutationHandling(
    tempRoot,
    pristine,
  );
  const comfyUiOwnerIsolation = await certifyComfyUiDisposableOwnerIsolation(tempRoot, pristine);
  const daemonEnvironment = {
    ...process.env,
    NOVELTEA_CLI_CERTIFICATION: '1',
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `${process.pid}-${Date.now()}`,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: runtimeRoot,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_IDLE_MS: '60000',
    NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS: '250',
  };
  const traceEnvironment = { ...daemonEnvironment, NOVELTEA_CLI_TRACE: '1' };
  runNative(['daemon', 'stop'], { env: daemonEnvironment });

  const stopped = requireSuccess(
    'daemon initial status',
    runNative(['--json', 'daemon', 'status'], { env: daemonEnvironment }),
  );
  const stoppedPayload = JSON.parse(stopped.stdout).daemon;
  if (stoppedPayload.running !== false || stoppedPayload.state !== 'stopped')
    fail(`Daemon did not begin certification stopped: ${stopped.stdout}`);

  const coldStartupStartedAt = Date.now();
  const first = await runAsync(nativeCli, ['--project', root, '--json', 'asset', 'audit'], {
    cwd: root,
    env: traceEnvironment,
  });
  const second = await runAsync(nativeCli, ['--project', root, '--json', 'platform', 'profiles'], {
    cwd: root,
    env: traceEnvironment,
  });
  const [firstResult, secondResult] = await Promise.all([first.result(), second.result()]);
  const coldStartupMs = Date.now() - coldStartupStartedAt;
  requireSuccess('daemon concurrent cold asset audit', firstResult);
  requireSuccess('daemon concurrent cold platform profiles', secondResult);
  for (const entry of [
    { label: 'asset audit', result: firstResult },
    { label: 'platform profiles', result: secondResult },
  ]) {
    if (!entry.result.stderr.includes('[scriptc-host] daemon invocation forwarding'))
      fail(`Concurrent cold ${entry.label} did not route through the daemon.`);
  }

  const ready = requireSuccess(
    'daemon ready status',
    runNative(['--json', 'daemon', 'status'], { env: daemonEnvironment }),
  );
  const readyPayload = JSON.parse(ready.stdout).daemon;
  if (readyPayload.running !== true || readyPayload.state !== 'ready')
    fail(`Daemon did not reach ready state: ${ready.stdout}`);
  if (!Number.isSafeInteger(readyPayload.pid) || readyPayload.pid <= 0)
    fail(`Daemon status did not expose a valid pid: ${ready.stdout}`);
  if (!readyPayload.build.includes(':cert:'))
    fail(`Daemon certification did not use an isolated build identity: ${ready.stdout}`);
  if (!isWindows) {
    const identity = createHash('sha256')
      .update(`${readyPayload.build}\n${readyPayload.protocol}`)
      .digest('hex')
      .slice(0, 32);
    const runtimeInfo = await lstat(runtimeRoot);
    const socketInfo = await lstat(path.join(runtimeRoot, `daemon-${identity}.sock`));
    if ((runtimeInfo.mode & 0o077) !== 0 || (socketInfo.mode & 0o077) !== 0)
      fail('Daemon certification endpoint is not private to the current user.');
  }
  const residentAdmission = requireSuccess(
    'daemon resident Project session admission',
    runNative(['--project', root, '--json', 'usages', 'rooms', 'gallery'], {
      cwd: root,
      env: traceEnvironment,
    }),
  );
  if (!residentAdmission.stderr.includes('[scriptc-host] daemon invocation forwarding'))
    fail('Resident Project session admission did not route through the daemon.');
  const residentStatus = requireSuccess(
    'daemon resident Project session status',
    runNative(['--json', 'daemon', 'status'], { env: daemonEnvironment }),
  );
  const residentStatusPayload = JSON.parse(residentStatus.stdout).daemon;
  if (residentStatusPayload.projectSessions !== 1)
    fail(
      `Resident Project session admission was not observed before the RSS measurement: ${residentStatus.stdout}`,
    );
  const rssWithProject = await daemonRssBytes(readyPayload.pid);
  const residentRead = elapsedMilliseconds(() =>
    runNative(['--project', root, '--json', 'usages', 'rooms', 'gallery'], {
      cwd: root,
      env: traceEnvironment,
    }),
  );
  requireSuccess('daemon resident unchanged read benchmark', residentRead.result);

  await new Promise((resolve) => setTimeout(resolve, 400));
  const sessionEvictionTrigger = requireSuccess(
    'daemon Project session idle eviction trigger',
    runNative(['--json', 'comfyui', 'workflows'], { env: traceEnvironment }),
  );
  if (!sessionEvictionTrigger.stderr.includes('[scriptc-host] daemon invocation forwarding'))
    fail('Project-independent idle-eviction trigger did not route through the resident daemon.');
  const evictedStatus = requireSuccess(
    'daemon Project session idle eviction status',
    runNative(['--json', 'daemon', 'status'], { env: daemonEnvironment }),
  );
  const evictedStatusPayload = JSON.parse(evictedStatus.stdout).daemon;
  if (evictedStatusPayload.projectSessions !== 0)
    fail(
      `Project session eviction was not observed before the post-eviction RSS measurement: ${evictedStatus.stdout}`,
    );
  const rssAfterSessionEviction = await daemonRssBytes(readyPayload.pid);

  const staticExact = requireSuccess(
    'daemon static exact validation precedence',
    runNative(['--project', root, '--json', 'validate'], { cwd: root, env: traceEnvironment }),
  );
  // Exact-result persistence is deliberately debounced until the foreground has been quiet. Do
  // not probe it so aggressively that the probe itself keeps the daemon active and prevents the
  // best-effort publication from starting.
  await new Promise((resolve) => setTimeout(resolve, 750));
  let staticExactRepeat = null;
  const staticExactDeadline = Date.now() + 3_000;
  do {
    staticExactRepeat = requireSuccess(
      'daemon static exact validation precedence repeat',
      runNative(['--project', root, '--json', 'validate'], { cwd: root, env: traceEnvironment }),
    );
    if (!staticExactRepeat.stderr.includes('[scriptc-host] daemon invocation forwarding')) break;
    await new Promise((resolve) => setTimeout(resolve, 750));
  } while (Date.now() < staticExactDeadline);
  if (staticExactRepeat.stderr.includes('[scriptc-host] daemon invocation forwarding'))
    fail(
      'Best-effort exact validation publication did not become reusable through the static path.',
    );
  if (!staticExact.stderr.includes('[scriptc-host] daemon invocation forwarding')) {
    // A prior differential may already have populated an exact generation; either ordering is valid here.
    if (!staticExact.stderr.includes('[scriptc-host] static validation completed'))
      fail('Validation completed through neither the daemon nor the static exact path.');
  }

  const replayServer = await startComfyUiCertificationServer(tempRoot, 'first-system-stats-hangs');
  try {
    await writeFile(replayServer.logPath, '');
    const replayInvocation = await runAsync(
      nativeCli,
      ['--json', 'comfyui', 'status', '--server', replayServer.url],
      { cwd: root, env: traceEnvironment },
    );
    const replayResultPromise = replayInvocation.result();
    await waitForComfyUiRequest(replayServer.logPath, '/system_stats');
    process.kill(readyPayload.pid);
    const replayResult = requireSuccess(
      'daemon mid-request read-only replay',
      await replayResultPromise,
    );
    if (
      !replayResult.stderr.includes('[scriptc-host] daemon invocation forwarding') ||
      !replayResult.stderr.includes(
        '[scriptc-host] daemon acceleration unavailable; using local island fallback',
      )
    )
      fail('Read-only daemon crash did not replay through the canonical local fallback.');
    const replayRequests = await readComfyUiRequests(replayServer.logPath);
    if (replayRequests.filter((request) => request.path === '/system_stats').length !== 2)
      fail('Read-only daemon crash did not produce exactly one replayed request.');
  } finally {
    await replayServer.stop();
  }

  const unsafeWarmup = requireSuccess(
    'daemon restart before unsafe crash certification',
    runNative(['--json', 'comfyui', 'workflows'], { cwd: root, env: traceEnvironment }),
  );
  if (!unsafeWarmup.stderr.includes('[scriptc-host] daemon invocation forwarding'))
    fail('Daemon did not restart before unsafe crash certification.');
  const unsafeStatus = requireSuccess(
    'daemon unsafe crash status',
    runNative(['--json', 'daemon', 'status'], { env: daemonEnvironment }),
  );
  const unsafePayload = JSON.parse(unsafeStatus.stdout).daemon;
  if (!Number.isSafeInteger(unsafePayload.pid) || unsafePayload.pid <= 0)
    fail(`Unsafe crash certification did not expose a daemon pid: ${unsafeStatus.stdout}`);

  const unsafeServer = await startComfyUiCertificationServer(tempRoot, 'never-complete');
  try {
    await writeFile(unsafeServer.logPath, '');
    const unsafeInvocation = await runAsync(
      nativeCli,
      [
        '--json',
        'comfyui',
        'run',
        'flux2-klein-text-to-image',
        '--server',
        unsafeServer.url,
        '--input',
        'prompt=daemon crash no replay',
        '--output',
        `images=${path.join(tempRoot, 'daemon-crash-no-replay')}`,
      ],
      { cwd: root, env: traceEnvironment },
    );
    const unsafeResultPromise = unsafeInvocation.result();
    const unsafeAdmission = await Promise.race([
      waitForComfyUiRequestPrefix(unsafeServer.logPath, '/history/', 30_000).then(() => ({
        kind: 'history',
      })),
      unsafeResultPromise.then((result) => ({ kind: 'result', result })),
    ]);
    if (unsafeAdmission.kind === 'result')
      fail(
        `Unsafe daemon crash request exited before reaching ComfyUI history polling: ` +
          `status=${unsafeAdmission.result.status}.\nstdout:\n${unsafeAdmission.result.stdout}\n` +
          `stderr:\n${unsafeAdmission.result.stderr}`,
      );
    process.kill(unsafePayload.pid);
    const unsafeResult = await unsafeResultPromise;
    if (unsafeResult.status !== 70)
      fail(`Unsafe daemon crash exited ${unsafeResult.status}, expected DAEMON_EXECUTION exit 70.`);
    if (
      unsafeResult.stderr.includes('daemon acceleration unavailable; using local island fallback')
    )
      fail('Unsafe daemon request was blindly replayed after mid-request daemon death.');
    const unsafeEnvelope = JSON.parse(unsafeResult.stdout);
    if (!unsafeEnvelope.diagnostics?.some((item) => item.code === 'DAEMON_EXECUTION'))
      fail(`Unsafe daemon crash did not report DAEMON_EXECUTION: ${unsafeResult.stdout}`);
    const unsafeRequests = await readComfyUiRequests(unsafeServer.logPath);
    if (unsafeRequests.filter((request) => request.path === '/prompt').length !== 1)
      fail('Unsafe daemon crash duplicated the opaque ComfyUI prompt side effect.');
  } finally {
    await unsafeServer.stop();
  }

  const restartedRead = requireSuccess(
    'daemon crash read-only restart',
    runNative(['--project', root, '--json', 'asset', 'audit'], {
      cwd: root,
      env: traceEnvironment,
    }),
  );
  if (!restartedRead.stderr.includes('[scriptc-host] daemon invocation forwarding'))
    fail('Read-only request after daemon death did not re-enter daemon routing.');
  const restarted = requireSuccess(
    'daemon restarted status',
    runNative(['--json', 'daemon', 'status'], { env: daemonEnvironment }),
  );
  const restartedPayload = JSON.parse(restarted.stdout).daemon;
  if (restartedPayload.running !== true || restartedPayload.state !== 'ready')
    fail(`Daemon did not recover after process death: ${restarted.stdout}`);
  if (restartedPayload.pid === readyPayload.pid)
    fail('Daemon crash recovery reused the terminated process id unexpectedly.');
  const rssAfterRestart = await daemonRssBytes(restartedPayload.pid);

  requireSuccess(
    'daemon stop before idle-shutdown certification',
    runNative(['--json', 'daemon', 'stop'], { env: daemonEnvironment }),
  );
  const idleDaemonEnvironment = {
    ...daemonEnvironment,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `${daemonEnvironment.NOVELTEA_CLI_CERTIFICATION_DAEMON_ID}-idle`,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_IDLE_MS: '2000',
  };
  const idleTraceEnvironment = { ...idleDaemonEnvironment, NOVELTEA_CLI_TRACE: '1' };
  const idleAdmission = requireSuccess(
    'daemon idle-shutdown admission',
    runNative(['--project', root, '--json', 'asset', 'audit'], {
      cwd: root,
      env: idleTraceEnvironment,
    }),
  );
  if (!idleAdmission.stderr.includes('[scriptc-host] daemon invocation forwarding'))
    fail('Idle-shutdown certification did not route through the resident daemon.');

  await new Promise((resolve) => setTimeout(resolve, 2300));
  const idleStatus = requireSuccess(
    'daemon idle shutdown status',
    runNative(['--json', 'daemon', 'status'], { env: idleDaemonEnvironment }),
  );
  const idlePayload = JSON.parse(idleStatus.stdout).daemon;
  if (idlePayload.running !== false || idlePayload.state !== 'stopped')
    fail(`Daemon did not shut down after its idle cutoff: ${idleStatus.stdout}`);

  const restartedAfterIdle = requireSuccess(
    'daemon restart after idle shutdown',
    runNative(['--project', root, '--json', 'asset', 'audit'], {
      cwd: root,
      env: idleTraceEnvironment,
    }),
  );
  if (!restartedAfterIdle.stderr.includes('[scriptc-host] daemon invocation forwarding'))
    fail('Daemon did not restart after idle shutdown.');

  const noDaemon = requireSuccess(
    'explicit no-daemon escape hatch',
    runNative(['--no-daemon', '--project', root, '--json', 'asset', 'audit'], {
      cwd: root,
      env: traceEnvironment,
    }),
  );
  if (!noDaemon.stderr.includes('[scriptc-host] daemon routing bypassed'))
    fail('--no-daemon did not select the canonical local QuickJS path.');
  const envNoDaemon = requireSuccess(
    'environment no-daemon escape hatch',
    runNative(['--project', root, '--json', 'asset', 'audit'], {
      cwd: root,
      env: { ...traceEnvironment, NOVELTEA_NO_DAEMON: '1' },
    }),
  );
  if (!envNoDaemon.stderr.includes('[scriptc-host] daemon routing bypassed'))
    fail('NOVELTEA_NO_DAEMON=1 did not select the canonical local QuickJS path.');

  const stoppedAgain = requireSuccess(
    'daemon graceful stop',
    runNative(['--json', 'daemon', 'stop'], { env: idleDaemonEnvironment }),
  );
  const stopPayload = JSON.parse(stoppedAgain.stdout).daemon;
  if (stopPayload.running !== false || stopPayload.state !== 'stopped')
    fail(`Daemon stop did not report stopped state: ${stoppedAgain.stdout}`);

  const report = {
    platform: `${process.platform}/${process.arch}`,
    startupElection: true,
    secureEndpoint: true,
    buildProtocolIsolation,
    authorityAndMutation,
    comfyUiOwnerIsolation,
    disposableTests,
    disposableOutputs,
    projectOwners,
    midRequestReadReplay: true,
    midRequestUnsafeNoReplay: true,
    crashRestart: true,
    idleShutdown: true,
    projectSessionIdleEviction: true,
    staticPrecedence: true,
    explicitBypass: true,
    performanceMs: {
      coldStartupAndConcurrentReads: coldStartupMs,
      residentUnchangedRead: Math.round(residentRead.elapsed * 10) / 10,
    },
    rssBytes: {
      withProjectSession: rssWithProject,
      afterProjectSessionEviction: rssAfterSessionEviction,
      afterRestart: rssAfterRestart,
    },
  };
  process.stdout.write(`[resident-daemon] ${JSON.stringify(report)}\n`);
  return report;
}

async function certifyPerformanceEnvelope(tempRoot, pristine) {
  const runs = 5;
  const measureRepeated = (label, invoke) => {
    const samples = [];
    for (let index = 0; index < runs; index += 1) {
      const { result, elapsed } = elapsedMilliseconds(invoke);
      requireSuccess(`${label} benchmark ${index + 1}`, result);
      samples.push(elapsed);
    }
    return summarizeBenchmark(samples);
  };

  const nodeRoot = path.join(tempRoot, 'performance-node');
  const nativeRoot = path.join(tempRoot, 'performance-native');
  const templateRegistryRoot = path.join(tempRoot, 'performance-templates');
  await resetCase(pristine, nodeRoot);
  await resetCase(pristine, nativeRoot);
  await mkdir(templateRegistryRoot, { recursive: true });
  const benchmarkEnvironment = {
    ...process.env,
    NOVELTEA_TEMPLATE_REGISTRY_ROOT: templateRegistryRoot,
  };

  const report = {
    targetsMs: { trivial: 300, lightweightProject: 500 },
    targetsRatio: { oneSourceValidationSpeedup: 2 },
    note: 'Trivial/lightweight timings remain engineering observations. Feature Lab resident one-source latency and structural change-proportionality are release gates.',
    cases: {
      nodeVersion: measureRepeated('Node version', () => runNode(['--json', '--version'])),
      scriptcVersion: measureRepeated('ScriptC version', () => runNative(['--json', '--version'])),
      nodeTemplateList: measureRepeated('Node platform template list', () =>
        runNode(['--json', 'platform', 'template', 'list'], { env: benchmarkEnvironment }),
      ),
      scriptcTemplateList: measureRepeated('ScriptC platform template list', () =>
        runNative(['--json', 'platform', 'template', 'list'], { env: benchmarkEnvironment }),
      ),
      nodeAssetAudit: measureRepeated('Node asset audit', () =>
        runNode(['--project', nodeRoot, '--json', 'asset', 'audit'], {
          cwd: nodeRoot,
          env: benchmarkEnvironment,
        }),
      ),
      scriptcAssetAudit: measureRepeated('ScriptC asset audit', () =>
        runNative(['--project', nativeRoot, '--json', 'asset', 'audit'], {
          cwd: nativeRoot,
          env: benchmarkEnvironment,
        }),
      ),
      nodePlatformProfiles: measureRepeated('Node platform profiles', () =>
        runNode(['--project', nodeRoot, '--json', 'platform', 'profiles'], {
          cwd: nodeRoot,
          env: benchmarkEnvironment,
        }),
      ),
      scriptcPlatformProfiles: measureRepeated('ScriptC platform profiles', () =>
        runNative(['--project', nativeRoot, '--json', 'platform', 'profiles'], {
          cwd: nativeRoot,
          env: benchmarkEnvironment,
        }),
      ),
    },
  };

  const nodeValidateRoot = path.join(tempRoot, 'performance-node-validate');
  const scriptcValidateRoot = path.join(tempRoot, 'performance-scriptc-validate');
  await resetCase(pristine, nodeValidateRoot);
  await resetCase(pristine, scriptcValidateRoot);
  await inflateValidationBenchmark(nodeValidateRoot);
  await inflateValidationBenchmark(scriptcValidateRoot);
  const profileEnvironment = { ...process.env, NOVELTEA_CLI_VALIDATION_PROFILE: '1' };
  const nodeCold = elapsedMilliseconds(() =>
    runNode(['--project', nodeValidateRoot, '--json', 'validate'], { cwd: nodeValidateRoot }),
  );
  requireSuccess('Node cold validate benchmark', nodeCold.result);
  const nodeWarm = elapsedMilliseconds(() =>
    runNode(['--project', nodeValidateRoot, '--json', 'validate'], { cwd: nodeValidateRoot }),
  );
  requireSuccess('Node warm validate benchmark', nodeWarm.result);
  await editValidationBenchmarkRecord(nodeValidateRoot, 'Node incremental change');
  const nodeChanged = elapsedMilliseconds(() =>
    runNode(['--project', nodeValidateRoot, '--json', 'validate'], {
      cwd: nodeValidateRoot,
      env: profileEnvironment,
    }),
  );
  requireSuccess('Node one-source changed validate benchmark', nodeChanged.result);
  await rm(path.join(nodeValidateRoot, '.noveltea', 'cache', 'authoring', 'current'), {
    force: true,
  });
  const nodeForcedFull = elapsedMilliseconds(() =>
    runNode(['--project', nodeValidateRoot, '--json', 'validate'], {
      cwd: nodeValidateRoot,
      env: profileEnvironment,
    }),
  );
  requireSuccess('Node forced full validate benchmark', nodeForcedFull.result);
  const scriptcCold = elapsedMilliseconds(() =>
    runNative(['--project', scriptcValidateRoot, '--json', 'validate'], {
      cwd: scriptcValidateRoot,
    }),
  );
  requireSuccess('ScriptC cold validate benchmark', scriptcCold.result);
  const scriptcWarm = elapsedMilliseconds(() =>
    runNative(['--project', scriptcValidateRoot, '--json', 'validate'], {
      cwd: scriptcValidateRoot,
    }),
  );
  requireSuccess('ScriptC warm validate benchmark', scriptcWarm.result);
  await editValidationBenchmarkRecord(scriptcValidateRoot, 'ScriptC incremental change');
  const scriptcChanged = elapsedMilliseconds(() =>
    runNative(['--project', scriptcValidateRoot, '--json', 'validate'], {
      cwd: scriptcValidateRoot,
      env: profileEnvironment,
    }),
  );
  requireSuccess('ScriptC one-source changed validate benchmark', scriptcChanged.result);
  await rm(path.join(scriptcValidateRoot, '.noveltea', 'cache', 'authoring', 'current'), {
    force: true,
  });
  const scriptcForcedFull = elapsedMilliseconds(() =>
    runNative(['--no-daemon', '--project', scriptcValidateRoot, '--json', 'validate'], {
      cwd: scriptcValidateRoot,
      env: profileEnvironment,
    }),
  );
  requireSuccess('ScriptC forced full validate benchmark', scriptcForcedFull.result);
  report.cases.nodeValidate = {
    coldMs: Math.round(nodeCold.elapsed * 10) / 10,
    warmMs: Math.round(nodeWarm.elapsed * 10) / 10,
    oneSourceChangedMs: Math.round(nodeChanged.elapsed * 10) / 10,
    forcedFullMs: Math.round(nodeForcedFull.elapsed * 10) / 10,
    oneSourceSpeedup: Math.round((nodeForcedFull.elapsed / nodeChanged.elapsed) * 100) / 100,
    oneSourceWork: validationProfile(nodeChanged.result),
    forcedFullWork: validationProfile(nodeForcedFull.result),
  };
  report.cases.scriptcValidate = {
    coldMs: Math.round(scriptcCold.elapsed * 10) / 10,
    warmMs: Math.round(scriptcWarm.elapsed * 10) / 10,
    oneSourceChangedMs: Math.round(scriptcChanged.elapsed * 10) / 10,
    forcedFullMs: Math.round(scriptcForcedFull.elapsed * 10) / 10,
    oneSourceSpeedup: Math.round((scriptcForcedFull.elapsed / scriptcChanged.elapsed) * 100) / 100,
    oneSourceWork: validationProfile(scriptcChanged.result),
    forcedFullWork: validationProfile(scriptcForcedFull.result),
  };

  const featureLabRoot = path.join(tempRoot, 'performance-feature-lab');
  await rm(featureLabRoot, { recursive: true, force: true });
  await cp(path.join(repositoryRoot, 'tests', 'projects', 'feature-lab'), featureLabRoot, {
    recursive: true,
  });
  await rm(path.join(featureLabRoot, '.noveltea', 'cache', 'authoring'), {
    recursive: true,
    force: true,
  });
  requireSuccess(
    'Feature Lab resident benchmark admission',
    runNative(['--project', featureLabRoot, '--json', 'validate'], {
      cwd: featureLabRoot,
      env: profileEnvironment,
    }),
  );
  const featureLabRecord = path.join(featureLabRoot, 'records', 'rooms', 'feature-lab-home.json');
  {
    const room = JSON.parse(await readFile(featureLabRecord, 'utf8'));
    room.label = 'Feature Lab Home benchmark warmup';
    await writeJson(featureLabRecord, room);
    const warmup = requireSuccess(
      'Feature Lab resident one-record benchmark warmup',
      runNative(['--project', featureLabRoot, '--json', 'validate'], {
        cwd: featureLabRoot,
        env: profileEnvironment,
      }),
    );
    requireIncrementalValidationWork(
      'Feature Lab resident one-record benchmark warmup',
      validationProfile(warmup),
    );
  }
  const featureLabSamples = [];
  const featureLabWork = [];
  for (let index = 0; index < 7; index += 1) {
    const room = JSON.parse(await readFile(featureLabRecord, 'utf8'));
    room.label = `Feature Lab Home benchmark ${index}`;
    await writeJson(featureLabRecord, room);
    const measured = elapsedMilliseconds(() =>
      runNative(['--project', featureLabRoot, '--json', 'validate'], {
        cwd: featureLabRoot,
        env: profileEnvironment,
      }),
    );
    requireSuccess(`Feature Lab one-record benchmark ${index + 1}`, measured.result);
    featureLabSamples.push(measured.elapsed);
    featureLabWork.push(validationProfile(measured.result));
  }
  report.targetsMs.featureLabOneRecordMedian = 75;
  report.targetsMs.featureLabOneRecordP95 = 100;
  report.cases.featureLabResidentOneRecord = {
    ...summarizeBenchmark(featureLabSamples),
    samples: featureLabSamples.map((value) => Math.round(value * 10) / 10),
    work: featureLabWork,
  };
  for (let index = 0; index < featureLabWork.length; index += 1)
    requireIncrementalValidationWork(
      `Feature Lab one-record benchmark ${index + 1}`,
      featureLabWork[index],
    );
  if (report.cases.featureLabResidentOneRecord.medianMs > 75)
    fail(
      `Feature Lab resident one-source median ${report.cases.featureLabResidentOneRecord.medianMs} ms exceeds the 75 ms release gate.`,
    );
  if (report.cases.featureLabResidentOneRecord.p95Ms > 100)
    fail(
      `Feature Lab resident one-source p95 ${report.cases.featureLabResidentOneRecord.p95Ms} ms exceeds the 100 ms release gate.`,
    );

  const featureLabRoom = JSON.parse(await readFile(featureLabRecord, 'utf8'));
  featureLabRoom.label = 'Feature Lab Home scheduler diagnostics';
  await writeJson(featureLabRecord, featureLabRoom);
  const featureLabSchedulerResult = requireSuccess(
    'Feature Lab scheduler diagnostics',
    runNative(['--project', featureLabRoot, '--json', 'validate'], {
      cwd: featureLabRoot,
      env: {
        ...profileEnvironment,
        NOVELTEA_CLI_SCHEDULER_PROFILE: '1',
      },
    }),
  );
  const featureLabScheduler = schedulerProfile(featureLabSchedulerResult);
  if (
    !featureLabScheduler ||
    featureLabScheduler.routingClass !== 'owner-short' ||
    featureLabScheduler.ownerHit !== true ||
    featureLabScheduler.changedPathCount < 1 ||
    featureLabScheduler.physicalFilesObserved < 1 ||
    featureLabScheduler.nativeBoundaryCalls < 1
  )
    fail(
      `Feature Lab scheduler diagnostics did not expose resident authority work: ${featureLabSchedulerResult.stderr}`,
    );
  report.cases.featureLabResidentOneRecord.scheduler = featureLabScheduler;

  const smallScalingSamples = [];
  const smallScalingWork = [];
  for (let index = 0; index < 5; index += 1) {
    await editValidationBenchmarkRecord(scriptcValidateRoot, `Small scaling change ${index}`);
    const measured = elapsedMilliseconds(() =>
      runNative(['--project', scriptcValidateRoot, '--json', 'validate'], {
        cwd: scriptcValidateRoot,
        env: profileEnvironment,
      }),
    );
    requireSuccess(`small synthetic one-source benchmark ${index + 1}`, measured.result);
    smallScalingSamples.push(measured.elapsed);
    const profile = validationProfile(measured.result);
    requireIncrementalValidationWork(`small synthetic one-source benchmark ${index + 1}`, profile);
    smallScalingWork.push(profile);
  }

  const largeRoot = path.join(tempRoot, 'performance-large-validate');
  await resetCase(pristine, largeRoot);
  await inflateValidationBenchmark(largeRoot, 600);
  requireSuccess(
    'large synthetic resident benchmark admission',
    runNative(['--project', largeRoot, '--json', 'validate'], {
      cwd: largeRoot,
      env: profileEnvironment,
    }),
  );
  const largeScalingSamples = [];
  const largeScalingWork = [];
  for (let index = 0; index < 5; index += 1) {
    await editValidationBenchmarkRecord(largeRoot, `Large synthetic incremental change ${index}`);
    const measured = elapsedMilliseconds(() =>
      runNative(['--project', largeRoot, '--json', 'validate'], {
        cwd: largeRoot,
        env: profileEnvironment,
      }),
    );
    requireSuccess(`large synthetic one-source benchmark ${index + 1}`, measured.result);
    largeScalingSamples.push(measured.elapsed);
    const profile = validationProfile(measured.result);
    requireIncrementalValidationWork(`large synthetic one-source benchmark ${index + 1}`, profile);
    largeScalingWork.push(profile);
  }
  for (const field of [
    'validationChecksRecomputed',
    'dependencyWorkRecomputed',
    'dependencyContributionsRecomputed',
    'sourceAnalysesRecomputed',
  ]) {
    const small = maxUsefulWork(smallScalingWork, field);
    const large = maxUsefulWork(largeScalingWork, field);
    if (large > Math.max(2, small * 2))
      fail(
        `Large-Project isolated edit scaled ${field} with unrelated records (${String(small)} -> ${String(large)}).`,
      );
  }
  report.cases.dependencyClosureScaling = {
    smallUnrelatedRecords: 120,
    smallTiming: summarizeBenchmark(smallScalingSamples),
    smallWork: smallScalingWork,
    largeUnrelatedRecords: 600,
    largeTiming: summarizeBenchmark(largeScalingSamples),
    largeWork: largeScalingWork,
    note: 'Native batched physical observation may remain O(Project source count); QuickJS semantic parse/validation/dependency work should remain scoped to the affected dependency closure.',
  };

  process.stdout.write(`[performance] ${JSON.stringify(report)}\n`);
  return report;
}

function certifyScopedPreparationLazyBoundaries(projectRoot) {
  const env = { ...process.env, NOVELTEA_CLI_TRACE: '1', NOVELTEA_NO_DAEMON: '1' };
  for (const test of [
    {
      label: 'standalone scoped asset audit',
      args: ['--project', projectRoot, '--json', 'asset', 'audit'],
    },
    {
      label: 'standalone scoped platform profiles',
      args: ['--project', projectRoot, '--json', 'platform', 'profiles'],
    },
  ]) {
    const result = requireSuccess(test.label, runNative(test.args, { cwd: projectRoot, env }));
    assertIslandTrace(test.label, result, true);
    assertIslandBoundaryTrace(test.label, result, 'workspace services import starting', false);
  }
  process.stdout.write('[scoped-lazy-boundaries] asset audit and platform profiles: PASS\n');
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
  const tracedEnvironment = {
    ...process.env,
    NOVELTEA_CLI_TRACE: '1',
    NOVELTEA_NO_DAEMON: '1',
  };
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
  const tracedEnvironment = {
    ...process.env,
    NOVELTEA_CLI_TRACE: '1',
    NOVELTEA_NO_DAEMON: '1',
  };

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
  const tracedEnvironment = {
    ...process.env,
    NOVELTEA_CLI_TRACE: '1',
    NOVELTEA_NO_DAEMON: '1',
  };
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
    NOVELTEA_NO_DAEMON: '1',
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

  const daemonEnvironment = {
    ...process.env,
    NOVELTEA_TEMPLATE_REGISTRY_ROOT: registry,
  };
  const daemonListed = requireSuccess(
    'daemon template registry environment',
    runNative(['--json', 'platform', 'template', 'list'], {
      cwd: tempRoot,
      env: daemonEnvironment,
    }),
  );
  const daemonTemplates = JSON.parse(daemonListed.stdout).templates;
  if (
    !Array.isArray(daemonTemplates) ||
    daemonTemplates[0]?.id !== 'certification-web-template@build-1'
  )
    fail('Daemon-routed template registry did not observe the caller environment.');
  const emptyRegistry = path.join(tempRoot, 'empty-template-registry');
  await mkdir(emptyRegistry, { recursive: true });
  const isolatedEnvironment = {
    ...process.env,
    NOVELTEA_TEMPLATE_REGISTRY_ROOT: emptyRegistry,
  };
  const isolatedList = requireSuccess(
    'daemon template registry environment isolation',
    runNative(['--json', 'platform', 'template', 'list'], {
      cwd: tempRoot,
      env: isolatedEnvironment,
    }),
  );
  if (JSON.parse(isolatedList.stdout).templates?.length !== 0)
    fail('Daemon template registry environment leaked across requests.');
  const restoredList = requireSuccess(
    'daemon template registry environment restore',
    runNative(['--json', 'platform', 'template', 'list'], {
      cwd: tempRoot,
      env: daemonEnvironment,
    }),
  );
  if (JSON.parse(restoredList.stdout).templates?.[0]?.id !== 'certification-web-template@build-1')
    fail('Daemon template registry environment was not restored for the next request.');

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
    for (const [key, next] of Object.entries(item).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
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
      const local = await runOne(runNativeNoDaemon, 'no-daemon');
      for (const entry of [
        { label: 'resident', candidate: native },
        { label: 'no-daemon', candidate: local },
      ]) {
        const { label, candidate } = entry;
        if (
          node.result.status !== candidate.result.status ||
          node.result.stderr !== candidate.result.stderr
        )
          fail(
            `ComfyUI differential '${test.name}' ${label} exit/stderr differs.\n` +
              `Node status=${node.result.status} stderr=${JSON.stringify(node.result.stderr)}\n` +
              `Candidate status=${candidate.result.status} stderr=${JSON.stringify(candidate.result.stderr)} ` +
              `stdout=${JSON.stringify(candidate.result.stdout)}`,
          );
        if (canonicalComfyUiResult(node.result) !== canonicalComfyUiResult(candidate.result))
          fail(
            `ComfyUI differential '${test.name}' ${label} stdout differs.\nNode: ${node.result.stdout}\nCandidate: ${candidate.result.stdout}`,
          );
        if (node.state !== candidate.state)
          fail(`ComfyUI differential '${test.name}' ${label} filesystem/Project state differs.`);
        if (
          canonicalComfyUiRequests(node.requests) !== canonicalComfyUiRequests(candidate.requests)
        )
          fail(
            `ComfyUI differential '${test.name}' ${label} fake-server request trace differs.\nNode: ${JSON.stringify(node.requests)}\nCandidate: ${JSON.stringify(candidate.requests)}`,
          );
      }
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
  let scriptcDaemonRoot = null;
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
    await waitForComfyUiRequestPrefix(cancellationServer.logPath, '/history/');
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
    // Keep the private Unix runtime root short enough for sockaddr_un.sun_path. The main
    // certification root is intentionally descriptive and can already consume most of the limit.
    scriptcDaemonRoot = await mkdtemp(path.join(os.tmpdir(), 'nt-comfy-cancel-'));
    const scriptcEnvironment = {
      ...process.env,
      NOVELTEA_USER_CONFIG_ROOT: scriptcConfigRoot,
      NOVELTEA_CLI_CERTIFICATION: '1',
      NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `comfyui-cancel-${process.pid}-${Date.now()}`,
      NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: scriptcDaemonRoot,
      NOVELTEA_CLI_TRACE: '1',
    };
    runNative(['daemon', 'stop'], { env: scriptcEnvironment });
    let daemonWarmup = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      daemonWarmup = runNative(['--json', 'comfyui', 'workflows'], {
        cwd: tempRoot,
        env: scriptcEnvironment,
      });
      if (daemonWarmup.stderr.includes('[scriptc-host] daemon invocation forwarding')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!daemonWarmup?.stderr.includes('[scriptc-host] daemon invocation forwarding'))
      fail(
        `Could not establish the resident daemon before cancellation certification.\n` +
          `stdout:\n${daemonWarmup?.stdout ?? ''}\nstderr:\n${daemonWarmup?.stderr ?? ''}`,
      );
    const windowsScriptc = isWindows
      ? await runWindowsConsoleProcess(nativeCli, cancelArgs, {
          cwd: tempRoot,
          env: scriptcEnvironment,
        })
      : null;
    const scriptcInvocation = windowsScriptc
      ? windowsScriptc.invocation
      : await runAsync(nativeCli, cancelArgs, {
          cwd: tempRoot,
          env: scriptcEnvironment,
        });
    const scriptcResultPromise = scriptcInvocation.result();
    await waitForComfyUiRequestPrefix(cancellationServer.logPath, '/history/');
    if (windowsScriptc) sendWindowsConsoleCtrlC(windowsScriptc.pid);
    else scriptcInvocation.child.kill('SIGINT');
    const scriptcResult = await scriptcResultPromise;
    if (scriptcResult.status !== 130)
      fail(`ScriptC daemon ComfyUI cancellation exited ${scriptcResult.status}, expected 130.`);
    // The resident worker performs cancellation cooperatively after the short-lived
    // client forwards Ctrl+C. Under a loaded certification run, allow cleanup enough
    // time to cross the daemon boundary and reach ComfyUI before declaring failure.
    try {
      await waitForComfyUiRequest(cancellationServer.logPath, '/queue', 15_000);
    } catch (error) {
      const cancellationRequests = await readComfyUiRequests(cancellationServer.logPath);
      fail(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `ScriptC result: status=${scriptcResult.status}\nstdout:\n${scriptcResult.stdout}\nstderr:\n${scriptcResult.stderr}\n` +
          `ComfyUI requests:\n${JSON.stringify(cancellationRequests, null, 2)}`,
      );
    }
    requests = await readComfyUiRequests(cancellationServer.logPath);
    if (!requests.some((request) => request.method === 'POST' && request.path === '/queue'))
      fail('ScriptC daemon cancellation did not issue prompt-specific queue deletion.');
    if (requests.some((request) => request.path === '/interrupt'))
      fail('ScriptC daemon cancellation used the forbidden global /interrupt endpoint.');
    if (!scriptcResult.stderr.includes('[scriptc-host] daemon invocation forwarding'))
      fail('ScriptC cancellation certification did not exercise the production daemon route.');
    runNative(['daemon', 'stop'], { env: scriptcEnvironment });
    process.stdout.write('[comfyui cancellation] ScriptC daemon Ctrl+C: PASS\n');

    await writeFile(cancellationServer.logPath, '');
    const localEnvironment = {
      ...scriptcEnvironment,
      NOVELTEA_NO_DAEMON: '1',
    };
    const windowsLocal = isWindows
      ? await runWindowsConsoleProcess(nativeCli, cancelArgs, {
          cwd: tempRoot,
          env: localEnvironment,
        })
      : null;
    const localInvocation = windowsLocal
      ? windowsLocal.invocation
      : await runAsync(nativeCli, cancelArgs, {
          cwd: tempRoot,
          env: localEnvironment,
        });
    const localResultPromise = localInvocation.result();
    await waitForComfyUiRequestPrefix(cancellationServer.logPath, '/history/');
    if (windowsLocal) sendWindowsConsoleCtrlC(windowsLocal.pid);
    else localInvocation.child.kill('SIGINT');
    const localResult = await localResultPromise;
    if (localResult.status !== 130)
      fail(`ScriptC local ComfyUI cancellation exited ${localResult.status}, expected 130.`);
    await waitForComfyUiRequest(cancellationServer.logPath, '/queue', 15_000);
    requests = await readComfyUiRequests(cancellationServer.logPath);
    if (!requests.some((request) => request.method === 'POST' && request.path === '/queue'))
      fail('ScriptC local cancellation did not issue prompt-specific queue deletion.');
    if (requests.some((request) => request.path === '/interrupt'))
      fail('ScriptC local cancellation used the forbidden global /interrupt endpoint.');
    if (!localResult.stderr.includes('[scriptc-host] daemon routing bypassed'))
      fail('ScriptC local cancellation certification did not exercise --no-daemon fallback.');
    process.stdout.write('[comfyui cancellation] ScriptC local Ctrl+C: PASS\n');
  } finally {
    await cancellationServer.stop();
    if (scriptcDaemonRoot)
      await rm(scriptcDaemonRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  return cases.length + failureCases.length + 3;
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
  const sectionNames = Object.freeze([
    'differential',
    'bootstrap-island',
    'typed-shaders',
    'raw-shaderc',
    'authoring-cache',
    'daemon-authoring-cache',
    'daemon-authoring-cache-pressure',
    'project-owner-scheduling',
    'disposable-tests',
    'disposable-output',
    'build-protocol-isolation',
    'authority-mutation',
    'comfyui-owner-isolation',
    'resident-daemon',
    'editor-authoring-cache-sharing',
    'performance',
    'scoped-preparation',
    'test-command-parity',
    'runtime-cache',
    'native-operations',
    'feature-lab-tests',
    'platform-host',
    'comfyui-standalone',
    'relocation',
  ]);
  const argv = process.argv.slice(2);
  let onlySections = null;
  for (let index = 0; index < argv.length; ++index) {
    const argument = argv[index];
    if (argument === '--list-sections') {
      process.stdout.write(`${sectionNames.join('\n')}\n`);
      return;
    }
    let value = null;
    if (argument === '--only') {
      value = argv[++index];
      if (!value) fail('--only requires a comma-separated section list.');
    } else if (argument.startsWith('--only=')) {
      value = argument.slice('--only='.length);
    } else {
      fail(`Unknown CLI certification argument '${argument}'.`);
    }
    const requested = value
      .split(',')
      .map((section) => section.trim())
      .filter(Boolean);
    if (requested.length === 0) fail('--only requires at least one certification section.');
    onlySections ??= new Set();
    for (const section of requested) {
      if (!sectionNames.includes(section))
        fail(
          `Unknown CLI certification section '${section}'. Available sections: ${sectionNames.join(', ')}`,
        );
      onlySections.add(section);
    }
  }

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
  Object.assign(process.env, {
    NOVELTEA_CLI_CERTIFICATION: '1',
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `certification-${process.pid}-${Date.now()}`,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(tempRoot, 'default-daemon'),
  });
  runNative(['daemon', 'stop']);
  let primaryError = null;
  let cleanupError = null;
  try {
    if (onlySections) {
      let pristine = null;
      const ensurePristine = async () => {
        if (pristine) return pristine;
        pristine = path.join(tempRoot, 'pristine');
        await materializeFixture(pristine);
        await makeShaderFree(pristine);
        return pristine;
      };
      for (const section of onlySections) {
        process.stdout.write(`[certification] section ${section}: START\n`);
        switch (section) {
          case 'differential': {
            ({ pristine } = await runDifferential(tempRoot));
            break;
          }
          case 'bootstrap-island':
            certifyBootstrapOnlyIslandFailures();
            break;
          case 'typed-shaders':
            await certifyTypedShaders(tempRoot);
            break;
          case 'raw-shaderc':
            await certifyRawShaderc(tempRoot);
            break;
          case 'authoring-cache':
            await certifyAuthoringCache(tempRoot, await ensurePristine());
            break;
          case 'daemon-authoring-cache':
            await certifyDaemonAuthoringCacheResidency(tempRoot, await ensurePristine());
            break;
          case 'daemon-authoring-cache-pressure':
            await certifyDaemonAuthoringCachePressure(tempRoot, await ensurePristine());
            break;
          case 'project-owner-scheduling':
            await certifyProjectOwnerScheduling(tempRoot, await ensurePristine());
            break;
          case 'disposable-tests':
            await certifyDisposableTestScheduling(tempRoot);
            break;
          case 'disposable-output':
            await certifyDisposableOutputScheduling(tempRoot);
            break;
          case 'build-protocol-isolation':
            await certifyDaemonBuildProtocolIsolation(tempRoot);
            break;
          case 'authority-mutation':
            await certifyStandaloneAuthorityAndMutationHandling(tempRoot, await ensurePristine());
            break;
          case 'comfyui-owner-isolation':
            await certifyComfyUiDisposableOwnerIsolation(tempRoot, await ensurePristine());
            break;
          case 'resident-daemon':
            await certifyResidentDaemon(tempRoot, await ensurePristine());
            break;
          case 'editor-authoring-cache-sharing':
            certifyEditorAuthoringCacheSharing();
            break;
          case 'performance':
            await certifyPerformanceEnvelope(tempRoot, await ensurePristine());
            break;
          case 'scoped-preparation':
            certifyScopedPreparationLazyBoundaries(await ensurePristine());
            break;
          case 'test-command-parity':
            await certifyTestCommandParity(tempRoot, await ensurePristine());
            break;
          case 'runtime-cache':
            await certifyRuntimeCacheInvalidation(tempRoot, await ensurePristine());
            break;
          case 'native-operations':
            await certifyNativeOperations(tempRoot, await ensurePristine());
            break;
          case 'feature-lab-tests':
            await certifyFeatureLabAuthoredTests(tempRoot);
            break;
          case 'platform-host':
            await certifyPlatformHost(tempRoot, await ensurePristine());
            break;
          case 'comfyui-standalone':
            await certifyComfyUiStandalone(tempRoot, await ensurePristine());
            break;
          case 'relocation':
            await certifyRelocation(tempRoot);
            break;
          default:
            fail(`Unhandled CLI certification section '${section}'.`);
        }
        process.stdout.write(`[certification] section ${section}: PASS\n`);
      }
      process.stdout.write(
        `${JSON.stringify({ success: true, selectedSections: [...onlySections] })}\n`,
      );
      return;
    }

    const { pristine } = await runDifferential(tempRoot);
    certifyBootstrapOnlyIslandFailures();
    await certifyTypedShaders(tempRoot);
    await certifyRawShaderc(tempRoot);
    await certifyAuthoringCache(tempRoot, pristine);
    await certifyDaemonAuthoringCacheResidency(tempRoot, pristine);
    await certifyDaemonAuthoringCachePressure(tempRoot, pristine);
    const residentDaemon = await certifyResidentDaemon(tempRoot, pristine);
    certifyEditorAuthoringCacheSharing();
    const performance = await certifyPerformanceEnvelope(tempRoot, pristine);
    performance.cases.residentDaemon = {
      ...residentDaemon.performanceMs,
      rssBytes: residentDaemon.rssBytes,
    };
    certifyScopedPreparationLazyBoundaries(pristine);
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
        residentDaemonCertification: residentDaemon,
        editorAuthoringCacheSharingCertification: true,
        scopedPreparationCertification: true,
        performance,
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
      runNative(['daemon', 'stop']);
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
