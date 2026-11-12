import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { distributionRoot, pathExists } from './editor-distribution-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pointerPath = path.join(distributionRoot, 'latest-package.json');
const executable = process.argv[2]
  ? path.resolve(process.argv[2])
  : JSON.parse(await readFile(pointerPath, 'utf8')).executable;
if (!(await pathExists(executable))) {
  throw new Error(`Packaged Electron executable not found: ${executable}`);
}

const scratch = await mkdtemp(path.join(os.tmpdir(), 'noveltea-field-benchmark-'));
const project = path.join(scratch, 'feature-lab');
const marker = 'NOVELTEA_FIELD_BENCHMARK_RESULT=';

async function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

try {
  const fixture = path.join(root, 'tests/projects/feature-lab');
  if (!(await stat(fixture)).isDirectory())
    throw new Error('Feature Lab source fixture not found.');
  await cp(fixture, project, { recursive: true });

  const args = [
    executable,
    '--noveltea-field-benchmark',
    ...(process.platform === 'linux' ? ['--disable-gpu', '--ozone-platform=x11'] : []),
    `--user-data-dir=${path.join(scratch, 'user-data')}`,
    '--no-sandbox',
  ];
  const command = process.platform === 'linux' ? 'dbus-run-session' : executable;
  const commandArgs =
    process.platform === 'linux' ? ['--', 'xvfb-run', '-a', ...args] : args.slice(1);
  const child = spawn(command, commandArgs, {
    cwd: scratch,
    env: {
      ...process.env,
      NOVELTEA_FIELD_BENCHMARK_PROJECT: project,
      NOVELTEA_FIELD_BENCHMARK_PROFILE: path.join(scratch, 'profile'),
      ...(process.platform === 'linux' ? { GDK_BACKEND: 'x11' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output += chunk;
      if (output.length > 1_000_000) output = output.slice(-500_000);
      // Avoid leaking fixture source data or user-owned content in traces.
      if (chunk.includes(marker)) process.stdout.write(chunk);
    });
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void killTree(child);
  }, 120_000);
  let status;
  try {
    status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timeout);
  }
  const { code, signal } = status;
  const line = output.split(/\r?\n/).find((part) => part.startsWith(marker));
  if (!line) {
    throw new Error(
      `Packaged benchmark produced no result (exit=${code}, signal=${signal}, timedOut=${timedOut}).`,
    );
  }
  const report = JSON.parse(line.slice(marker.length));
  if (code !== 0 || !report.success)
    throw new Error(`Packaged benchmark failed: ${JSON.stringify(report)}`);
  console.log('[packaged-field-benchmark]', JSON.stringify(report, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
