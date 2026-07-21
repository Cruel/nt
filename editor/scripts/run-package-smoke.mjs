import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { distributionRoot, pathExists } from './editor-distribution-lib.mjs';

async function killProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ESRCH') throw error;
  }
}

async function resolveExecutable() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  for (const pointerName of ['latest-package.json', 'latest-artifact.json']) {
    const pointerPath = path.join(distributionRoot, pointerName);
    if (!(await pathExists(pointerPath))) continue;
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    if (typeof pointer.executable !== 'string') {
      throw new Error(`Invalid package pointer: ${pointerPath}`);
    }
    return pointer.executable;
  }
  throw new Error(
    'Packaged NovelTea Editor not found. Run pnpm -C editor run package or pnpm -C editor run artifact, or pass its executable path.',
  );
}

const executable = await resolveExecutable();
if (!(await pathExists(executable))) {
  throw new Error(`Packaged NovelTea Editor executable not found: ${executable}`);
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'noveltea-editor-package-smoke-'));
const argumentsList = [
  executable,
  '--noveltea-package-smoke',
  `--user-data-dir=${path.join(temporaryRoot, 'user-data')}`,
  '--no-sandbox',
];
const command = process.platform === 'linux' ? 'xvfb-run' : executable;
const commandArguments =
  process.platform === 'linux' ? ['-a', ...argumentsList] : argumentsList.slice(1);
const child = spawn(command, commandArguments, {
  cwd: temporaryRoot,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
  windowsHide: true,
});

let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
  process.stderr.write(chunk);
});

let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  void killProcessTree(child);
}, 45_000);

const { code, signal } = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
});
clearTimeout(timeout);
await rm(temporaryRoot, { recursive: true, force: true });

const marker = 'NOVELTEA_PACKAGE_SMOKE_RESULT=';
const line = output.split(/\r?\n/).find((entry) => entry.startsWith(marker));
if (!line) {
  throw new Error(
    `Package smoke produced no result marker (exit=${code}, signal=${signal ?? 'none'}, timedOut=${timedOut}).`,
  );
}
const result = JSON.parse(line.slice(marker.length));
if (code !== 0 || result.success !== true) {
  throw new Error(`Package smoke failed: ${JSON.stringify(result)}`);
}
console.log(`[package-smoke] ${JSON.stringify(result, null, 2)}`);
