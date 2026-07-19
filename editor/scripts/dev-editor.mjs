import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

import {
  editorAssetsSourceRoot,
  editorRoot,
  pathExists,
  previewSourceRoot,
  repositoryRoot,
  requiredPreviewFiles,
} from './editor-distribution-lib.mjs';

const argumentsList = process.argv.slice(2);
let buildPreview = false;
let requestedPort = Number(process.env.NOVELTEA_EDITOR_DEV_PORT || 5174);
let smokeTimeout = 0;

for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index];
  if (argument === '--build-preview') {
    buildPreview = true;
  } else if (argument === '--port') {
    requestedPort = Number(argumentsList[++index]);
  } else if (argument === '--smoke-timeout') {
    smokeTimeout = Number(argumentsList[++index]);
  } else {
    throw new Error(`Unknown development coordinator argument: ${argument}`);
  }
}

if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  throw new Error(`Invalid development server port: ${requestedPort}`);
}
if (!Number.isFinite(smokeTimeout) || smokeTimeout < 0) {
  throw new Error(`Invalid smoke timeout: ${smokeTimeout}`);
}

const editorRequire = createRequire(path.join(editorRoot, 'package.json'));
const electronExecutable = editorRequire('electron');
const children = new Map();
let shuttingDown = false;
let exitCode = 0;
let electronChild = null;
let expectedElectronExit = false;
let restartTimer = null;
let restartQueue = Promise.resolve();
let outputPollTimer = null;
let smokeTimer = null;
let packerChild = null;
let packerBuildFailed = false;
let packerRecoveryTimer = null;
let packerRecoveryInFlight = false;
const expectedPackerExits = new WeakSet();
const packerSourceWatchers = [];

function log(label, message) {
  process.stdout.write(`[${label}] ${message}\n`);
}

function logChunk(label, stream, chunk) {
  const target = stream === 'stderr' ? process.stderr : process.stdout;
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.length > 0) target.write(`[${label}] ${line}\n`);
  }
}

function spawnOwned(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? editorRoot,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  children.set(child.pid, { child, label });
  child.stdout?.on('data', (chunk) => logChunk(label, 'stdout', chunk));
  child.stderr?.on('data', (chunk) => logChunk(label, 'stderr', chunk));
  child.once('error', (error) => {
    fail(`${label} failed to start: ${error.message}`);
  });
  child.once('exit', () => {
    if (process.platform === 'win32' || !processGroupExists(child.pid)) {
      children.delete(child.pid);
    }
  });
  return child;
}

function processGroupExists(pid) {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EPERM') return true;
    if (!error || typeof error !== 'object' || error.code !== 'ESRCH') throw error;
    return false;
  }
}

async function killProcessTree(child, signal = 'SIGTERM') {
  if (!child) return;
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
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ESRCH') throw error;
  }
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function stopChild(child) {
  if (!child) return;
  const childWasRunning = child.exitCode === null && child.signalCode === null;
  await killProcessTree(child, 'SIGTERM');
  if (childWasRunning) await waitForExit(child, 3000);
  if (process.platform === 'win32') {
    children.delete(child.pid);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (processGroupExists(child.pid)) {
    await killProcessTree(child, 'SIGKILL');
    const deadline = Date.now() + 1000;
    while (processGroupExists(child.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  children.delete(child.pid);
}

async function shutdown(code = exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  if (restartTimer) clearTimeout(restartTimer);
  if (packerRecoveryTimer) clearTimeout(packerRecoveryTimer);
  if (outputPollTimer) clearInterval(outputPollTimer);
  if (smokeTimer) clearTimeout(smokeTimer);
  for (const watcher of packerSourceWatchers) watcher.close();
  const running = [...children.values()].map(({ child }) => child);
  await Promise.allSettled(running.map((child) => stopChild(child)));
  process.exitCode = exitCode;
}

function fail(message) {
  if (shuttingDown) return;
  process.stderr.write(`[coordinator] ${message}\n`);
  exitCode = 1;
  void shutdown(1);
}

async function choosePort(preferred) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: preferred || 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a renderer development port.'));
        return;
      }
      const selected = address.port;
      server.close((error) => (error ? reject(error) : resolve(selected)));
    });
  });
}

async function waitForHttp(url, child, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Renderer exited before readiness (exit=${child.exitCode}).`);
    }
    const ready = await new Promise((resolve) => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve((response.statusCode ?? 500) < 500);
      });
      request.setTimeout(1000, () => request.destroy());
      request.once('error', () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Renderer readiness timed out at ${url}.`);
}

