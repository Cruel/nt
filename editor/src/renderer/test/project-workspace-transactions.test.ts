import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  ProjectWorkspaceTransactionService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';

const root = '/project';
const sha256PrefixedUtf8 = (value: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

function workspaceFiles(project = createAuthoringProject({ id: 'transactions', name: 'Before' })) {
  return Object.fromEntries(
    Object.entries(projectWorkspaceFiles(project, project.editor)).map(([file, text]) => [
      `${root}/${file}`,
      text,
    ]),
  );
}

function revisionMap(
  opened: Awaited<ReturnType<ProjectWorkspaceService['open']>>,
): Record<string, `sha256:${string}`> {
  if (!opened.ok) throw new Error('Expected a loaded workspace.');
  return Object.fromEntries(
    Object.entries(opened.snapshot.fileRevisions).map(([file, revision]) => [
      file,
      revision.contentHash,
    ]),
  );
}

function manifestText(options: {
  state: 'prepared' | 'writing' | 'committed' | 'rolled-back';
  before: string;
  after: string;
  completedTargets?: string[];
}) {
  return `${JSON.stringify(
    {
      schema: 'noveltea.workspace.transaction',
      schemaVersion: 1,
      transactionId: 'interrupted',
      state: options.state,
      writerOwnerToken: 'crashed-owner',
      writerPid: 424242,
      operationLabel: 'interrupted test',
      targets: [
        {
          path: 'project.json',
          operation: 'write',
          beforeRevision: sha256PrefixedUtf8(options.before),
          afterRevision: sha256PrefixedUtf8(options.after),
          beforeBlob: 'before/0',
          afterBlob: 'after/0',
        },
      ],
      completedTargets: options.completedTargets ?? [],
    },
    null,
    2,
  )}\n`;
}

function interruptedFiles(
  state: 'prepared' | 'writing' | 'committed' | 'rolled-back',
  actual: 'before' | 'after' | 'unknown',
) {
  const files = workspaceFiles();
  const before = files[`${root}/project.json`]!;
  const parsed = JSON.parse(before) as { project: { name: string } };
  parsed.project.name = 'After';
  const after = `${JSON.stringify(parsed, null, 2)}\n`;
  files[`${root}/project.json`] =
    actual === 'before' ? before : actual === 'after' ? after : `${before} `;
  files[`${root}/.noveltea/transactions/interrupted/manifest.json`] = manifestText({
    state,
    before,
    after,
    completedTargets: actual === 'after' ? ['project.json'] : [],
  });
  files[`${root}/.noveltea/transactions/interrupted/before/0`] = before;
  files[`${root}/.noveltea/transactions/interrupted/after/0`] = after;
  return { files, before, after };
}

describe('workspace granular persistence and transactions', () => {
  it('does not manufacture a writer lock when a clean workspace has nothing to recover', async () => {
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(workspaceFiles());
    const transactions = new ProjectWorkspaceTransactionService(
      fileSystem,
      { isProcessAlive: async () => false },
      7,
    );

    await transactions.recover(root);

    expect(await fileSystem.inspect(`${root}/.noveltea/transactions/.writer-lock`)).toBe('missing');
    expect(await fileSystem.listDirectory(`${root}/.noveltea/transactions`)).toEqual([]);
  });

  it('saves one record after an unrelated record changed externally', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    project.characters.guide = {
      id: 'guide',
      label: 'Guide',
      data: defaultCharacterData('Guide'),
    };
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(workspaceFiles(project));
    const workspace = new ProjectWorkspaceService(fileSystem);
    const baseline = await workspace.open(root);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const externalCharacter = JSON.parse(
      await fileSystem.readText(`${root}/records/characters/guide.json`),
    ) as { label: string };
    externalCharacter.label = 'Externally changed';
    await fileSystem.writeTextAtomic(
      `${root}/records/characters/guide.json`,
      `${JSON.stringify(externalCharacter, null, 2)}\n`,
    );
    const candidate = structuredClone(baseline.snapshot.project);
    candidate.rooms.foyer!.label = 'Locally changed';

    await workspace.write(
      root,
      baseline.snapshot.workspaceRevision,
      candidate,
      baseline.editorState,
      {},
      {
        expectedFileRevisions: revisionMap(baseline),
        targetFiles: baseline.snapshot.saveUnitFileOwnership['record:rooms:foyer']!.files,
        operationLabel: 'save Room foyer',
      },
    );

    const reloaded = await workspace.open(root);
    expect(reloaded.ok && reloaded.snapshot.project.rooms.foyer?.label).toBe('Locally changed');
    expect(reloaded.ok && reloaded.snapshot.project.characters.guide?.label).toBe(
      'Externally changed',
    );
  });

  it('rejects a changed target revision without writing', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(workspaceFiles(project));
    const workspace = new ProjectWorkspaceService(fileSystem);
    const baseline = await workspace.open(root);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const roomPath = `${root}/records/rooms/foyer.json`;
    await fileSystem.writeTextAtomic(roomPath, `${await fileSystem.readText(roomPath)} `);
    const candidate = structuredClone(baseline.snapshot.project);
    candidate.rooms.foyer!.label = 'Local';
    await expect(
      workspace.write(
        root,
        baseline.snapshot.workspaceRevision,
        candidate,
        baseline.editorState,
        {},
        {
          expectedFileRevisions: revisionMap(baseline),
          targetFiles: baseline.snapshot.saveUnitFileOwnership['record:rooms:foyer']!.files,
          operationLabel: 'save Room foyer',
        },
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REVISION_CONFLICT' });
    expect(await fileSystem.readText(roomPath)).not.toContain('"label": "Local"');
  });

  it('rolls every target back when a later atomic replacement fails', async () => {
    class FailingFileSystem extends InMemoryProjectWorkspaceFileSystem {
      private failed = false;
      override async writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void> {
        if (!this.failed && path === `${root}/traits.json`) {
          this.failed = true;
          throw new Error('injected replacement failure');
        }
        await super.writeBytesAtomic(path, bytes);
      }
    }
    const fileSystem = new FailingFileSystem(workspaceFiles());
    const beforeProject = await fileSystem.readText(`${root}/project.json`);
    const beforeTraits = await fileSystem.readText(`${root}/traits.json`);
    const transactions = new ProjectWorkspaceTransactionService(
      fileSystem,
      { isProcessAlive: async () => false },
      7,
    );
    await expect(
      transactions.commit(root, {
        operationLabel: 'two-target failure',
        targets: [
          {
            path: 'project.json',
            operation: 'write',
            expectedRevision: sha256PrefixedUtf8(beforeProject),
            bytes: new TextEncoder().encode(beforeProject.replace('Before', 'Changed')),
          },
          {
            path: 'traits.json',
            operation: 'write',
            expectedRevision: sha256PrefixedUtf8(beforeTraits),
            bytes: new TextEncoder().encode(`${beforeTraits} `),
          },
        ],
      }),
    ).rejects.toThrow('injected replacement failure');
    expect(await fileSystem.readText(`${root}/project.json`)).toBe(beforeProject);
    expect(await fileSystem.readText(`${root}/traits.json`)).toBe(beforeTraits);
    expect(await fileSystem.listDirectory(`${root}/.noveltea/transactions`)).toEqual([]);
  });

  it.each([
    ['prepared', 'after', 'Before'],
    ['writing', 'after', 'Before'],
    ['committed', 'before', 'After'],
    ['rolled-back', 'before', 'Before'],
  ] as const)(
    'recovers a %s journal to the declared coherent state',
    async (state, actual, name) => {
      const fixture = interruptedFiles(state, actual);
      const fileSystem = new InMemoryProjectWorkspaceFileSystem(fixture.files);
      const opened = await new ProjectWorkspaceService(fileSystem).open(root);
      expect(opened.ok && opened.snapshot.project.project.name).toBe(name);
      expect(await fileSystem.inspect(`${root}/.noveltea/transactions/interrupted`)).toBe(
        'missing',
      );
    },
  );

  it('retains an interrupted journal and blocks mutation for an unknown target state', async () => {
    const fixture = interruptedFiles('writing', 'unknown');
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(fixture.files);
    const opened = await new ProjectWorkspaceService(fileSystem).open(root);
    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.diagnostics[0]?.code).toBe(
      'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT',
    );
    expect(await fileSystem.inspect(`${root}/.noveltea/transactions/interrupted`)).toBe(
      'directory',
    );
  });

  it('retains a transaction directory with a missing, malformed, or unsupported manifest', async () => {
    const unsupported = manifestText({
      state: 'prepared',
      before: 'before',
      after: 'after',
    })
      .replace('"schemaVersion": 1', '"schemaVersion": 2')
      .replace('"transactionId": "interrupted"', '"transactionId": "unknown"');
    for (const manifest of [undefined, '{}\n', unsupported]) {
      const files = workspaceFiles();
      files[`${root}/.noveltea/transactions/unknown/staged`] = 'retained';
      if (manifest !== undefined)
        files[`${root}/.noveltea/transactions/unknown/manifest.json`] = manifest;
      const fileSystem = new InMemoryProjectWorkspaceFileSystem(files);
      const opened = await new ProjectWorkspaceService(fileSystem).open(root);
      expect(opened.ok).toBe(false);
      expect(!opened.ok && opened.diagnostics[0]?.code).toBe(
        'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT',
      );
      expect(await fileSystem.inspect(`${root}/.noveltea/transactions/unknown`)).toBe('directory');
    }
  });

  it('fails closed for a live or unverifiable writer lock', async () => {
    for (const alive of [true, null] as const) {
      const files = workspaceFiles();
      files[`${root}/.noveltea/transactions/.writer-lock/owner.json`] = `${JSON.stringify({
        ownerToken: 'live-owner',
        pid: 42,
        operationLabel: 'other writer',
        transactionId: null,
      })}\n`;
      const fileSystem = new InMemoryProjectWorkspaceFileSystem(files);
      const transactions = new ProjectWorkspaceTransactionService(
        fileSystem,
        { isProcessAlive: async () => alive },
        7,
      );
      await expect(transactions.recover(root)).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    }
  });

  it('fails closed when the writer lock owner record is malformed', async () => {
    const files = workspaceFiles();
    files[`${root}/.noveltea/transactions/.writer-lock/owner.json`] = '{}\n';
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files);
    const transactions = new ProjectWorkspaceTransactionService(
      fileSystem,
      { isProcessAlive: async () => false },
      7,
    );
    await expect(transactions.recover(root)).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
  });

  it('recovers a dead owner before reclaiming the writer lock', async () => {
    const fixture = interruptedFiles('writing', 'after');
    fixture.files[`${root}/.noveltea/transactions/.writer-lock/owner.json`] = `${JSON.stringify({
      ownerToken: 'dead-owner',
      pid: 42,
      operationLabel: 'crashed writer',
      transactionId: 'interrupted',
    })}\n`;
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(fixture.files);
    const transactions = new ProjectWorkspaceTransactionService(
      fileSystem,
      { isProcessAlive: async () => false },
      7,
    );
    await transactions.recover(root);
    expect(await fileSystem.readText(`${root}/project.json`)).toBe(fixture.before);
    expect(await fileSystem.inspect(`${root}/.noveltea/transactions/interrupted`)).toBe('missing');
  });

  it('allows exactly one simultaneous stale-lock reclaimer to recover the workspace', async () => {
    const fixture = interruptedFiles('writing', 'after');
    fixture.files[`${root}/.noveltea/transactions/.writer-lock/owner.json`] = `${JSON.stringify({
      ownerToken: 'dead-owner',
      pid: 42,
      operationLabel: 'crashed writer',
      transactionId: 'interrupted',
    })}\n`;

    class RacingReclaimFileSystem extends InMemoryProjectWorkspaceFileSystem {
      private reclaimAttempts = 0;
      private releaseFirst!: () => void;
      private readonly secondReached = new Promise<void>((resolve) => {
        this.releaseFirst = resolve;
      });

      override async movePathAtomic(from: string, to: string): Promise<void> {
        if (
          from === `${root}/.noveltea/transactions/.writer-lock` &&
          to.includes('/.writer-lock.claimed-')
        ) {
          this.reclaimAttempts += 1;
          if (this.reclaimAttempts === 1) await this.secondReached;
          else if (this.reclaimAttempts === 2) this.releaseFirst();
        }
        await super.movePathAtomic(from, to);
      }
    }

    const fileSystem = new RacingReclaimFileSystem(fixture.files);
    let firstId = 0;
    let secondId = 0;
    const first = new ProjectWorkspaceTransactionService(
      fileSystem,
      { isProcessAlive: async () => false },
      7,
      () => `first-${++firstId}`,
    );
    const second = new ProjectWorkspaceTransactionService(
      fileSystem,
      { isProcessAlive: async () => false },
      8,
      () => `second-${++secondId}`,
    );

    const results = await Promise.allSettled([first.recover(root), second.recover(root)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toMatchObject({ code: 'WORKSPACE_BUSY' });
    expect(await fileSystem.readText(`${root}/project.json`)).toBe(fixture.before);
    expect(await fileSystem.listDirectory(`${root}/.noveltea/transactions`)).toEqual([]);
  });
});
