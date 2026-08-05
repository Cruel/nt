import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vite-plus/test';

interface CommittedResource {
  contentHash: string;
  byteSize: number;
  physicalPath: string;
  logicalPath: string;
  retainAlphaCoverage?: boolean;
}

interface Harness {
  proposed(document: Record<string, unknown>): number;
  stage(
    message: { applySequence: number },
    document: Record<string, unknown>,
    generation: number,
    signal?: AbortSignal,
  ): Promise<number>;
  state(): {
    projectInstanceId: string;
    generation: number;
  };
}

class MemoryFs {
  readonly nodes = new Map<string, string>();
  failRenameTo: string | null = null;
  private failed = false;

  lstat(target: string): object {
    if (!this.nodes.has(target)) throw new Error(`ENOENT: ${target}`);
    return {};
  }

  mkdir(): void {}

  writeFile(target: string): void {
    this.nodes.set(target, 'bytes');
  }

  symlink(source: string, target: string): void {
    if (this.nodes.has(target)) throw new Error(`EEXIST: ${target}`);
    this.nodes.set(target, source);
  }

  unlink(target: string): void {
    if (!this.nodes.delete(target)) throw new Error(`ENOENT: ${target}`);
  }

  rename(source: string, target: string): void {
    if (this.failRenameTo === target && source.includes('.noveltea-next-') && !this.failed) {
      this.failed = true;
      throw new Error(`injected rename failure: ${target}`);
    }
    const value = this.nodes.get(source);
    if (value === undefined) throw new Error(`ENOENT: ${source}`);
    if (this.nodes.has(target)) throw new Error(`EEXIST: ${target}`);
    this.nodes.delete(source);
    this.nodes.set(target, value);
  }
}

function focusedStageHarness(
  memoryFs: MemoryFs,
  committed: Map<string, CommittedResource>,
  fetchImpl: typeof fetch = async () => {
    throw new Error('unchanged resources must not fetch');
  },
): Harness {
  const widget = fs.readFileSync(path.resolve('../web/widget.html'), 'utf8');
  const proposalStart = widget.indexOf('function proposedFocusedResourceGeneration(');
  const proposalEnd = widget.indexOf(
    '\n    function isFocusedEditorDocumentCommand',
    proposalStart,
  );
  const start = widget.indexOf('async function stageFocusedManifest(');
  const end = widget.indexOf('\n    function collectProjectAssetPaths', start);
  expect(proposalStart).toBeGreaterThanOrEqual(0);
  expect(proposalEnd).toBeGreaterThan(proposalStart);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const proposalImplementation = widget.slice(proposalStart, proposalEnd);
  const implementation = widget.slice(start, end);

  const context = {
    focusedProjectInstanceId: 'project-one',
    focusedCommittedResources: committed,
    focusedApplySequence: 7,
    focusedResourceStageGeneration: 4,
    focusedDocumentLimits: { maxResourceBytes: 128 * 1024 * 1024 },
    moduleFileSystem: () => memoryFs,
    validateFocusedManifest: () => undefined,
    focusedResourceKey: (projectInstanceId: string, entry: { logicalPath: string }) =>
      `${projectInstanceId}|${entry.logicalPath}`,
    readBoundedResponse: async () => new Uint8Array(),
    fetch: fetchImpl,
    projectAssetFetchUrl: (value: string) => value,
    sha256Prefixed: async () => `sha256:${'0'.repeat(64)}`,
    focusedProjectStorageKey: (value: string) => value,
    focusedLogicalRelativePath: (logicalPath: string) =>
      logicalPath.startsWith('project:/') ? logicalPath.slice('project:/'.length) : null,
    ensureFsDirectory: () => undefined,
    fsPathExists: (fileSystem: MemoryFs, target: string) => {
      try {
        fileSystem.lstat(target);
        return true;
      } catch {
        return false;
      }
    },
    proposed: null as Harness['proposed'] | null,
    stage: null as Harness['stage'] | null,
    state: null as Harness['state'] | null,
  };
  vm.runInNewContext(
    `${proposalImplementation}
${implementation}
proposed = proposedFocusedResourceGeneration;
stage = stageFocusedManifest;
state = () => ({
  projectInstanceId: focusedProjectInstanceId,
  generation: focusedResourceStageGeneration,
});`,
    context,
  );
  if (!context.proposed || !context.stage || !context.state)
    throw new Error('Focused staging harness did not load.');
  return { proposed: context.proposed, stage: context.stage, state: context.state };
}

