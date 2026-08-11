import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  moveProjectAssetFileTransaction,
  readProjectAssetFileRevision,
} from '../../main/services/project-asset-file-transaction';
import {
  PROJECT_WORKSPACE_ABSENT_REVISION,
  ProjectWorkspaceTransactionService,
  type ProjectWorkspaceTransactionRequest,
} from '../../shared/project-workspace/project-workspace-transaction';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('project asset file transactions', () => {
  it('binds a move source revision to the exact bytes captured for the move', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-asset-move-'));
    roots.push(root);
    await mkdir(path.join(root, 'assets'), { recursive: true });
    const sourceBytes = Buffer.from('source-before-race');
    await writeFile(path.join(root, 'assets/source.bin'), sourceBytes);

    let request: ProjectWorkspaceTransactionRequest | undefined;
    vi.spyOn(ProjectWorkspaceTransactionService.prototype, 'commit').mockImplementation(
      async (_projectRoot, value) => {
        request = value;
        return { transactionId: 'test' };
      },
    );

    await moveProjectAssetFileTransaction(
      root,
      'assets/source.bin',
      '.noveltea/trash/assets/source.bin',
      'asset trash',
      PROJECT_WORKSPACE_ABSENT_REVISION,
    );

    const source = request?.targets.find((target) => target.path === 'assets/source.bin');
    const destination = request?.targets.find(
      (target) => target.path === '.noveltea/trash/assets/source.bin',
    );
    expect(source?.expectedRevision).toBe(
      `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`,
    );
    expect(destination?.expectedRevision).toBe(PROJECT_WORKSPACE_ABSENT_REVISION);
    expect(Buffer.from(destination?.bytes ?? [])).toEqual(sourceBytes);
  });

  it('reports the caller-visible revision used to guard intentional replacement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-asset-revision-'));
    roots.push(root);
    await mkdir(path.join(root, 'assets'), { recursive: true });
    const bytes = Buffer.from('existing-content');
    await writeFile(path.join(root, 'assets/existing.bin'), bytes);

    expect(await readProjectAssetFileRevision(root, 'assets/existing.bin')).toBe(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    );
    expect(await readProjectAssetFileRevision(root, 'assets/missing.bin')).toBe(
      PROJECT_WORKSPACE_ABSENT_REVISION,
    );
  });
});
