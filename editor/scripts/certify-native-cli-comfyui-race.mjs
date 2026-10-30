// #534: native-only installed ComfyUI Asset publication must reject Project
// revisions changed after remote inference began, without partial outputs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertProductionInputs,
  checkProductionJsonCommand,
  isolatedProductionEnvironment,
} from './native-production-qualification.mjs';

if (process.argv.length !== 3)
  throw new Error('Usage: certify-native-cli-comfyui-race.mjs <installed-native-cli>');
const cli = path.resolve(process.argv[2]);
await assertProductionInputs(cli);
const fixtureServer = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'comfyui-certification-server.mjs',
);
const scratch = await mkdtemp(path.join(os.tmpdir(), 'noveltea-534-comfyui-race-'));
const home = path.join(scratch, 'home');
const env = isolatedProductionEnvironment(process.env, home);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runMode(daemon) {
  const suffix = daemon ? 'daemon' : 'local';
  const project = path.join(scratch, suffix);
  const log = path.join(scratch, `${suffix}-http.jsonl`);
  const release = path.join(scratch, `${suffix}-release`);
  const server = spawn(process.execPath, [fixtureServer], {
    cwd: scratch,
    env: {
      ...env,
      NOVELTEA_COMFYUI_CERT_MODE: 'history-gated',
      NOVELTEA_COMFYUI_CERT_LOG: log,
      NOVELTEA_COMFYUI_CERT_RELEASE_MARKER: release,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.setEncoding('utf8').on('data', (text) => {
    stderr += text;
  });
  let child;
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`ComfyUI fixture startup timed out: ${stderr}`)),
        10_000,
      );
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk;
        const number = buffer.split(/\r?\n/u)[0];
        if (!/^\d+$/u.test(number)) return;
        clearTimeout(timeout);
        server.stdout.off('data', onData);
        resolve(Number(number));
      };
      server.stdout.setEncoding('utf8').on('data', onData);
      server.once('error', reject);
      server.once('exit', (code) => reject(new Error(`ComfyUI fixture exited ${code}: ${stderr}`)));
    });
    const create = checkProductionJsonCommand(
      cli,
      ['--no-daemon', '--json', 'project', 'create', project, '--name', 'Asset Race'],
      { env },
    );
    assert.equal(create.success, true, JSON.stringify(create.diagnostics));
    const assets = path.join(project, 'records/assets');
    const assetRecords = () =>
      readdir(assets).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
    const originalAssets = await assetRecords();
    const args = [
      ...(daemon ? [] : ['--no-daemon']),
      '--json',
      '--project',
      project,
      'comfyui',
      'run',
      'flux2-klein-text-to-image',
      '--server',
      `http://127.0.0.1:${port}`,
      '--input',
      'prompt=stale native asset publication',
    ];
    child = spawn(cli, args, { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let cliError = '';
    child.stdout.setEncoding('utf8').on('data', (text) => {
      stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', (text) => {
      cliError += text;
    });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    let reachedHistory = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      const requests = await readFile(log, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      if (requests.includes('"path":"/history/')) {
        reachedHistory = true;
        break;
      }
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    assert.ok(reachedHistory, `ComfyUI job did not reach remote history: ${stdout} ${cliError}`);
    const manifest = path.join(project, 'project.yaml');
    await writeFile(
      manifest,
      `${await readFile(manifest, 'utf8')}\n# edited while remote generation runs\n`,
    );
    await writeFile(release, 'release');
    const completed = await done;
    assert.equal(completed.signal, null);
    assert.equal(completed.code, 4, `Stale native ComfyUI run accepted: ${stdout} ${cliError}`);
    assert.equal(cliError, '', 'JSON completion emitted stderr.');
    const response = JSON.parse(stdout);
    assert.equal(response.success, false);
    assert.ok(
      response.diagnostics.some(
        (item) =>
          item.code === 'COMFYUI_ASSET_PUBLICATION_CONFLICT' ||
          item.code === 'COMFYUI_PUBLICATION_FAILED',
      ),
      `Expected physical source race diagnostic: ${stdout}`,
    );
    assert.deepEqual(await assetRecords(), originalAssets, 'Stale Asset record was published.');
    const generated = path.join(project, 'assets/generated');
    if (existsSync(generated))
      assert.deepEqual(await readdir(generated), [], 'Stale generated Asset bytes were published.');
    console.log(`Native-only ComfyUI ${suffix} source/Asset publication race PASSED.`);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
  }
}

try {
  await mkdir(path.join(home, 'runtime'), { recursive: true, mode: 0o700 });
  await runMode(false);
  await runMode(true);
} finally {
  try {
    checkProductionJsonCommand(cli, ['--json', 'daemon', 'stop'], { env, timeout: 10_000 });
  } catch {
    /* Preserve test failure. */
  }
  await rm(scratch, { recursive: true, force: true });
}
