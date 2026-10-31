import { afterEach, describe, expect, it } from 'vite-plus/test';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeAssetStagingService } from '../../main/services/native-asset-staging-service';

const roots: string[] = [];
const revisionFor = (_bytes: Uint8Array) => `xxh3-128:${'a'.repeat(32)}`;
async function testRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-asset-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native Project file import staging', () => {
  it('retains byte-exact, session-owned publication claims until the native journal commits', async () => {
    const root = await testRoot();
    const service = new NativeAssetStagingService(root, revisionFor);
    const bytes = Buffer.from([0, 255, 42, 0, 9]);
    await service.stage('assets/images/clip.png', bytes);
    const claim = service.publication(['assets/images/clip.png']);
    expect(claim.files).toHaveLength(1);
    expect(claim.files[0]?.sourceRevision).toMatch(/^xxh3-128:[0-9a-f]{32}$/);
    expect(await readFile(path.join(root, claim.files[0]!.stagedRelativePath))).toEqual(bytes);
    await expect(readFile(path.join(root, 'assets/images/clip.png'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(() => service.publication(['assets/images/other.png'])).toThrow(/not staged/);
    expect(() => service.publication(['assets/images/clip.png', 'assets/images/clip.png'])).toThrow(
      /Invalid/,
    );
    await expect(service.stage('assets/images/clip.png', bytes)).rejects.toThrow(/pending/);
    service.committed(['assets/images/clip.png']);
    service.close();
    expect(() => service.publication(['assets/images/clip.png'])).toThrow(/not staged/);
  });

  it('stages supporting files but rejects traversal, unrelated paths and symlinked staging roots', async () => {
    const root = await testRoot();
    const service = new NativeAssetStagingService(root, revisionFor);
    await service.stage('support/licenses/NOTICE.txt', Buffer.from('License'));
    expect(service.publication(['support/licenses/NOTICE.txt']).files).toHaveLength(1);
    const staged = service.publication(['support/licenses/NOTICE.txt']).files[0]!;
    await service.discard(['support/licenses/NOTICE.txt']);
    await expect(readFile(path.join(root, staged.stagedRelativePath))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(() => service.publication(['support/licenses/NOTICE.txt'])).toThrow(/not staged/);
    await expect(service.stage('assets/../project.yaml', Buffer.from('bad'))).rejects.toThrow(
      /Unsafe/,
    );
    await expect(service.stage('records/rooms/hall.yaml', Buffer.from('bad'))).rejects.toThrow(
      /Unsafe/,
    );
    service.close();
    const another = await testRoot();
    await mkdir(path.join(another, '.noveltea'), { recursive: true });
    await symlink(root, path.join(another, '.noveltea/native-asset-import'));
    await expect(
      new NativeAssetStagingService(another, revisionFor).stage('assets/a.bin', Buffer.from('bad')),
    ).rejects.toThrow();
  });

  it('reserves pending paths before awaiting disk writes and rejects imports after closing', async () => {
    const root = await testRoot();
    const service = new NativeAssetStagingService(root, revisionFor);
    const first = service.stage('assets/images/same.png', Buffer.from('one'));
    await expect(service.stage('assets/images/same.png', Buffer.from('two'))).rejects.toThrow(
      /pending/,
    );
    await first;
    expect(service.publication(['assets/images/same.png']).files).toHaveLength(1);
    service.close();
    await expect(service.stage('assets/images/late.png', Buffer.from('late'))).rejects.toThrow(
      /closed/,
    );
  });
});
