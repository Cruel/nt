// Native installed ComfyUI HTTP and Asset publication against a deterministic
// fake service. This never loads or runs the TypeScript Project oracle.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertProductionInputs,
  checkProductionJsonCommand,
  isolatedProductionEnvironment,
} from './native-production-qualification.mjs';

if (process.argv.length !== 3)
  throw new Error('Usage: certify-native-cli-comfyui-contracts.mjs <installed-native-cli>');
const cli = path.resolve(process.argv[2]);
await assertProductionInputs(cli);
const editor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-534-comfyui-'));
const environment = isolatedProductionEnvironment(process.env, path.join(root, 'home'));
const logPath = path.join(root, 'requests.jsonl');
const server = spawn(
  process.execPath,
  [path.join(editor, 'scripts/comfyui-certification-server.mjs')],
  {
    env: {
      ...environment,
      NOVELTEA_COMFYUI_CERT_LOG: logPath,
      NOVELTEA_COMFYUI_CERT_MODE: 'success',
    },
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverError = '';
server.stderr.setEncoding('utf8').on('data', (text) => {
  serverError += text;
});

async function serverPort() {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error(`ComfyUI fixture timeout: ${serverError}`)),
      10_000,
    );
    const onData = (text) => {
      output += text;
      const first = output.split(/\r?\n/u)[0];
      if (!/^\d+$/u.test(first)) return;
      clearTimeout(timeout);
      server.stdout.off('data', onData);
      resolve(Number(first));
    };
    server.stdout.setEncoding('utf8').on('data', onData);
    server.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`ComfyUI fixture exited ${code}: ${serverError}`));
    });
  });
}

try {
  await mkdir(path.join(root, 'home/runtime'), { recursive: true, mode: 0o700 });
  const url = `http://127.0.0.1:${await serverPort()}`;
  const invoke = (args, daemon = false, project = null) =>
    checkProductionJsonCommand(
      cli,
      [
        ...(daemon ? [] : ['--no-daemon']),
        '--json',
        ...(project ? ['--project', project] : []),
        'comfyui',
        ...args,
      ],
      { env: environment, timeout: 120_000, cwd: root },
    );
  const success = (value, label) => {
    assert.equal(value.success, true, `${label}: ${JSON.stringify(value.diagnostics)}`);
    return value;
  };
  success(invoke(['status', '--server', url]), 'ComfyUI status');
  success(invoke(['status', '--server', url], true), 'ComfyUI daemon status');
  const list = success(invoke(['workflows']), 'ComfyUI workflow list');
  assert.ok(list.workflows.some((entry) => entry.id === 'flux2-klein-text-to-image'));
  const inspected = success(
    invoke(['workflows', 'flux2-klein-text-to-image']),
    'ComfyUI workflow inspect',
  );
  assert.ok(inspected.workflow || inspected.workflows, 'Missing inspected workflow.');
  success(invoke(['verify', 'flux2-klein-text-to-image', '--server', url]), 'ComfyUI verification');
  const output = path.join(root, 'generated');
  await mkdir(output, { recursive: true });
  success(
    invoke([
      'run',
      'flux2-klein-text-to-image',
      '--server',
      url,
      '--input',
      'prompt=independent native certification',
      '--output',
      `images=${output}`,
    ]),
    'ComfyUI filesystem publication',
  );
  const images = (await readdir(output, { recursive: true })).filter((name) =>
    name.endsWith('.png'),
  );
  assert.ok(images.length, 'ComfyUI run created no image.');
  assert.ok((await stat(path.join(output, images[0]))).size > 50, 'ComfyUI image was empty.');

  const project = path.join(root, 'project');
  success(
    checkProductionJsonCommand(
      cli,
      ['--no-daemon', '--json', 'project', 'create', project, '--name', 'Native Comfy Fixture'],
      { env: environment },
    ),
    'ComfyUI Project create',
  );
  success(
    invoke(
      [
        'run',
        'flux2-klein-text-to-image',
        '--server',
        url,
        '--input',
        'prompt=native asset admission',
      ],
      true,
      project,
    ),
    'Native ComfyUI Asset commit',
  );
  const assets = (await readdir(path.join(project, 'records/assets'))).filter((name) =>
    name.endsWith('.yaml'),
  );
  assert.ok(assets.length, 'ComfyUI did not publish a tracked Asset.');
  assert.match(await readFile(path.join(project, 'records/assets', assets[0]), 'utf8'), /id:/);
  const rejected = invoke([
    'run',
    'missing-workflow',
    '--server',
    url,
    '--output',
    `images=${path.join(root, 'rejected')}`,
  ]);
  assert.equal(rejected.success, false);
  assert.ok(rejected.diagnostics.some((item) => item.severity === 'error' && item.code));
  const requests = (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const endpoint of ['/system_stats', '/object_info', '/prompt'])
    assert.ok(
      requests.some((entry) => entry.path === endpoint),
      `Missing HTTP request ${endpoint}.`,
    );
  console.log(
    'Native-only ComfyUI status, verify, workflow run, Asset/filesystem publication and negatives PASSED.',
  );
} finally {
  try {
    spawnSync(cli, ['--json', 'daemon', 'stop'], { env: environment, timeout: 10_000 });
  } catch {
    /* Preserve primary failure. */
  }
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  await rm(root, { recursive: true, force: true });
}