function manifestEntry(name: string, retainAlphaCoverage = false) {
  return {
    resourceId: `asset:${name}`,
    sourceKind: 'authoring-asset',
    assetId: name,
    kind: 'binary',
    usageRoles: [],
    fetchProjectRelativePath: `assets/${name}.bin`,
    logicalPath: `project:/${name}.bin`,
    contentHash: `sha256:${(name === 'a' ? 'a' : 'b').repeat(64)}`,
    byteSize: 1,
    ...(retainAlphaCoverage ? { retainAlphaCoverage: true } : {}),
  };
}

function committedResources() {
  return new Map<string, CommittedResource>([
    [
      'project-one|project:/a.bin',
      {
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteSize: 1,
        physicalPath: '/generation-4/a.bin',
        logicalPath: 'project:/a.bin',
      },
    ],
    [
      'project-one|project:/b.bin',
      {
        contentHash: `sha256:${'b'.repeat(64)}`,
        byteSize: 1,
        physicalPath: '/generation-4/b.bin',
        logicalPath: 'project:/b.bin',
      },
    ],
  ]);
}

function document(resources: unknown[]) {
  return {
    projectInstanceId: 'project-one',
    resources,
  };
}

describe('Phase 7 focused resource publication', () => {
  it('advances the source generation when alpha preparation requirements change', () => {
    const memoryFs = new MemoryFs();
    const committed = committedResources();
    const harness = focusedStageHarness(memoryFs, committed);

    expect(harness.proposed(document([manifestEntry('a'), manifestEntry('b')]))).toBe(4);
    expect(harness.proposed(document([manifestEntry('a', true), manifestEntry('b')]))).toBe(5);
  });

  it('aborts an obsolete resource fetch when a newer focused command supersedes it', async () => {
    const memoryFs = new MemoryFs();
    const committed = committedResources();
    let observedSignal: AbortSignal | undefined;
    const harness = focusedStageHarness(
      memoryFs,
      committed,
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal ?? undefined;
          observedSignal?.addEventListener('abort', () => reject(new Error('fetch aborted')), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();

    const staging = harness.stage(
      { applySequence: 7 },
      document([manifestEntry('c')]),
      5,
      controller.signal,
    );
    await Promise.resolve();
    expect(observedSignal).toBe(controller.signal);

    controller.abort();

    await expect(staging).rejects.toThrow('fetch aborted');
    expect(committed).toEqual(committedResources());
    expect(harness.state()).toEqual({ projectInstanceId: 'project-one', generation: 4 });
  });

  it('rolls every logical link back when a multi-resource publication fails', async () => {
    const memoryFs = new MemoryFs();
    memoryFs.nodes.set('/assets/project/a.bin', '/generation-4/a.bin');
    memoryFs.nodes.set('/assets/project/b.bin', '/generation-4/b.bin');
    memoryFs.failRenameTo = '/assets/project/b.bin';
    const committed = committedResources();
    const harness = focusedStageHarness(memoryFs, committed);

    await expect(
      harness.stage({ applySequence: 7 }, document([manifestEntry('a'), manifestEntry('b')]), 5),
    ).rejects.toThrow('injected rename failure');

    expect(memoryFs.nodes.get('/assets/project/a.bin')).toBe('/generation-4/a.bin');
    expect(memoryFs.nodes.get('/assets/project/b.bin')).toBe('/generation-4/b.bin');
    expect([...memoryFs.nodes.keys()].some((value) => value.includes('.noveltea-'))).toBe(false);
    expect(committed).toEqual(committedResources());
    expect(harness.state()).toEqual({ projectInstanceId: 'project-one', generation: 4 });
  });

  it('publishes an exact committed map and removes resources omitted by the next generation', async () => {
    const memoryFs = new MemoryFs();
    memoryFs.nodes.set('/assets/project/a.bin', '/generation-4/a.bin');
    memoryFs.nodes.set('/assets/project/b.bin', '/generation-4/b.bin');
    const committed = committedResources();
    const harness = focusedStageHarness(memoryFs, committed);

    await expect(
      harness.stage({ applySequence: 7 }, document([manifestEntry('a')]), 5),
    ).resolves.toBe(5);

    expect(memoryFs.nodes.get('/assets/project/a.bin')).toBe('/generation-4/a.bin');
    expect(memoryFs.nodes.has('/assets/project/b.bin')).toBe(false);
    expect([...committed.keys()]).toEqual(['project-one|project:/a.bin']);
    expect(harness.state()).toEqual({ projectInstanceId: 'project-one', generation: 5 });
  });
});