async function waitForFiles(files, childProvider, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const child = typeof childProvider === 'function' ? childProvider() : childProvider;
    if (
      child &&
      (child.exitCode !== null || child.signalCode !== null) &&
      !expectedPackerExits.has(child)
    ) {
      throw new Error(`Vite+ pack watcher exited before readiness (exit=${child.exitCode}).`);
    }
    if ((await Promise.all(files.map((file) => pathExists(file)))).every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Build output readiness timed out: ${files.join(', ')}`);
}

function observePackerOutput(chunk) {
  const text = chunk.toString();
  if (!/(?:Build failed|\[PARSE_ERROR\])/.test(text)) return;
  if (!packerBuildFailed) {
    log(
      'coordinator',
      'Vite+ pack rebuild failed; keeping the current Electron process until corrected output is available.',
    );
  }
  packerBuildFailed = true;
}

function startPacker() {
  const child = spawnOwned(
    'packer',
    'pnpm',
    ['exec', 'vp', 'pack', '--watch', '--logLevel', 'info'],
    { cwd: editorRoot },
  );
  packerChild = child;
  child.stdout?.on('data', observePackerOutput);
  child.stderr?.on('data', observePackerOutput);
  child.once('exit', (code, signal) => {
    if (shuttingDown || expectedPackerExits.has(child)) return;
    if (packerChild === child) packerChild = null;
    fail(`Packer exited unexpectedly (exit=${code}, signal=${signal ?? 'none'}).`);
  });
  return child;
}

async function restartFailedPacker() {
  if (shuttingDown || !packerBuildFailed || packerRecoveryInFlight) return;
  const previous = packerChild;
  if (!previous) {
    fail('The failed Vite+ pack watcher is unavailable for recovery.');
    return;
  }
  packerRecoveryInFlight = true;
  try {
    log('coordinator', 'Restarting the failed Vite+ pack watcher after a source change.');
    expectedPackerExits.add(previous);
    await stopChild(previous);
    if (shuttingDown) return;
    packerBuildFailed = false;
    startPacker();
  } finally {
    packerRecoveryInFlight = false;
  }
}

function schedulePackerRecovery() {
  if (shuttingDown || !packerBuildFailed) return;
  if (packerRecoveryTimer) clearTimeout(packerRecoveryTimer);
  packerRecoveryTimer = setTimeout(() => {
    packerRecoveryTimer = null;
    void restartFailedPacker();
  }, 150);
}

function startPackerSourceWatchers() {
  for (const target of [path.join(editorRoot, 'src'), path.join(editorRoot, 'scripts')]) {
    const watcher = watch(target, { recursive: true }, schedulePackerRecovery);
    watcher.on('error', (error) => fail(`Packer source watcher failed: ${error.message}`));
    packerSourceWatchers.push(watcher);
  }
  for (const target of [
    path.join(editorRoot, 'package.json'),
    path.join(editorRoot, 'tsconfig.json'),
    path.join(editorRoot, 'vite.config.ts'),
  ]) {
    const watcher = watch(target, schedulePackerRecovery);
    watcher.on('error', (error) => fail(`Packer source watcher failed: ${error.message}`));
    packerSourceWatchers.push(watcher);
  }
}

async function fileFingerprint(target) {
  try {
    const info = await stat(target);
    const contents = await readFile(target);
    return `${info.size}:${createHash('sha256').update(contents).digest('hex')}`;
  } catch {
    return null;
  }
}

function launchElectron(rendererUrl) {
  const childEnvironment = {
    ...process.env,
    NOVELTEA_EDITOR_DEV_SERVER_URL: rendererUrl,
    NOVELTEA_ENGINE_PREVIEW_ROOT: previewSourceRoot,
    NOVELTEA_EDITOR_ASSETS_ROOT: editorAssetsSourceRoot,
  };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  const electronArguments = ['dist-electron/main/main.cjs'];
  if (process.env.NOVELTEA_EDITOR_DEV_DISABLE_GPU === '1') electronArguments.push('--disable-gpu');
  const child = spawnOwned('electron', electronExecutable, electronArguments, {
    cwd: editorRoot,
    env: childEnvironment,
  });
  electronChild = child;
  child.once('exit', (code, signal) => {
    if (electronChild === child) electronChild = null;
    if (shuttingDown) return;
    if (expectedElectronExit) {
      expectedElectronExit = false;
      log(
        'coordinator',
        `Electron restart exit received (exit=${code}, signal=${signal ?? 'none'}).`,
      );
      return;
    }
    if (code === 0) {
      log('coordinator', 'Electron exited normally; stopping development services.');
      void shutdown(0);
    } else {
      fail(`Electron exited unexpectedly (exit=${code}, signal=${signal ?? 'none'}).`);
    }
  });
  return child;
}

function scheduleRestart(reason, rendererUrl) {
  if (shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue.then(async () => {
      if (shuttingDown) return;
      log('coordinator', `Restarting Electron after ${reason} rebuild.`);
      const previous = electronChild;
      if (previous) {
        expectedElectronExit = true;
        await stopChild(previous);
      }
      if (!shuttingDown) launchElectron(rendererUrl);
    });
  }, 350);
}

async function startOutputPolling(rendererUrl, outputFiles) {
  const fingerprints = new Map();
  for (const [kind, target] of outputFiles) fingerprints.set(kind, await fileFingerprint(target));
  let polling = false;
  outputPollTimer = setInterval(() => {
    if (polling || shuttingDown) return;
    polling = true;
    void (async () => {
      const changed = [];
      for (const [kind, target] of outputFiles) {
        const next = await fileFingerprint(target);
        const previous = fingerprints.get(kind);
        if (next && previous && next !== previous) changed.push(kind);
        if (next) fingerprints.set(kind, next);
      }
      if (changed.length > 0) scheduleRestart(changed.join('/'), rendererUrl);
    })()
      .catch((error) => fail(`Output polling failed: ${error.message}`))
      .finally(() => {
        polling = false;
      });
  }, 250);
}

async function main() {
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGHUP', () => void shutdown(0));
  process.on('uncaughtException', (error) => fail(error.stack ?? error.message));
  process.on('unhandledRejection', (error) =>
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error)),
  );

  if (buildPreview) {
    log('preview', 'Building the engine preview.');
    const previewBuilder = spawnOwned('preview', 'pnpm', ['run', 'engine:preview:build'], {
      cwd: editorRoot,
    });
    const previewCode = await new Promise((resolve) => previewBuilder.once('exit', resolve));
    if (previewCode !== 0)
      throw new Error(`Engine-preview build failed with exit code ${previewCode}.`);
  }
  for (const required of requiredPreviewFiles) {
    if (!(await pathExists(path.join(previewSourceRoot, required)))) {
      throw new Error(`Required engine-preview file is missing: ${required}`);
    }
  }

  const mainOutput = path.join(editorRoot, 'dist-electron', 'main', 'main.cjs');
  const preloadOutput = path.join(editorRoot, 'dist-electron', 'preload', 'preload.cjs');
  await rm(path.dirname(mainOutput), { recursive: true, force: true });
  await rm(path.dirname(preloadOutput), { recursive: true, force: true });

  const port = await choosePort(requestedPort);
  const rendererUrl = `http://localhost:${port}`;
  log('coordinator', `Renderer URL: ${rendererUrl}`);
  log('coordinator', `Repository root: ${repositoryRoot}`);

  const renderer = spawnOwned(
    'renderer',
    'pnpm',
    [
      'exec',
      'vp',
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
      '--clearScreen',
      'false',
    ],
    { cwd: editorRoot },
  );
  renderer.once('exit', (code, signal) => {
    if (!shuttingDown)
      fail(`Renderer exited unexpectedly (exit=${code}, signal=${signal ?? 'none'}).`);
  });

  startPacker();
  startPackerSourceWatchers();

  await Promise.all([
    waitForHttp(rendererUrl, renderer),
    waitForFiles([mainOutput, preloadOutput], () => packerChild),
  ]);
  if (shuttingDown) return;
  log('coordinator', 'Renderer, main, preload, and engine-preview readiness gates passed.');
  launchElectron(rendererUrl);
  await startOutputPolling(rendererUrl, [
    ['main', mainOutput],
    ['preload', preloadOutput],
  ]);

  if (smokeTimeout > 0) {
    smokeTimer = setTimeout(() => {
      log('coordinator', `Smoke timeout reached after ${smokeTimeout} ms; shutting down cleanly.`);
      void shutdown(0);
    }, smokeTimeout);
  }
}

main().catch((error) =>
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error)),
);
