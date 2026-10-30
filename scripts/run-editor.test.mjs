import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

async function withLauncher(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'noveltea-run-editor-'));
  try {
    await mkdir(path.join(root, 'scripts'));
    await mkdir(path.join(root, 'bin'));
    await copyFile(
      path.join(repositoryRoot, 'scripts', 'run-editor.sh'),
      path.join(root, 'scripts', 'run-editor.sh'),
    );
    for (const [name, body] of Object.entries({
      node: `#!/usr/bin/env bash
printf 'node %s\\n' "$*" >> "$RUN_EDITOR_TEST_EVENTS"
if [ "$RUN_EDITOR_TEST_BUILD_FAIL" = 1 ]; then exit 12; fi
mkdir -p build/native-authoring-host
printf 'addon' > build/native-authoring-host/noveltea-authoring-node.node
`,
      pnpm: `#!/usr/bin/env bash
printf 'pnpm %s | cwd=%s | addon=%s\\n' "$*" "$PWD" "$NOVELTEA_AUTHORING_NODE_ADDON" >> "$RUN_EDITOR_TEST_EVENTS"
`,
    })) {
      const executable = path.join(root, 'bin', name);
      await writeFile(executable, body);
      await chmod(executable, 0o755);
    }
    const events = path.join(root, 'events.log');
    const invoke = (args = [], overrides = {}) =>
      spawnSync('bash', [path.join(root, 'scripts', 'run-editor.sh'), ...args], {
        cwd: tmpdir(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
          NOVELTEA_AUTHORING_NODE_ADDON: '',
          RUN_EDITOR_TEST_EVENTS: events,
          ...overrides,
        },
      });
    await run({ root, events, invoke });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('run-editor prepares the native addon and passes its path to the editor', async () => {
  await withLauncher(async ({ root, events, invoke }) => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    const output = await readFile(events, 'utf8');
    assert.match(output, /node editor\/scripts\/build-native-authoring-addon\.mjs --addon-only/);
    assert.match(output, /pnpm -C editor run dev \| cwd=/);
    assert.ok(
      output.includes(
        `addon=${path.join(root, 'build/native-authoring-host/noveltea-authoring-node.node')}`,
      ),
    );
  });
});

test('run-editor honors an explicitly supplied addon and skip-preview mode', async () => {
  await withLauncher(async ({ root, events, invoke }) => {
    const addon = path.join(root, 'external.node');
    await writeFile(addon, 'addon');
    const result = invoke(['--skip-preview'], { NOVELTEA_AUTHORING_NODE_ADDON: addon });
    assert.equal(result.status, 0, result.stderr);
    const output = await readFile(events, 'utf8');
    assert.doesNotMatch(output, /node /);
    assert.match(output, /pnpm -C editor run dev:skip-preview/);
    assert.ok(output.includes(`addon=${addon}`));
  });
});

test('run-editor rejects a missing explicit addon instead of launching the editor', async () => {
  await withLauncher(async ({ root, events, invoke }) => {
    const addon = path.join(root, 'missing.node');
    const result = invoke([], { NOVELTEA_AUTHORING_NODE_ADDON: addon });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /native Project authoring addon is missing/);
    await assert.rejects(readFile(events, 'utf8'), { code: 'ENOENT' });
  });
});

test('run-editor does not launch the editor when native addon compilation fails', async () => {
  await withLauncher(async ({ events, invoke }) => {
    const result = invoke([], { RUN_EDITOR_TEST_BUILD_FAIL: '1' });
    assert.equal(result.status, 12);
    assert.match(await readFile(events, 'utf8'), /^node /);
    assert.doesNotMatch(await readFile(events, 'utf8'), /pnpm /);
  });
});
