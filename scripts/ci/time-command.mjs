#!/usr/bin/env node
// Measure actual setup/build/link/certification phases instead of estimating from CI job names.
import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The setup-pnpm action exposes pnpm.cmd / pnpm.ps1 on Windows rather than
// an executable named pnpm. Direct spawn('pnpm') fails with ENOENT there;
// use a shell only for known package-manager shims, never arbitrary CI tools.
export function spawnOptions(command, args, platform = process.platform) {
  const shim = platform === 'win32' && ['pnpm', 'npm', 'yarn'].includes(command);
  if (shim && args.some((arg) => /[\r\n&|<>^%]/.test(arg))) {
    throw new Error('Shell metacharacters are forbidden in Windows package-manager arguments');
  }
  return { stdio: 'inherit', shell: shim };
}

async function main() {
  const [, , label, command, ...args] = process.argv;
  if (!label || !/^[a-zA-Z0-9_.:-]+$/.test(label) || !command) {
    throw new Error('Usage: node scripts/ci/time-command.mjs <label> <command> [args...]');
  }
  const started = performance.now();
  const status = await new Promise((resolve, reject) => {
    const process = spawn(command, args, spawnOptions(command, args));
    process.on('error', reject);
    process.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const durationSeconds = Number(((performance.now() - started) / 1000).toFixed(3));
  const record = { label, durationSeconds, exitCode: status.code, signal: status.signal };
  const line = `CI phase timing: ${JSON.stringify(record)}\n`;
  process.stdout.write(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `- ${label}: ${durationSeconds}s; exit: ${status.code ?? status.signal}\n`);
  }
  if (status.signal) process.exitCode = 1;
  else process.exitCode = status.code ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`CI timing wrapper failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
