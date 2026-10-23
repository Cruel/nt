import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertProductionInputs,
  checkProductionJsonCommand,
  isolatedProductionEnvironment,
  readPortableZipMembers,
} from './native-production-qualification.mjs';

void test('production qualification rejects certification-only routing and missing real binaries', async () => {
  await assert.rejects(
    assertProductionInputs('/unavailable', { NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: '1' }),
    /certification.*environment/i,
  );
  await assert.rejects(assertProductionInputs('/unavailable', {}), /installed CLI/i);
});

void test('production invocation isolates host state and never injects certification flags', async () => {
  const environment = isolatedProductionEnvironment(
    { PATH: '/bin', NOVELTEA_CLI_NO_DAEMON: '1' },
    path.join(os.tmpdir(), 'noveltea-test-home'),
  );
  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.HOME, path.join(os.tmpdir(), 'noveltea-test-home'));
  assert.equal(environment.NOVELTEA_CLI_NO_DAEMON, undefined);
  assert.equal(
    Object.keys(environment).some((key) => key.includes('CERTIFICATION')),
    false,
  );
});

void test('installed public CLI JSON boundary rejects false success and transport violations', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noveltea-522-invocation-'));
  const cli = path.join(directory, 'fake-cli.mjs');
  try {
    await writeFile(
      cli,
      [
        '#!/usr/bin/env node',
        'const mode=process.argv.at(-1);',
        'if(mode==="stderr") process.stderr.write("leaked diagnostic\\n");',
        'if(mode==="bad-json") process.stdout.write("not JSON\\n");',
        'else if(mode==="double") process.stdout.write("{}\\n{}\\n");',
        'else process.stdout.write(JSON.stringify({success:mode!=="failure",exitCode:mode==="failure"?3:0,diagnostics:[],protocolVersion:1})+"\\n");',
        'process.exit(mode==="failure"?3:0);',
      ].join('\n'),
    );
    const run = (mode) =>
      checkProductionJsonCommand(process.execPath, [cli, '--no-daemon', '--json', mode], {
        env: { ...process.env },
        timeout: 20_000,
      });
    assert.equal(run('success').success, true);
    assert.equal(run('failure').exitCode, 3);
    assert.throws(() => run('stderr'), /stderr/i);
    assert.throws(() => run('double'), /JSON/i);
    assert.throws(() => run('bad-json'), /JSON/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('portable ZIP readback checks exact payload sizes and member hashes', () => {
  const payload = Buffer.from('gameplay data');
  const name = Buffer.from('game');
  const local = Buffer.alloc(30 + name.length + payload.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  payload.copy(local, 30 + name.length);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  const zip = Buffer.concat([local, central, end]);
  const decoded = readPortableZipMembers(zip);
  assert.equal(decoded.get('game').equals(payload), true);
  assert.equal(
    `sha256:${createHash('sha256').update(decoded.get('game')).digest('hex')}`,
    `sha256:${createHash('sha256').update(payload).digest('hex')}`,
  );
  const corrupted = Buffer.from(zip);
  corrupted.writeUInt32LE(payload.length + 1, local.length + 24);
  assert.throws(() => readPortableZipMembers(corrupted), /size/i);
});
