import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  commitOutputPublicationTransaction,
  prepareOutputPublicationTransaction,
  recoverOutputPublicationTransaction,
} from '../../main/services/output-publication-transaction';

const roots: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noveltea-publication-test-'));
  roots.push(root);
  const first = {
    finalPath: path.join(root, 'first.bin'),
    stagedPath: path.join(root, 'first.stage'),
    backupPath: path.join(root, 'first.backup'),
    hadPrevious: true,
  };
  const second = {
    finalPath: path.join(root, 'second.bin'),
    stagedPath: path.join(root, 'second.stage'),
    backupPath: path.join(root, 'second.backup'),
    hadPrevious: true,
  };
  await Promise.all([
    fs.writeFile(first.finalPath, 'first-old'),
    fs.writeFile(first.stagedPath, 'first-new'),
    fs.writeFile(second.finalPath, 'second-old'),
    fs.writeFile(second.stagedPath, 'second-new'),
  ]);
  return {
    root,
    transactionPath: path.join(root, 'publication.json'),
    entries: [first, second],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('output publication transactions', () => {
  it('commits a complete multi-artifact set and removes recovery debris', async () => {
    const value = await fixture();

    await commitOutputPublicationTransaction(value);

    await expect(fs.readFile(value.entries[0]!.finalPath, 'utf8')).resolves.toBe('first-new');
    await expect(fs.readFile(value.entries[1]!.finalPath, 'utf8')).resolves.toBe('second-new');
    await expect(fs.lstat(value.transactionPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(value.entries[0]!.backupPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(value.entries[1]!.backupPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  for (const failure of [
    { step: 'backup', index: 1 },
    { step: 'activate', index: 1 },
    { step: 'accept', index: 2 },
  ])
    it(`restores the previous complete set when ${failure.step} step ${failure.index} fails`, async () => {
      const value = await fixture();

      await expect(
        commitOutputPublicationTransaction({
          ...value,
          beforeStep(step, index) {
            if (step === failure.step && index === failure.index) throw new Error('injected');
          },
        }),
      ).rejects.toThrow('injected');

      await expect(fs.readFile(value.entries[0]!.finalPath, 'utf8')).resolves.toBe('first-old');
      await expect(fs.readFile(value.entries[1]!.finalPath, 'utf8')).resolves.toBe('second-old');
      await expect(fs.lstat(value.transactionPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(value.entries[0]!.backupPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.lstat(value.entries[1]!.backupPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

  it('recovers an abruptly interrupted prepared transaction on the next recovery boundary', async () => {
    const value = await fixture();
    await prepareOutputPublicationTransaction(value);
    await fs.rename(value.entries[0]!.finalPath, value.entries[0]!.backupPath);
    await fs.rename(value.entries[0]!.stagedPath!, value.entries[0]!.finalPath);
    await fs.rename(value.entries[1]!.finalPath, value.entries[1]!.backupPath);

    await expect(recoverOutputPublicationTransaction(value.transactionPath)).resolves.toBe(true);

    await expect(fs.readFile(value.entries[0]!.finalPath, 'utf8')).resolves.toBe('first-old');
    await expect(fs.readFile(value.entries[1]!.finalPath, 'utf8')).resolves.toBe('second-old');
    await expect(fs.lstat(value.transactionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
