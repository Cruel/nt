import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  loadUserExportConfig,
  userExportConfigPath,
} from '../../main/services/user-export-config-service';
import { defaultUserExportConfig } from '../../shared/project-schema/platform-export-contracts';
import { NOVELTEA_USER_CONFIG_FORMAT } from '../../shared/user-config';

const roots: string[] = [];

async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), 'noveltea-export-config-'));
  roots.push(value);
  process.env.NOVELTEA_USER_CONFIG_ROOT = value;
  return value;
}

afterEach(async () => {
  delete process.env.NOVELTEA_USER_CONFIG_ROOT;
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('user export config service', () => {
  it('discards malformed persisted config in memory without rewriting it', async () => {
    await root();
    const file = userExportConfigPath();
    await writeFile(file, '{not-json}\n');

    await expect(loadUserExportConfig()).resolves.toEqual(defaultUserExportConfig());
    await expect(readFile(file, 'utf8')).resolves.toBe('{not-json}\n');
  });

  it('discards wrong top-level user-config version in memory without rewriting it', async () => {
    await root();
    const file = userExportConfigPath();
    const original = `${JSON.stringify({ format: NOVELTEA_USER_CONFIG_FORMAT, formatVersion: 99 })}\n`;
    await writeFile(file, original);

    await expect(loadUserExportConfig()).resolves.toEqual(defaultUserExportConfig());
    await expect(readFile(file, 'utf8')).resolves.toBe(original);
  });

  it('still surfaces genuine filesystem errors', async () => {
    const directory = await root();
    await rm(directory, { recursive: true, force: true });
    await writeFile(directory, 'not-a-directory');

    await expect(loadUserExportConfig()).rejects.toBeDefined();
  });
});
