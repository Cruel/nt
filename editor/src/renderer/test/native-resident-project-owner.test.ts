import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { ProjectWorkspaceFileSystem } from '../../shared/project-workspace/project-workspace-file-system';
import { NativeResidentProjectOwner } from '../../shared/project-workspace/native-resident-project-owner';
import type {
  NativeResidentProjectPreparation,
  ResidentProjectAuthority,
  ResidentProjectAuthorityRequest,
} from '../../shared/project-workspace/resident-project-workspace-service';

const root = '/native-project';
const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const generation = `sha256:${'a'.repeat(64)}`;
const text = 'schema: noveltea.project\nschemaVersion: 1\n';
const project = createAuthoringProject();
const preparation: NativeResidentProjectPreparation = {
  project,
  sourceGeneration: generation,
  sourceRevisions: { 'project.yaml': hash(text) },
  sourceOverlays: {},
  referencedAssetIds: [],
  cliDiagnostics: [],
};
const snapshot = {
  snapshotKind: 'loaded',
  projectRoot: root,
  sourceRevision: generation,
  canonicalSourceFiles: ['project.yaml'],
  fileRevisions: { 'project.yaml': { contentHash: hash(text), byteSize: text.length } },
  project,
};
const portable = () =>
  JSON.stringify({
    identity: { sessionEpoch: 7, generation: 1 },
    snapshot,
    diagnostics: [],
    physicalAuthority: [{ path: 'project.yaml', contentHash: hash(text) }],
    externalAssets: [],
    projectTextSources: {},
    nativePreparation: preparation,
  });

function owner(options: { text?: string; prove?: boolean } = {}) {
  const files = {
    resolvePath: (path: string) => path,
    realpath: async (path: string) => path,
    joinPath: (base: string, item: string) => `${base}/${item}`,
    readBytes: async () => new TextEncoder().encode(options.text ?? text),
  } as unknown as ProjectWorkspaceFileSystem;
  const authority = {
    observe: vi.fn(async (_request: ResidentProjectAuthorityRequest) => ({
      previousAuthority: 'proven' as const,
      unchanged: true,
      fullRescan: false,
      watcherPaths: [],
      delta: { added: [] as string[], changed: [] as string[], removed: [] as string[] },
      manifest: {
        canonicalRoot: root,
        entries: [{ path: 'project.yaml', contentHash: hash(options.text ?? text) }],
      },
    })),
    release: vi.fn(),
    prepareNativeProject: vi.fn(async () => preparation),
    proveNativeProject: vi.fn(async () => options.prove ?? true),
  } satisfies ResidentProjectAuthority;
  return { owner: new NativeResidentProjectOwner(files, authority, 7), authority };
}

