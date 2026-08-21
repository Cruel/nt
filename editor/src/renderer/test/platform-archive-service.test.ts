import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { createTarGzArchive, createZipArchive } from '../../main/services/platform-archive-service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-platform-archive-'));
  roots.push(root);
  const sourcePath = path.join(root, 'player');
  fs.writeFileSync(sourcePath, 'player bytes', { mode: 0o644 });
  return {
    root,
    entry: {
      sourcePath,
      archivePath: 'bin/player',
      size: fs.statSync(sourcePath).size,
      mode: 0o755,
    },
  };
}

function tarMode(bytes: Buffer): number {
  return Number.parseInt(bytes.subarray(100, 108).toString('ascii').split('\0', 1)[0]!.trim(), 8);
}

describe('platform archive service', () => {
  it('writes declared POSIX modes into tar.gz independently of host filesystem modes', async () => {
    const { root, entry } = fixture();
    const output = path.join(root, 'game.tar.gz');
    await createTarGzArchive(output, [entry], 'default');
    const tar = gunzipSync(fs.readFileSync(output));
    expect(tar.subarray(0, 100).toString('utf8').split('\0', 1)[0]).toBe('bin/player');
    expect(tarMode(tar)).toBe(0o755);
  });

  it('writes portable ZIPs with UTF-8 names, compression policy, and declared modes', async () => {
    const { root, entry } = fixture();
    const output = path.join(root, 'game.zip');
    await createZipArchive(output, [{ ...entry, archivePath: 'bin/茶-player' }], 'maximum');
    const zip = fs.readFileSync(output);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt16LE(8)).toBe(8);
    const centralOffset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralOffset).toBeGreaterThan(0);
    const externalAttributes = zip.readUInt32LE(centralOffset + 38);
    expect((externalAttributes >>> 16) & 0o777).toBe(0o755);
    const nameLength = zip.readUInt16LE(centralOffset + 28);
    expect(zip.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8')).toBe(
      'bin/茶-player',
    );
  });

  it('uses stored ZIP entries when the profile requests store compression', async () => {
    const { root, entry } = fixture();
    const output = path.join(root, 'game.zip');
    await createZipArchive(output, [entry], 'store');
    expect(fs.readFileSync(output).readUInt16LE(8)).toBe(0);
  });
});
