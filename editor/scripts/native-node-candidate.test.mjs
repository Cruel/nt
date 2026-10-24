import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const editor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(editor, 'dist-electron/tools/noveltea.mjs');
const candidateSource = await readFile(entrypoint, 'utf8');
assert.match(candidateSource, /Native CLI candidate requires absolute installed executable/u);

void test('candidate Node tools proxy only to the binary bound to the emitted ScriptC island', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-node-tools-'));
  const cli = path.join(root, 'noveltea');
  const island = path.join(root, 'island.json');
  const proof = path.join(root, 'native-candidate-build.json');
  const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const executable =
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exitCode=4;\n';
  const manifest = '{"version":1,"chunks":{}}\n';
  try {
    await writeFile(cli, executable);
    await chmod(cli, 0o755);
    await writeFile(island, manifest);
    await writeFile(
      proof,
      JSON.stringify({
        contract: 'noveltea.native-cli-candidate-build.v1',
        executableSha256: sha(executable),
        islandProvenanceSha256: sha(manifest),
      }),
    );
    const invoke = (environment) =>
      spawnSync(process.execPath, [entrypoint, '--json', 'entity', 'create'], {
        env: { ...process.env, ...environment },
        encoding: 'utf8',
      });
    const verified = {
      NOVELTEA_NATIVE_CLI_PATH: cli,
      NOVELTEA_NATIVE_CLI_MANIFEST: island,
    };
    const good = invoke(verified);
    assert.equal(good.status, 4, 'must propagate native failure, never substitute success');
    assert.equal(good.stdout.trim(), '["--json","entity","create"]');
    assert.equal(good.stderr, '');

    const missing = invoke({
      NOVELTEA_NATIVE_CLI_PATH: '',
      NOVELTEA_NATIVE_CLI_MANIFEST: '',
    });
    assert.equal(missing.status, 70);
    assert.equal(missing.stdout, '');

    await writeFile(cli, `${executable}\n//changed\n`);
    const tamperedBinary = invoke(verified);
    assert.equal(tamperedBinary.status, 70);
    assert.match(tamperedBinary.stderr, /provenance/u);
    await writeFile(cli, executable);
    await writeFile(island, `${manifest}\n`);
    const tamperedIsland = invoke(verified);
    assert.equal(tamperedIsland.status, 70);
    assert.match(tamperedIsland.stderr, /provenance/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