describe('native-only resident Project owner', () => {
  it('admits and proves original authored bytes without a TypeScript Workspace reader', async () => {
    const { owner: resident, authority } = owner();
    const admitted = await resident.open(root);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.snapshot.sourceRevision).toBe(generation);
    expect(admitted.snapshot.fileRevisions['project.yaml']?.contentHash).toBe(hash(text));
    expect(await resident.verifyReadAuthority(admitted.snapshot)).toBe(true);
    expect(authority.prepareNativeProject).toHaveBeenCalledOnce();
    expect(resident.residentSessionCount()).toBe(1);
  });

  it('keeps an identical nonempty native observer configuration on repeated and scoped reads', async () => {
    const { owner: resident, authority } = owner();
    expect((await resident.open(root)).ok).toBe(true);
    expect((await resident.open(root)).ok).toBe(true);
    await resident.captureScopedReadAuthority(root, ['/project', '/export']);
    expect(authority.observe).toHaveBeenCalledTimes(3);
    expect(authority.observe.mock.calls[0]?.[0].authoritativePaths).toContain('project.yaml');
    expect(authority.observe.mock.calls[1]?.[0].authoritativePaths).toEqual(
      authority.observe.mock.calls[0]?.[0].authoritativePaths,
    );
    expect(authority.observe.mock.calls[2]?.[0].discoveryScopes).toEqual(
      authority.observe.mock.calls[0]?.[0].discoveryScopes,
    );
  });

  it('settles a completed prior mutation before scoped admission but detects a concurrent one', async () => {
    const { owner: resident, authority } = owner();
    const original = authority.observe.getMockImplementation()!;
    let remainingDeltas = 2;
    authority.observe.mockImplementation(async (request) => {
      const observation = await original(request);
      if (remainingDeltas === 0) return observation;
      remainingDeltas--;
      return {
        ...observation,
        delta: { added: [], changed: ['project.yaml'], removed: [] },
      };
    });
    const scoped = await resident.captureScopedReadAuthority(root, ['/project', '/export']);
    expect(scoped.relevantDeltaPaths).toEqual([]);
    expect(authority.observe).toHaveBeenCalledTimes(3);
    remainingDeltas = 1;
    expect(await resident.verifyScopedReadAuthority(scoped)).toBe(false);
    expect(authority.observe).toHaveBeenCalledTimes(4);
  });

  it('evicts idle physical authority and re-installs a fresh native Project owner', async () => {
    const { owner: resident, authority } = owner();
    expect((await resident.open(root)).ok).toBe(true);
    expect(resident.evictIdleSessions(1, Date.now() + 100_000)).toBe(1);
    expect(authority.release).toHaveBeenCalledOnce();
    expect((await resident.open(root)).ok).toBe(true);
    expect(authority.observe.mock.calls.at(-1)?.[0].authoritativePaths).toContain('project.yaml');
  });

  it('rejects altered source bytes and an unprovable generation instead of caching it', async () => {
    const altered = owner({ text: 'schemaVersion: 900\n' });
    await expect(altered.owner.open(root)).rejects.toThrow('sources changed');
    expect(altered.owner.residentSessionCount()).toBe(0);
    const unproved = owner({ prove: false });
    await expect(unproved.owner.open(root)).rejects.toThrow('sources changed');
    expect(unproved.owner.residentSessionCount()).toBe(0);
    expect(unproved.authority.prepareNativeProject).toHaveBeenCalledTimes(3);
  });

  it('pins a canonical validated portable generation for the disposable only', async () => {
    const { owner: disposable } = owner();
    expect(await disposable.hydratePortableSnapshot(root, portable())).toBe(true);
    expect(await disposable.pinnedPortableInputs(root)).toMatchObject({
      nativePreparation: { sourceGeneration: generation },
    });
    const opened = await disposable.open(root);
    expect(opened.ok).toBe(true);
    expect(
      await disposable.verifyReadAuthority(opened.ok ? opened.snapshot : (snapshot as never)),
    ).toBe(true);
  });

  it('rejects tampered Project generations and source revisions', async () => {
    type PortableTamper = {
      snapshot: {
        sourceRevision: string;
        fileRevisions: Record<string, { contentHash: string }>;
        project: { project: { name: string } };
      };
      nativePreparation: { sourceRevisions: Record<string, string> };
      identity: { generation: number };
      projectTextSources: Record<string, { text: string; contentHash: string }>;
    };
    const changes: Array<(item: PortableTamper) => void> = [
      (item) => {
        item.snapshot.sourceRevision = `sha256:${'b'.repeat(64)}`;
      },
      (item) => {
        item.snapshot.fileRevisions['project.yaml'].contentHash = hash('other');
      },
      (item) => {
        item.snapshot.project.project.name = 'tampered';
      },
      (item) => {
        item.nativePreparation.sourceRevisions['new.yaml'] = hash('new');
      },
      (item) => {
        item.identity.generation = -1;
      },
      (item) => {
        item.projectTextSources['../escape'] = { text, contentHash: hash(text) };
      },
      (item) => {
        item.projectTextSources['project.yaml'] = { text, contentHash: hash('other') };
      },
    ];
    for (const [index, modify] of changes.entries()) {
      const mutated = JSON.parse(portable()) as PortableTamper;
      modify(mutated);
      const { owner: disposable } = owner();
      expect(
        await disposable.hydratePortableSnapshot(root, JSON.stringify(mutated)),
        `alteration ${index}`,
      ).toBe(false);
      expect(disposable.residentSessionCount()).toBe(0);
    }
  });

  it('rejects mismatched owner metadata and does not install a partly rehydrated generation', async () => {
    const { owner: resident } = owner();
    const mismatched = JSON.stringify({
      canonicalRoot: root,
      nativeAssetSourcePaths: ['assets/unexpected.png'],
    });
    expect(await resident.rehydratePortableSnapshot(root, portable(), mismatched)).toBe(false);
    expect(resident.residentSessionCount()).toBe(0);
  });
});
