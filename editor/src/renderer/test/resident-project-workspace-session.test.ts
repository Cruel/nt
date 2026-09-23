import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { cloneAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
  PROJECT_WORKSPACE_ABSENT_REVISION,
  utf8WorkspaceTransactionTarget,
} from '../../shared/project-workspace';
import { ResidentProjectWorkspaceSession } from '../../shared/project-workspace/resident-project-workspace-session';
import {
  ResidentProjectWorkspaceService,
  type ResidentProjectAuthority,
  type ResidentProjectAuthorityObservation,
} from '../../shared/project-workspace/resident-project-workspace-service';

const ROOT = '/projects/resident-session';

const sha256PrefixedUtf8 = (value: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

function createProjectAuthorityProbe() {
  let tracked = false;
  let pending = { added: [] as string[], changed: [] as string[], removed: [] as string[] };
  let beforeObserve: ((count: number) => void | Promise<void>) | null = null;
  let observationCount = 0;
  const observations: Array<Readonly<{ added: string[]; changed: string[]; removed: string[] }>> =
    [];
  const requests: Array<readonly string[] | null> = [];
  let configuredPaths: readonly string[] | null = null;
  let manifestEntries: ResidentProjectAuthorityObservation['manifest']['entries'] = [];
  const authority: ResidentProjectAuthority = {
    async observe(request) {
      observationCount += 1;
      await beforeObserve?.(observationCount);
      if (request.authoritativePaths) configuredPaths = [...request.authoritativePaths];
      else if (!configuredPaths)
        throw new Error('Project authority observation was not configured before reuse.');
      requests.push(request.authoritativePaths ? [...request.authoritativePaths] : null);
      const delta = {
        added: [...pending.added].sort(),
        changed: [...pending.changed].sort(),
        removed: [...pending.removed].sort(),
      };
      pending = { added: [], changed: [], removed: [] };
      observations.push(delta);
      const dirty = delta.added.length > 0 || delta.changed.length > 0 || delta.removed.length > 0;
      const previousAuthority = tracked ? (dirty ? 'dirty' : 'proven') : 'untracked';
      const unchanged = tracked && !dirty;
      tracked = true;
      return {
        previousAuthority,
        unchanged,
        fullRescan: previousAuthority === 'untracked',
        watcherPaths: [...new Set([...delta.added, ...delta.changed, ...delta.removed])].sort(),
        delta,
        manifest: { canonicalRoot: request.projectRoot, entries: manifestEntries },
      };
    },
    async release() {},
  };
  return {
    authority,
    observations,
    requests,
    change(...paths: string[]) {
      pending.changed.push(...paths);
    },
    add(...paths: string[]) {
      pending.added.push(...paths);
    },
    remove(...paths: string[]) {
      pending.removed.push(...paths);
    },
    beforeObserve(callback: ((count: number) => void | Promise<void>) | null) {
      beforeObserve = callback;
    },
    setManifestEntries(entries: ResidentProjectAuthorityObservation['manifest']['entries']) {
      manifestEntries = entries;
    },
  };
}

function trackSemanticTransactionWrites(
  fileSystem: InMemoryProjectWorkspaceFileSystem,
  probe: ReturnType<typeof createProjectAuthorityProbe>,
) {
  const relativeSemanticPath = (value: string) => {
    const absolute = fileSystem.resolvePath(value);
    if (!absolute.startsWith(`${ROOT}/`)) return null;
    const relative = absolute.slice(ROOT.length + 1);
    return relative === 'project.json' ||
      relative === 'editor.json' ||
      relative === 'traits.json' ||
      /^records\/[^/]+\/.+\.(?:json|lua|rml|rcss)$/u.test(relative) ||
      /^scripts\/.+\.lua$/u.test(relative) ||
      /^i18n\/.+\.json$/u.test(relative)
      ? relative
      : null;
  };
  const originalWrite = fileSystem.writeBytesAtomic.bind(fileSystem);
  fileSystem.writeBytesAtomic = async (value, bytes) => {
    const relative = relativeSemanticPath(value);
    const existed = relative ? (await fileSystem.inspect(value)) === 'file' : false;
    await originalWrite(value, bytes);
    if (relative) {
      if (existed) probe.change(relative);
      else probe.add(relative);
    }
  };
  const originalRemove = fileSystem.removeFile.bind(fileSystem);
  fileSystem.removeFile = async (value) => {
    const relative = relativeSemanticPath(value);
    const existed = relative ? (await fileSystem.inspect(value)) === 'file' : false;
    await originalRemove(value);
    if (relative && existed) probe.remove(relative);
  };
}

async function createNativeAssetWorkspace() {
  const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
  project.assets.image = {
    id: 'image',
    label: 'Image',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/original.png' },
      aliases: [],
      sampling: 'linear',
      byteSize: 1,
      contentHash: `sha256:${'a'.repeat(64)}`,
      imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
    },
  };
  const files = Object.fromEntries(
    Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
      `${ROOT}/${relativePath}`,
      text,
    ]),
  );
  files[`${ROOT}/assets/original.png`] = 'a';
  const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
  const probe = createProjectAuthorityProbe();
  const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
  const first = await workspace.open(ROOT);
  if (!first.ok) throw new Error('Initial Project open failed.');
  return { project, fileSystem, probe, workspace, first };
}

async function createResidentSession() {
  const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
  project.rooms.foyer = {
    id: 'foyer',
    label: 'Foyer',
    data: defaultRoomData('Foyer'),
  };
  const files = Object.fromEntries(
    Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
      `${ROOT}/${relativePath}`,
      text,
    ]),
  );
  const fileSystem = new InMemoryProjectWorkspaceFileSystem(files);
  const opened = await new ProjectWorkspaceService(fileSystem).open(ROOT);
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error(opened.diagnostics[0]?.message ?? 'Project open failed.');
  const session = ResidentProjectWorkspaceSession.fromOpenedWithHost(opened, { fileSystem });
  return { fileSystem, project, session };
}

describe('ResidentProjectWorkspaceSession', () => {
  it('uses native Project authority deltas for change-proportional reconciliation', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    for (let index = 0; index < 320; index += 1) {
      const id = `room-${String(index).padStart(3, '0')}`;
      project.rooms[id] = { id, label: `Room ${index}`, data: defaultRoomData(`Room ${index}`) };
    }
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');
    await workspace.buildDependencyGraphAnalysis(first.snapshot);

    let metadataReads = 0;
    let byteReads = 0;
    const originalMetadata = fileSystem.readPathMetadata!.bind(fileSystem);
    const originalBytes = fileSystem.readBytes.bind(fileSystem);
    Object.defineProperty(fileSystem, 'readPathMetadata', {
      configurable: true,
      value: async (value: string) => {
        metadataReads += 1;
        return originalMetadata(value);
      },
    });
    fileSystem.readBytes = async (value) => {
      byteReads += 1;
      return originalBytes(value);
    };

    const changed = structuredClone(project);
    changed.rooms['room-137']!.label = 'Only This Room Changed';
    const relativePath = 'records/rooms/room-137.json';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${relativePath}`,
      projectWorkspaceFiles(changed, changed.editor)[relativePath]!,
    );
    probe.change(relativePath);

    const second = await workspace.open(ROOT);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('Incremental Project reopen failed.');
    expect(second.snapshot.project.rooms['room-137']!.label).toBe('Only This Room Changed');
    expect(second.snapshot.project.rooms['room-138']).toBe(
      first.snapshot.project.rooms['room-138'],
    );
    expect(second.snapshot.canonicalSourceFiles).toBe(first.snapshot.canonicalSourceFiles);
    expect(second.snapshot.scriptSourcePaths).toBe(first.snapshot.scriptSourcePaths);
    expect(await workspace.verifyReadAuthority(first.snapshot)).toBe(false);
    expect(await workspace.verifyReadAuthority(second.snapshot)).toBe(true);
    expect(byteReads).toBe(1);
    expect(metadataReads).toBeLessThan(12);
    expect(second.sourceWork).toMatchObject({
      authoredFilesReread: 1,
      parsedJsonSources: 1,
      readTextSources: 0,
      fullProjectTraversals: 0,
      fullProjectProjections: 0,
      foregroundSerializations: 0,
      localizationCoverageInputsChanged: false,
    });
    expect(probe.observations.some((delta) => delta.changed.includes(relativePath))).toBe(true);
    const cloned = cloneAuthoringProject(second.snapshot.project);
    expect(cloned.rooms['room-137']!.label).toBe('Only This Room Changed');
    expect(cloned.rooms['room-138']!.label).toBe('Room 138');
    expect(second.validationWork.executed).toBeLessThan(16);
    expect(second.validationWork.reused).toBeGreaterThan(600);
    const dependency = await workspace.buildDependencyGraphAnalysis(second.snapshot);
    expect(dependency.work.derivedContributions).toBeLessThan(8);
    expect(dependency.work.analyzedOwners).toBeLessThan(8);
    expect(dependency.work.reusedContributions).toBeGreaterThan(300);
    expect(dependency.work.fullProjectTraversals).toBe(0);
    expect(byteReads).toBe(1);

    const localizable = cloneAuthoringProject(second.snapshot.project);
    localizable.rooms['room-137']!.data.displayName = 'Changed Localizable Room';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${relativePath}`,
      projectWorkspaceFiles(localizable, localizable.editor)[relativePath]!,
    );
    probe.change(relativePath);
    const third = await workspace.open(ROOT);
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error('Localizable Project reopen failed.');
    expect(third.sourceWork.localizationCoverageInputsChanged).toBe(true);
  }, 15_000);

  it('keeps localization coverage dependency identity advanced across a later presentation edit', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    if (!first.ok) throw new Error('Initial Project open failed.');

    const relativePath = 'records/rooms/foyer.json';
    const semanticEdit = cloneAuthoringProject(project);
    semanticEdit.rooms.foyer.data.displayName = 'Coverage Relevant';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${relativePath}`,
      projectWorkspaceFiles(semanticEdit, semanticEdit.editor)[relativePath]!,
    );
    probe.change(relativePath);
    const second = await workspace.open(ROOT);
    if (!second.ok) throw new Error('Coverage-relevant reconciliation failed.');
    expect(second.sourceWork.localizationCoverageInputsChanged).toBe(true);
    expect(second.sourceWork.localizationCoverageDependencyRevision).not.toBe(
      first.sourceWork.localizationCoverageDependencyRevision,
    );

    const presentationEdit = cloneAuthoringProject(second.snapshot.project);
    presentationEdit.rooms.foyer.label = 'Presentation Only';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${relativePath}`,
      projectWorkspaceFiles(presentationEdit, presentationEdit.editor)[relativePath]!,
    );
    probe.change(relativePath);
    const third = await workspace.open(ROOT);
    if (!third.ok) throw new Error('Presentation-only reconciliation failed.');
    expect(third.sourceWork.localizationCoverageInputsChanged).toBe(false);
    expect(third.sourceWork.localizationCoverageDependencyRevision).toBe(
      second.sourceWork.localizationCoverageDependencyRevision,
    );
  });

  it('does not enumerate the Asset registry for an unrelated native freshness check', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    for (let index = 0; index < 640; index += 1) {
      const id = `image-${String(index).padStart(3, '0')}`;
      project.assets[id] = {
        id,
        label: `Image ${index}`,
        data: {
          kind: 'image',
          source: { type: 'project-file', path: `assets/${id}.png` },
          aliases: [],
          sampling: 'linear',
          byteSize: 1,
          contentHash: `sha256:${'a'.repeat(64)}`,
          imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
        },
      };
    }
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');

    const roomPath = 'records/rooms/foyer.json';
    const persistedRoom = JSON.parse(files[`${ROOT}/${roomPath}`]!) as Record<string, unknown>;
    persistedRoom.label = 'Changed Foyer';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${roomPath}`,
      `${JSON.stringify(persistedRoom, null, 2)}\n`,
    );
    probe.change(roomPath);

    const assetRegistry = first.snapshot.project.assets;
    const originalObjectValues = Object.values;
    Object.values = ((value: object) => {
      if (value === assetRegistry)
        throw new Error('Unrelated resident freshness check enumerated the Asset registry.');
      return originalObjectValues(value);
    }) as typeof Object.values;
    let second;
    try {
      second = await workspace.open(ROOT);
    } finally {
      Object.values = originalObjectValues;
    }
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('Incremental Project reopen failed.');
    expect(second.sourceWork.fullProjectTraversals).toBe(0);
    expect(probe.requests.at(-1)).toBeNull();
    expect(
      probe.requests.findLast((request): request is readonly string[] => request !== null),
    ).toEqual(
      expect.arrayContaining([
        'project.json',
        'editor.json',
        'traits.json',
        'assets/image-000.png',
      ]),
    );

    const changedAsset = cloneAuthoringProject(second.snapshot.project);
    changedAsset.assets['image-000']!.data.source.path = 'assets/replaced.png';
    const assetRecordPath = 'records/assets/image-000.json';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${assetRecordPath}`,
      projectWorkspaceFiles(changedAsset, changedAsset.editor)[assetRecordPath]!,
    );
    probe.change(assetRecordPath);
    const third = await workspace.open(ROOT);
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error('Asset source-path reconciliation failed.');
    expect(probe.requests.at(-1)).toContain('assets/replaced.png');
    expect(probe.requests.at(-1)).not.toContain('assets/image-000.png');

    probe.change('assets/image-319.png');
    expect(await workspace.verifyReadAuthority(third.snapshot)).toBe(false);
    const fourth = await workspace.open(ROOT);
    expect(fourth.ok).toBe(true);
    if (!fourth.ok) throw new Error('External Asset authority reconciliation failed.');
    expect(fourth.sourceWork.authoredFilesReread).toBe(third.sourceWork.authoredFilesReread);
    expect(probe.requests.at(-1)).toBeNull();
  });

  it('refreshes native authority after adopting a committed Asset relocation', async () => {
    const { project, fileSystem, probe, workspace, first } = await createNativeAssetWorkspace();
    trackSemanticTransactionWrites(fileSystem, probe);
    const changed = cloneAuthoringProject(project);
    changed.assets.image.data.source.path = 'assets/replaced.png';
    const original = await fileSystem.readFileRevision(`${ROOT}/assets/original.png`);
    const written = await workspace.write(
      ROOT,
      first.snapshot.workspaceRevision,
      changed,
      changed.editor,
      {},
      {
        affectedPaths: ['/assets/image'],
        extraTargets: [
          {
            path: 'assets/original.png',
            operation: 'delete',
            expectedRevision: original.contentHash,
          },
          utf8WorkspaceTransactionTarget(
            'assets/replaced.png',
            PROJECT_WORKSPACE_ABSENT_REVISION,
            'a',
          ),
        ],
      },
    );
    expect(await workspace.hasResidentSession(ROOT)).toBe(true);
    expect(probe.requests.at(-1)).toEqual([
      'project.json',
      'editor.json',
      'traits.json',
      'assets/replaced.png',
    ]);
    expect(await workspace.verifyReadAuthority(first.snapshot)).toBe(false);
    const requestCount = probe.requests.length;
    const reopened = await workspace.open(ROOT);
    if (!reopened.ok) throw new Error('Committed Project reopen failed.');
    expect(reopened.snapshot.workspaceRevision).toBe(written.workspaceRevision);
    expect(probe.requests.slice(requestCount)).toEqual([null]);
    expect(await workspace.verifyReadAuthority(reopened.snapshot)).toBe(true);
    expect(probe.requests.at(-1)).toBeNull();
  });

  it('recovers an interrupted transaction without regressing the resident generation', async () => {
    const { fileSystem, probe, workspace } = await createNativeAssetWorkspace();
    const beforeIdentity = await workspace.residentGenerationIdentity(ROOT);
    const target = 'records/assets/image.json';
    const absolute = `${ROOT}/${target}`;
    const before = await fileSystem.readText(absolute);
    const changed = JSON.parse(before) as { label: string };
    changed.label = 'Interrupted Image';
    const after = `${JSON.stringify(changed, null, 2)}\n`;
    const transactionRoot = `${ROOT}/.noveltea/transactions/interrupted`;
    await fileSystem.createDirectory(`${transactionRoot}/before`);
    await fileSystem.createDirectory(`${transactionRoot}/after`);
    await fileSystem.writeTextAtomic(`${transactionRoot}/before/0`, before);
    await fileSystem.writeTextAtomic(`${transactionRoot}/after/0`, after);
    await fileSystem.writeTextAtomic(absolute, after);
    await fileSystem.writeTextAtomic(
      `${transactionRoot}/manifest.json`,
      `${JSON.stringify(
        {
          schema: 'noveltea.workspace.transaction',
          schemaVersion: 1,
          transactionId: 'interrupted',
          state: 'writing',
          writerOwnerToken: 'crashed-owner',
          writerPid: 2147483647,
          operationLabel: 'interrupted resident test',
          targets: [
            {
              path: target,
              operation: 'write',
              beforeRevision: sha256PrefixedUtf8(before),
              afterRevision: sha256PrefixedUtf8(after),
              beforeBlob: 'before/0',
              afterBlob: 'after/0',
            },
          ],
          completedTargets: [target],
        },
        null,
        2,
      )}\n`,
    );
    probe.change(target);

    const reopened = await workspace.open(ROOT);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('Recovered Project reopen failed.');
    expect(reopened.snapshot.project.assets.image.label).toBe('Image');
    expect(await fileSystem.readText(absolute)).toBe(before);
    expect(await fileSystem.inspect(transactionRoot)).toBe('missing');
    expect(await workspace.residentGenerationIdentity(ROOT)).toEqual({
      sessionEpoch: beforeIdentity?.sessionEpoch,
      generation: (beforeIdentity?.generation ?? 0) + 1,
    });
  });

  it('re-admits an opaque write without regressing the resident generation', async () => {
    const { workspace } = await createNativeAssetWorkspace();
    const beforeIdentity = await workspace.residentGenerationIdentity(ROOT);

    await workspace.reconcileAfterOpaqueWrite(ROOT);

    expect(await workspace.residentGenerationIdentity(ROOT)).toEqual({
      sessionEpoch: beforeIdentity?.sessionEpoch,
      generation: (beforeIdentity?.generation ?? 0) + 1,
    });
  });

  it('rejects a committed Asset payload that changes before native promotion', async () => {
    const { project, fileSystem, probe, workspace, first } = await createNativeAssetWorkspace();
    trackSemanticTransactionWrites(fileSystem, probe);
    const changed = cloneAuthoringProject(project);
    changed.assets.image.data.source.path = 'assets/replaced.png';
    const original = await fileSystem.readFileRevision(`${ROOT}/assets/original.png`);
    const replacedPath = `${ROOT}/assets/replaced.png`;
    const originalWrite = fileSystem.writeBytesAtomic.bind(fileSystem);
    let replacedOnce = false;
    fileSystem.writeBytesAtomic = async (value, bytes) => {
      await originalWrite(value, bytes);
      if (!replacedOnce && fileSystem.resolvePath(value) === replacedPath) {
        replacedOnce = true;
        await originalWrite(value, new TextEncoder().encode('external replacement'));
        probe.change('assets/replaced.png');
      }
    };

    await expect(
      workspace.write(
        ROOT,
        first.snapshot.workspaceRevision,
        changed,
        changed.editor,
        {},
        {
          affectedPaths: ['/assets/image'],
          extraTargets: [
            {
              path: 'assets/original.png',
              operation: 'delete',
              expectedRevision: original.contentHash,
            },
            utf8WorkspaceTransactionTarget(
              'assets/replaced.png',
              PROJECT_WORKSPACE_ABSENT_REVISION,
              'a',
            ),
          ],
        },
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REVISION_CONFLICT' });
    expect(replacedOnce).toBe(true);
    expect(await workspace.hasResidentSession(ROOT)).toBe(true);
    expect(await fileSystem.readText(replacedPath)).toBe('external replacement');
  });

  it('rebuilds validation membership when committed transactions add and remove records', async () => {
    const { project, fileSystem, probe, workspace, first } = await createNativeAssetWorkspace();
    trackSemanticTransactionWrites(fileSystem, probe);
    const changed = cloneAuthoringProject(project);
    changed.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      data: defaultRoomData('Hall'),
      archetype: { $ref: { collection: 'archetypes', id: 'missing' } },
    };
    await workspace.write(ROOT, first.snapshot.workspaceRevision, changed, changed.editor);
    const added = await workspace.open(ROOT);
    if (!added.ok) throw new Error('Committed record addition failed.');
    expect(
      added.diagnostics.some((diagnostic) => diagnostic.path === '/rooms/hall/archetype'),
    ).toBe(true);
    delete changed.rooms.hall;
    await workspace.write(ROOT, added.snapshot.workspaceRevision, changed, changed.editor);
    const removed = await workspace.open(ROOT);
    if (!removed.ok) throw new Error('Committed record removal failed.');
    expect(
      removed.diagnostics.some((diagnostic) => diagnostic.path?.startsWith('/rooms/hall/')),
    ).toBe(false);
    expect(
      removed.validationContributions.some((contribution) =>
        contribution.key.endsWith(':rooms:hall'),
      ),
    ).toBe(false);
  });

  it('admits a mutation candidate before publishing its transaction', async () => {
    const { project, fileSystem, probe, workspace, first } = await createNativeAssetWorkspace();
    trackSemanticTransactionWrites(fileSystem, probe);
    await workspace.buildDependencyGraphAnalysis(first.snapshot);
    const changed = cloneAuthoringProject(project);
    changed.assets.image.label = 'Changed Image';
    const recordPath = 'records/assets/image.json';
    const beforeText = await fileSystem.readText(`${ROOT}/${recordPath}`);
    let admitted = false;

    await workspace.write(
      ROOT,
      first.snapshot.workspaceRevision,
      changed,
      changed.editor,
      {},
      {
        affectedPaths: ['/assets/image'],
        admitCandidateBeforeCommit: async (snapshot) => {
          admitted = true;
          expect(snapshot.project.assets.image.label).toBe('Changed Image');
          expect(await fileSystem.readText(`${ROOT}/${recordPath}`)).toBe(beforeText);
        },
      },
    );

    expect(admitted).toBe(true);
    const reopened = await workspace.open(ROOT);
    if (!reopened.ok) throw new Error('Committed candidate did not remain resident.');
    expect(reopened.snapshot.project.assets.image.label).toBe('Changed Image');
    expect(reopened.sourceWork).toMatchObject({
      authoredFilesReread: 0,
      parsedJsonSources: 1,
      projectedJsonSources: 1,
      fullProjectTraversals: 0,
      fullProjectProjections: 0,
      foregroundSerializations: 0,
      foregroundSerializedBytes: 0,
    });
    const dependency = await workspace.buildDependencyGraphAnalysis(reopened.snapshot);
    expect(dependency.work.fullProjectTraversals).toBe(0);
    expect(dependency.work.derivedContributions).toBeLessThan(8);
  });

  it('does not promote a candidate when the transactional write fails', async () => {
    const { project, fileSystem, probe, workspace, first } = await createNativeAssetWorkspace();
    trackSemanticTransactionWrites(fileSystem, probe);
    const changed = cloneAuthoringProject(project);
    changed.assets.image.label = 'Should Not Commit';
    const recordPath = 'records/assets/image.json';
    const originalWrite = fileSystem.writeBytesAtomic.bind(fileSystem);
    let failed = false;
    fileSystem.writeBytesAtomic = async (value, bytes) => {
      if (!failed && fileSystem.resolvePath(value) === `${ROOT}/${recordPath}`) {
        failed = true;
        throw new Error('injected Project write failure');
      }
      return originalWrite(value, bytes);
    };

    await expect(
      workspace.write(
        ROOT,
        first.snapshot.workspaceRevision,
        changed,
        changed.editor,
        {},
        {
          affectedPaths: ['/assets/image'],
        },
      ),
    ).rejects.toThrow('injected Project write failure');
    expect(failed).toBe(true);
    expect(await workspace.hasResidentSession(ROOT)).toBe(true);

    const reopened = await workspace.open(ROOT);
    if (!reopened.ok) throw new Error('Coherent generation did not survive failed write.');
    expect(reopened.snapshot.project.assets.image.label).toBe(project.assets.image.label);
  });

  it('retains the coherent generation when post-write native proof fails', async () => {
    const { project, fileSystem, probe, workspace, first } = await createNativeAssetWorkspace();
    trackSemanticTransactionWrites(fileSystem, probe);
    const changed = cloneAuthoringProject(project);
    changed.assets.image.label = 'Committed Before Proof Failure';
    probe.beforeObserve((count) => {
      if (count !== 4) return;
      probe.beforeObserve(null);
      throw new Error('injected post-write native proof failure');
    });

    await expect(
      workspace.write(
        ROOT,
        first.snapshot.workspaceRevision,
        changed,
        changed.editor,
        {},
        {
          affectedPaths: ['/assets/image'],
        },
      ),
    ).rejects.toThrow('injected post-write native proof failure');
    expect(await workspace.hasResidentSession(ROOT)).toBe(true);
    expect(first.snapshot.project.assets.image.label).toBe(project.assets.image.label);

    const reconciled = await workspace.open(ROOT);
    if (!reconciled.ok)
      throw new Error('Committed disk state did not reconcile after proof failure.');
    expect(reconciled.snapshot.project.assets.image.label).toBe('Committed Before Proof Failure');
  });

  it('does not promote a committed candidate when another source changes before native proof', async () => {
    const { project, fileSystem, probe, workspace, first } = await createNativeAssetWorkspace();
    trackSemanticTransactionWrites(fileSystem, probe);
    const changed = cloneAuthoringProject(project);
    changed.assets.image.label = 'Committed Candidate';
    const assetRecordPath = `${ROOT}/records/assets/image.json`;
    const racedRoomPath = 'records/rooms/raced.json';
    const external = cloneAuthoringProject(project);
    external.rooms.raced = {
      id: 'raced',
      label: 'External Room',
      data: defaultRoomData('External Room'),
    };
    const racedRoomText = projectWorkspaceFiles(external, external.editor)[racedRoomPath]!;
    const originalWrite = fileSystem.writeBytesAtomic.bind(fileSystem);
    let injected = false;
    fileSystem.writeBytesAtomic = async (value, bytes) => {
      await originalWrite(value, bytes);
      if (!injected && fileSystem.resolvePath(value) === assetRecordPath) {
        injected = true;
        await originalWrite(`${ROOT}/${racedRoomPath}`, new TextEncoder().encode(racedRoomText));
        probe.add(racedRoomPath);
      }
    };

    await expect(
      workspace.write(
        ROOT,
        first.snapshot.workspaceRevision,
        changed,
        changed.editor,
        {},
        { affectedPaths: ['/assets/image'] },
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REVISION_CONFLICT', targetPath: racedRoomPath });
    expect(injected).toBe(true);
    expect(await workspace.hasResidentSession(ROOT)).toBe(true);
    expect(first.snapshot.project.assets.image.label).toBe(project.assets.image.label);

    const reconciled = await workspace.open(ROOT);
    if (!reconciled.ok) throw new Error('Raced committed disk state did not reconcile.');
    expect(reconciled.snapshot.project.assets.image.label).toBe('Committed Candidate');
    expect(reconciled.snapshot.project.rooms.raced?.label).toBe('External Room');
  });

  it('rejects a source edit that races mutation candidate creation', async () => {
    const { project, fileSystem, probe, workspace, first } = await createNativeAssetWorkspace();
    const changed = cloneAuthoringProject(project);
    changed.assets.image.label = 'Mutation Candidate';
    const roomPath = 'records/rooms/raced.json';
    const external = cloneAuthoringProject(project);
    external.rooms.raced = {
      id: 'raced',
      label: 'External Room',
      data: defaultRoomData('External Room'),
    };
    await fileSystem.writeTextAtomic(
      `${ROOT}/${roomPath}`,
      projectWorkspaceFiles(external, external.editor)[roomPath]!,
    );
    probe.add(roomPath);

    await expect(
      workspace.write(
        ROOT,
        first.snapshot.workspaceRevision,
        changed,
        changed.editor,
        {},
        {
          affectedPaths: ['/assets/image'],
        },
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REVISION_CONFLICT', targetPath: roomPath });
    const persisted = JSON.parse(
      await fileSystem.readText(`${ROOT}/records/assets/image.json`),
    ) as { label: string };
    expect(persisted.label).toBe(project.assets.image.label);
    expect(await workspace.hasResidentSession(ROOT)).toBe(true);
  });

  it('rejects a pending source race even after native authority already consumed the delta', async () => {
    const { project, fileSystem, probe, workspace, first } = await createNativeAssetWorkspace();
    const roomPath = 'records/rooms/raced.json';
    const external = cloneAuthoringProject(project);
    external.rooms.raced = {
      id: 'raced',
      label: 'External Room',
      data: defaultRoomData('External Room'),
    };
    await fileSystem.writeTextAtomic(
      `${ROOT}/${roomPath}`,
      projectWorkspaceFiles(external, external.editor)[roomPath]!,
    );
    probe.add(roomPath);
    expect(await workspace.verifyReadAuthority(first.snapshot)).toBe(false);

    const changed = cloneAuthoringProject(project);
    changed.assets.image.label = 'Mutation Candidate';
    await expect(
      workspace.write(
        ROOT,
        first.snapshot.workspaceRevision,
        changed,
        changed.editor,
        {},
        { affectedPaths: ['/assets/image'] },
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_REVISION_CONFLICT', targetPath: roomPath });
    expect(await workspace.hasResidentSession(ROOT)).toBe(true);
  });

  it('permits a native resident mutation around an unrelated invalid overlay', async () => {
    const { project, fileSystem, probe, workspace } = await createNativeAssetWorkspace();
    await fileSystem.writeTextAtomic(`${ROOT}/traits.json`, '{ invalid json');
    probe.change('traits.json');
    const mutationBase = await workspace.openForMutation(ROOT);
    expect(mutationBase.ok).toBe(true);
    if (!mutationBase.ok) throw new Error('Coherent mutation base was not retained.');
    trackSemanticTransactionWrites(fileSystem, probe);
    const changed = cloneAuthoringProject(project);
    changed.assets.image.label = 'Safe Asset Mutation';

    await workspace.write(
      ROOT,
      mutationBase.snapshot.workspaceRevision,
      changed,
      changed.editor,
      {},
      { affectedPaths: ['/assets/image'] },
    );

    expect(await fileSystem.readText(`${ROOT}/traits.json`)).toBe('{ invalid json');
    expect(await workspace.hasResidentSession(ROOT)).toBe(true);
  });

  it('blocks a native resident mutation that overlaps an invalid overlay', async () => {
    const { project, fileSystem, probe, workspace } = await createNativeAssetWorkspace();
    const recordPath = 'records/assets/image.json';
    await fileSystem.writeTextAtomic(`${ROOT}/${recordPath}`, '{ invalid json');
    probe.change(recordPath);
    const mutationBase = await workspace.openForMutation(ROOT);
    expect(mutationBase.ok).toBe(true);
    if (!mutationBase.ok) throw new Error('Coherent mutation base was not retained.');
    const changed = cloneAuthoringProject(project);
    changed.assets.image.label = 'Blocked Asset Mutation';

    await expect(
      workspace.write(
        ROOT,
        mutationBase.snapshot.workspaceRevision,
        changed,
        changed.editor,
        {},
        { affectedPaths: ['/assets/image'] },
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_INVALID_SOURCE_DEPENDENCY' });
    expect(await fileSystem.readText(`${ROOT}/${recordPath}`)).toBe('{ invalid json');
    expect(await workspace.hasResidentSession(ROOT)).toBe(true);
  });

  it('restores native configuration when a discarded Asset candidate reverts to the coherent path', async () => {
    const { project, fileSystem, probe, workspace } = await createNativeAssetWorkspace();
    const relativePath = 'records/assets/image.json';
    const changed = cloneAuthoringProject(project);
    changed.assets.image.data.source.path = 'assets/replaced.png';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${relativePath}`,
      projectWorkspaceFiles(changed, changed.editor)[relativePath]!,
    );
    probe.change(relativePath);
    probe.beforeObserve(async (count) => {
      if (count !== 4) return;
      probe.beforeObserve(null);
      await fileSystem.writeTextAtomic(
        `${ROOT}/${relativePath}`,
        projectWorkspaceFiles(project, project.editor)[relativePath]!,
      );
      probe.change(relativePath);
    });

    const reopened = await workspace.open(ROOT);
    if (!reopened.ok) throw new Error('Raced Asset reconciliation failed.');
    expect(reopened.snapshot.project.assets.image.data.source.path).toBe('assets/original.png');
    expect(probe.requests.slice(2)).toEqual([
      null,
      ['project.json', 'editor.json', 'traits.json', 'assets/replaced.png'],
      ['project.json', 'editor.json', 'traits.json', 'assets/original.png'],
    ]);
    expect(await workspace.verifyReadAuthority(reopened.snapshot)).toBe(true);
    expect(probe.requests.at(-1)).toBeNull();
  });

  it('reinstalls native configuration after an uncertain observation failure', async () => {
    const { probe, workspace } = await createNativeAssetWorkspace();
    probe.beforeObserve(() => {
      probe.beforeObserve(null);
      throw new Error('Native observation failed');
    });
    await expect(workspace.open(ROOT)).rejects.toThrow('Native observation failed');
    const reopened = await workspace.open(ROOT);
    expect(reopened.ok).toBe(true);
    expect(probe.requests.at(-1)).toEqual([
      'project.json',
      'editor.json',
      'traits.json',
      'assets/original.png',
    ]);
  });

  it('widens validation when Trait membership changes inside traits.json', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.traits.legacy = {
      id: 'legacy',
      label: 'Legacy',
      ownerKinds: ['room'],
      properties: [],
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');
    await workspace.buildDependencyGraphAnalysis(first.snapshot);

    const changed = cloneAuthoringProject(project);
    delete changed.traits.legacy;
    changed.traits['new-trait'] = {
      id: 'different-id',
      label: 'New Trait',
      ownerKinds: ['room'],
      properties: [],
    };
    await fileSystem.writeTextAtomic(
      `${ROOT}/traits.json`,
      projectWorkspaceFiles(changed, changed.editor)['traits.json']!,
    );
    probe.change('traits.json');

    const reopened = await workspace.open(ROOT);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('Trait membership reconciliation failed.');
    expect(reopened.diagnostics).toContainEqual(
      expect.objectContaining({
        path: '/traits/new-trait/id',
        message: expect.stringContaining("must match map key 'new-trait'"),
      }),
    );
    expect(reopened.validationContributions.map((entry) => entry.key)).toContain(
      'workspace:trait-definition:new-trait',
    );
    expect(reopened.validationContributions.map((entry) => entry.key)).not.toContain(
      'workspace:trait-definition:legacy',
    );
    expect(reopened.sourceWork.fullProjectTraversals).toBeGreaterThan(0);
    const dependency = await workspace.buildDependencyGraphAnalysis(reopened.snapshot);
    expect(
      [...dependency.graph.nodesByKey.values()].some(
        (node) => node.owningPath === '/traits/new-trait',
      ),
    ).toBe(true);
    expect(
      [...dependency.graph.nodesByKey.values()].some(
        (node) => node.owningPath === '/traits/legacy',
      ),
    ).toBe(false);
  });

  it('widens validation when Interactable Instance membership changes inside project.json', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.interactables.box = {
      id: 'box',
      label: 'Box',
      data: defaultInteractableData('Box'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');

    const changed = cloneAuthoringProject(project);
    changed.interactableInstances.box = defaultInteractableInstanceData('box', 'box', {
      kind: 'inventory',
      inventory: { owner: { kind: 'project' }, inventoryId: 'missing' },
    });
    await fileSystem.writeTextAtomic(
      `${ROOT}/project.json`,
      projectWorkspaceFiles(changed, changed.editor)['project.json']!,
    );
    probe.change('project.json');

    const reopened = await workspace.open(ROOT);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('Interactable Instance membership reconciliation failed.');
    expect(reopened.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'authoring.inventory.missing',
        path: '/interactableInstances/box/location/inventory/inventoryId',
      }),
    );
    expect(reopened.validationContributions.map((entry) => entry.key)).toContain(
      'workspace:inventories-owner:instances:box',
    );
    expect(reopened.sourceWork.fullProjectTraversals).toBeGreaterThan(0);
  });

  it('keeps long resident edit histories change-proportional', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    project.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      data: defaultRoomData('Hall'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');
    const unchangedHall = first.snapshot.project.rooms.hall;
    const roomPath = 'records/rooms/foyer.json';
    const persistedRoom = JSON.parse(files[`${ROOT}/${roomPath}`]!) as Record<string, unknown>;

    let latest = first;
    for (let index = 0; index < 96; index += 1) {
      persistedRoom.label = `Foyer ${index}`;
      await fileSystem.writeTextAtomic(
        `${ROOT}/${roomPath}`,
        `${JSON.stringify(persistedRoom, null, 2)}\n`,
      );
      probe.change(roomPath);
      const reopened = await workspace.open(ROOT);
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) throw new Error(`Resident generation ${index} failed.`);
      expect(reopened.sourceWork).toMatchObject({
        authoredFilesReread: 1,
        parsedJsonSources: 1,
        fullProjectTraversals: 0,
        fullProjectProjections: 0,
        foregroundSerializations: 0,
      });
      latest = reopened;
    }

    expect(latest.snapshot.project.rooms.foyer.label).toBe('Foyer 95');
    expect(latest.snapshot.project.rooms.hall).toBe(unchangedHall);
  }, 15_000);

  it('drops stale reusable contributions when cold admission races the native proof', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const reusable = await new ProjectWorkspaceService(fileSystem).open(ROOT);
    expect(reusable.ok).toBe(true);
    if (!reusable.ok) throw new Error('Reusable Project admission failed.');

    const changed = cloneAuthoringProject(project);
    changed.rooms.foyer!.label = 'Changed during admission';
    const roomPath = 'records/rooms/foyer.json';
    const changedRoom = projectWorkspaceFiles(changed, changed.editor)[roomPath]!;
    const probe = createProjectAuthorityProbe();
    probe.beforeObserve(async (count) => {
      if (count !== 2) return;
      await fileSystem.writeTextAtomic(`${ROOT}/${roomPath}`, changedRoom);
      probe.change(roomPath);
    });

    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const opened = await workspace.open(ROOT, {
      reusableSourceContributions: reusable.sourceContributions,
      reusableValidationContributions: reusable.validationContributions,
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Resident Project admission failed.');
    expect(opened.snapshot.project.rooms.foyer?.label).toBe('Changed during admission');
    expect(probe.observations).toHaveLength(3);
    expect(probe.observations[1]?.changed).toEqual([roomPath]);
  });

  it('retains a native delta consumed by the final read-authority proof', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');

    const changed = structuredClone(project);
    changed.rooms.foyer.label = 'Changed After Command';
    const relativePath = 'records/rooms/foyer.json';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${relativePath}`,
      projectWorkspaceFiles(changed, changed.editor)[relativePath]!,
    );
    probe.change(relativePath);

    // This mirrors the CLI's post-command authority proof: observe() advances native authority,
    // so the resident owner must retain the semantic delta for the retry that follows.
    expect(await workspace.verifyReadAuthority(first.snapshot)).toBe(false);
    const retried = await workspace.open(ROOT);
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error('Resident retry failed.');
    expect(retried.snapshot.project.rooms.foyer.label).toBe('Changed After Command');
    expect(retried.sourceWork.authoredFilesReread).toBe(1);
  });

  it('discards a raced native candidate and retries from the coherent generation', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');

    const relativePath = 'records/rooms/foyer.json';
    const firstEdit = structuredClone(project);
    firstEdit.rooms.foyer.label = 'First Edit';
    const secondEdit = structuredClone(project);
    secondEdit.rooms.foyer.label = 'Second Edit';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${relativePath}`,
      projectWorkspaceFiles(firstEdit, firstEdit.editor)[relativePath]!,
    );
    probe.change(relativePath);
    probe.beforeObserve(async (count) => {
      if (count !== 4) return;
      probe.beforeObserve(null);
      await fileSystem.writeTextAtomic(
        `${ROOT}/${relativePath}`,
        projectWorkspaceFiles(secondEdit, secondEdit.editor)[relativePath]!,
      );
      probe.change(relativePath);
    });

    const byteReads: string[] = [];
    const originalBytes = fileSystem.readBytes.bind(fileSystem);
    fileSystem.readBytes = async (value) => {
      byteReads.push(fileSystem.resolvePath(value));
      return originalBytes(value);
    };
    const reopened = await workspace.open(ROOT);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('Raced Project reconciliation failed.');
    expect(reopened.snapshot.project.rooms.foyer.label).toBe('Second Edit');
    expect(first.snapshot.project.rooms.foyer.label).toBe('Foyer');
    expect(byteReads).toEqual([`${ROOT}/${relativePath}`, `${ROOT}/${relativePath}`]);
  });

  it('refreshes inline Lua descriptors and dependency evidence after an existing JSON edit', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    for (const id of ['owner', 'before', 'after'])
      project.rooms[id] = { id, label: id, data: defaultRoomData(id) };
    project.rooms.owner.data.description.source = { kind: 'lua-expression', source: "'before'" };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([path, text]) => [
        `${ROOT}/${path}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    if (!first.ok) throw new Error('Initial Project open failed.');
    await workspace.buildDependencyGraphAnalysis(first.snapshot);
    const changed = cloneAuthoringProject(project);
    changed.rooms.owner.data.description.source = { kind: 'lua-expression', source: "'after'" };
    const path = 'records/rooms/owner.json';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${path}`,
      projectWorkspaceFiles(changed, changed.editor)[path]!,
    );
    probe.change(path);

    const reopened = await workspace.open(ROOT);
    if (!reopened.ok) throw new Error('Inline Lua reconciliation failed.');
    expect(reopened.sourceWork.authoredFilesReread).toBe(1);
    expect(reopened.snapshot.project.rooms.before).toBe(first.snapshot.project.rooms.before);
    expect(
      reopened.snapshot.externalSourceDescriptors.find((descriptor) =>
        descriptor.sourcePath.startsWith('/rooms/owner/'),
      )?.inlineText,
    ).toBe("'after'");
    const dependency = await workspace.buildDependencyGraphAnalysis(reopened.snapshot);
    const targets = [...dependency.graph.edgesById.values()]
      .filter(
        (edge) =>
          edge.sourcePath.startsWith('/rooms/owner/data/description/') &&
          edge.target.kind === 'record' &&
          edge.target.collection === 'rooms',
      )
      .map((edge) => (edge.target.kind === 'record' ? edge.target.id : null));
    expect(targets).toContain('after');
    expect(targets).not.toContain('before');
    expect(dependency.work.fullProjectTraversals).toBe(0);
  });

  it('repairs a malformed native-delta overlay from the last coherent generation', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');

    const relativePath = 'records/rooms/foyer.json';
    await fileSystem.writeTextAtomic(`${ROOT}/${relativePath}`, '{');
    probe.change(relativePath);
    const invalid = await workspace.open(ROOT);
    expect(invalid.ok).toBe(false);
    expect(first.snapshot.project.rooms.foyer.label).toBe('Foyer');

    const repaired = structuredClone(project);
    repaired.rooms.foyer.label = 'Repaired Foyer';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${relativePath}`,
      projectWorkspaceFiles(repaired, repaired.editor)[relativePath]!,
    );
    probe.change(relativePath);
    const reopened = await workspace.open(ROOT);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('Repaired Project open failed.');
    expect(reopened.snapshot.project.rooms.foyer.label).toBe('Repaired Foyer');
    expect(reopened.sourceWork.authoredFilesReread).toBe(1);
  });

  it('admits a narrow resident read around an unrelated malformed overlay but blocks its required domain', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    if (!first.ok) throw new Error('Initial Project open failed.');

    const malformedPath = 'records/rooms/foyer.json';
    await fileSystem.writeTextAtomic(`${ROOT}/${malformedPath}`, '{');
    probe.change(malformedPath);

    const unrelated = await workspace.openForRead(ROOT, ['/rooms/hall']);
    expect(unrelated.ok).toBe(true);
    if (!unrelated.ok) throw new Error('Unrelated semantic-domain read was blocked.');
    expect(unrelated.snapshot.project.rooms.hall.label).toBe('Hall');
    expect(unrelated.snapshot.project.rooms.foyer.label).toBe('Foyer');

    const required = await workspace.openForRead(ROOT, ['/rooms/foyer']);
    expect(required.ok).toBe(false);
    if (required.ok) throw new Error('Malformed required domain was admitted.');
    expect(required.diagnostics.some((diagnostic) => diagnostic.path.includes('foyer'))).toBe(true);
  });

  it('widens native reconciliation for structural add and remove deltas', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);

    const withHall = structuredClone(project);
    withHall.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    const hallPath = 'records/rooms/hall.json';
    withHall.rooms.hall.archetype = { $ref: { collection: 'archetypes', id: 'missing' } };
    await fileSystem.writeTextAtomic(
      `${ROOT}/${hallPath}`,
      projectWorkspaceFiles(withHall, withHall.editor)[hallPath]!,
    );
    probe.add(hallPath);
    const added = await workspace.open(ROOT);
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error('Structural add reconciliation failed.');
    expect(added.snapshot.project.rooms.hall.label).toBe('Hall');
    expect(
      added.diagnostics.some((diagnostic) => diagnostic.path === '/rooms/hall/archetype'),
    ).toBe(true);

    await fileSystem.removeFile(`${ROOT}/${hallPath}`);
    probe.remove(hallPath);
    const removed = await workspace.open(ROOT);
    expect(removed.ok).toBe(true);
    if (!removed.ok) throw new Error('Structural remove reconciliation failed.');
    expect(removed.snapshot.project.rooms.hall).toBeUndefined();
    expect(
      removed.diagnostics.some((diagnostic) => diagnostic.path?.startsWith('/rooms/hall/')),
    ).toBe(false);
    expect(
      removed.validationContributions.some((contribution) =>
        contribution.key.endsWith(':rooms:hall'),
      ),
    ).toBe(false);
  });

  it('rereads only a changed Lua source through native authority', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'local value = "before"\n',
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');

    await fileSystem.writeTextAtomic(`${ROOT}/scripts/bootstrap.lua`, 'local value = "after"\n');
    probe.change('scripts/bootstrap.lua');
    const byteReads: string[] = [];
    const originalBytes = fileSystem.readBytes.bind(fileSystem);
    fileSystem.readBytes = async (value) => {
      byteReads.push(fileSystem.resolvePath(value));
      return originalBytes(value);
    };
    const reopened = await workspace.open(ROOT);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('Lua reconciliation failed.');
    expect(reopened.sourceWork).toMatchObject({
      authoredFilesReread: 1,
      parsedJsonSources: 0,
      readTextSources: 1,
      fullProjectTraversals: 0,
    });
    expect(byteReads).toEqual([`${ROOT}/scripts/bootstrap.lua`]);
    expect(reopened.snapshot.project.rooms.foyer).toBe(first.snapshot.project.rooms.foyer);
  });

  it('reconciles a changed Script Module JSON record without reopening unrelated sources', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return true\n',
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');

    const recordPath = 'records/scripts/bootstrap.json';
    const persisted = JSON.parse(files[`${ROOT}/${recordPath}`]!) as Record<string, unknown>;
    persisted.label = 'Changed Bootstrap';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${recordPath}`,
      `${JSON.stringify(persisted, null, 2)}\n`,
    );
    probe.change(recordPath);

    const byteReads: string[] = [];
    const originalBytes = fileSystem.readBytes.bind(fileSystem);
    fileSystem.readBytes = async (value) => {
      byteReads.push(fileSystem.resolvePath(value));
      return originalBytes(value);
    };
    const reopened = await workspace.open(ROOT);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('Script Module record reconciliation failed.');
    expect(reopened.snapshot.project.scripts.bootstrap?.label).toBe('Changed Bootstrap');
    expect(reopened.snapshot.project.rooms.foyer).toBe(first.snapshot.project.rooms.foyer);
    expect(reopened.sourceWork).toMatchObject({
      authoredFilesReread: 1,
      parsedJsonSources: 1,
      readTextSources: 0,
      fullProjectTraversals: 0,
    });
    expect(byteReads).toEqual([`${ROOT}/${recordPath}`]);
  });

  it('advances an existing changed source without rebuilding the resident Project', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const workspace = new ResidentProjectWorkspaceService(fileSystem);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.diagnostics[0]?.message ?? 'Project open failed.');
    const firstSnapshot = first.snapshot;

    const changed = structuredClone(project);
    changed.rooms.foyer.label = 'Changed Foyer';
    const relativePath = 'records/rooms/foyer.json';
    const changedFiles = projectWorkspaceFiles(changed, changed.editor);
    await fileSystem.writeTextAtomic(`${ROOT}/${relativePath}`, changedFiles[relativePath]!);

    const second = await workspace.open(ROOT);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.diagnostics[0]?.message ?? 'Project reopen failed.');
    expect(second.snapshot).not.toBe(firstSnapshot);
    expect(firstSnapshot.project.rooms.foyer.label).toBe('Foyer');
    expect(second.snapshot.project.rooms.foyer.label).toBe('Changed Foyer');
    expect(second.sourceWork.parsedJsonSources).toBe(1);
    expect(second.sourceWork.projectedJsonSources).toBe(1);
    expect(second.sourceWork.wholeProjectSchemaParses).toBe(0);
  });

  it('advances a file-backed Layout source with one text read', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    const layout = defaultLayoutData('HUD', 'document');
    layout.rml.sourceText = '<rml><body>Before</body></rml>';
    project.layouts.hud = { id: 'hud', label: 'HUD', data: layout };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const workspace = new ResidentProjectWorkspaceService(fileSystem);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);

    await fileSystem.writeTextAtomic(
      `${ROOT}/records/layouts/hud/layout.rml`,
      '<rml><body>After</body></rml>',
    );
    const second = await workspace.open(ROOT);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('Resident Layout reopen failed.');
    expect(second.snapshot.project.layouts.hud.data.rml).toMatchObject({
      sourceMode: 'inline',
      sourceText: '<rml><body>After</body></rml>',
    });
    expect(second.sourceWork.parsedJsonSources).toBe(0);
    expect(second.sourceWork.readTextSources).toBe(1);
    expect(second.sourceWork.wholeProjectSchemaParses).toBe(0);
  });

  it('refreshes resident Lua source descriptors with changed file-backed text', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'local value = "before"\n',
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const workspace = new ResidentProjectWorkspaceService(fileSystem);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');

    await fileSystem.writeTextAtomic(`${ROOT}/scripts/bootstrap.lua`, 'local value = "after"\n');
    const second = await workspace.open(ROOT);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('Resident Script reopen failed.');
    expect(
      second.snapshot.externalSourceDescriptors.find(
        (descriptor) => descriptor.sourceUrl === 'project:/scripts/bootstrap.lua',
      )?.inlineText,
    ).toBe('local value = "after"\n');
    expect(second.sourceWork.readTextSources).toBe(1);
    expect(second.sourceWork.wholeProjectSchemaParses).toBe(0);
  });

  it('invalidates only the changed dependency owner in a resident generation', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    project.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      data: defaultRoomData('Hall'),
    };
    project.rooms.foyer.data.exits.push({
      id: 'north',
      label: 'North',
      direction: 'north',
      target: { $ref: { collection: 'rooms', id: 'hall' } },
      condition: { kind: 'always' },
      onRejected: [],
    });
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const workspace = new ResidentProjectWorkspaceService(fileSystem);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');
    await workspace.buildDependencyGraphAnalysis(first.snapshot);

    const changed = structuredClone(project);
    changed.rooms.foyer.label = 'Changed Foyer';
    changed.rooms.foyer.data.exits[0]!.target.$ref.id = 'foyer';
    const relativePath = 'records/rooms/foyer.json';
    const changedFiles = projectWorkspaceFiles(changed, changed.editor);
    await fileSystem.writeTextAtomic(`${ROOT}/${relativePath}`, changedFiles[relativePath]!);

    const second = await workspace.open(ROOT);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('Resident Project reopen failed.');
    const dependency = await workspace.buildDependencyGraphAnalysis(second.snapshot);
    const foyerNode = [...dependency.graph.nodesByKey.values()].find(
      (node) => node.owningPath === '/rooms/foyer',
    );
    expect(foyerNode?.label).toBe('Changed Foyer');
    expect(
      [...dependency.graph.edgesById.values()].some(
        (edge) =>
          edge.sourcePath.includes('/rooms/foyer/data/exits/0') &&
          edge.target.kind === 'record' &&
          edge.target.collection === 'rooms' &&
          edge.target.id === 'foyer',
      ),
    ).toBe(true);
    expect(dependency.work.derivedContributions).toBeGreaterThan(0);
    expect(dependency.work.reusedContributions).toBeGreaterThan(0);
    expect(dependency.work.fullProjectTraversals).toBe(0);
  });

  it('reconciles again when disk changes race candidate promotion', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const workspace = new ResidentProjectWorkspaceService(fileSystem);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');

    const relativePath = 'records/rooms/foyer.json';
    const firstEdit = structuredClone(project);
    firstEdit.rooms.foyer.label = 'First Edit';
    const secondEdit = structuredClone(project);
    secondEdit.rooms.foyer.label = 'Second Edit';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${relativePath}`,
      projectWorkspaceFiles(firstEdit, firstEdit.editor)[relativePath]!,
    );

    const originalReadBytes = fileSystem.readBytes.bind(fileSystem);
    let raced = false;
    fileSystem.readBytes = async (value) => {
      const bytes = await originalReadBytes(value);
      if (!raced && fileSystem.resolvePath(value) === `${ROOT}/${relativePath}`) {
        raced = true;
        await fileSystem.writeTextAtomic(
          `${ROOT}/${relativePath}`,
          projectWorkspaceFiles(secondEdit, secondEdit.editor)[relativePath]!,
        );
      }
      return bytes;
    };

    const reopened = await workspace.open(ROOT);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('Raced Project reopen failed.');
    expect(raced).toBe(true);
    expect(reopened.snapshot.project.rooms.foyer.label).toBe('Second Edit');
    expect(first.snapshot.project.rooms.foyer.label).toBe('Foyer');
  });

  it('reconciles every source that changes before candidate promotion', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    project.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      data: defaultRoomData('Hall'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const workspace = new ResidentProjectWorkspaceService(fileSystem);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');

    const foyerPath = 'records/rooms/foyer.json';
    const hallPath = 'records/rooms/hall.json';
    const firstEdit = structuredClone(project);
    firstEdit.rooms.foyer.label = 'Changed Foyer';
    const secondEdit = structuredClone(firstEdit);
    secondEdit.rooms.hall.label = 'Changed Hall';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${foyerPath}`,
      projectWorkspaceFiles(firstEdit, firstEdit.editor)[foyerPath]!,
    );

    const originalReadBytes = fileSystem.readBytes.bind(fileSystem);
    let raced = false;
    fileSystem.readBytes = async (value) => {
      const bytes = await originalReadBytes(value);
      if (!raced && fileSystem.resolvePath(value) === `${ROOT}/${foyerPath}`) {
        raced = true;
        await fileSystem.writeTextAtomic(
          `${ROOT}/${hallPath}`,
          projectWorkspaceFiles(secondEdit, secondEdit.editor)[hallPath]!,
        );
      }
      return bytes;
    };

    const reopened = await workspace.open(ROOT);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('Raced Project reopen failed.');
    expect(raced).toBe(true);
    expect(reopened.snapshot.project.rooms.foyer.label).toBe('Changed Foyer');
    expect(reopened.snapshot.project.rooms.hall.label).toBe('Changed Hall');
  });

  it('falls back safely for structural source additions and deletions', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const workspace = new ResidentProjectWorkspaceService(fileSystem);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');

    const withHall = structuredClone(project);
    withHall.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    const hallPath = 'records/rooms/hall.json';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${hallPath}`,
      projectWorkspaceFiles(withHall, withHall.editor)[hallPath]!,
    );
    const added = await workspace.open(ROOT);
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error('Project add reconciliation failed.');
    expect(added.snapshot.project.rooms.hall.label).toBe('Hall');
    expect(first.snapshot.project.rooms.hall).toBeUndefined();

    await fileSystem.removeFile(`${ROOT}/${hallPath}`);
    const removed = await workspace.open(ROOT);
    expect(removed.ok).toBe(true);
    if (!removed.ok) throw new Error('Project delete reconciliation failed.');
    expect(removed.snapshot.project.rooms.hall).toBeUndefined();
    expect(added.snapshot.project.rooms.hall.label).toBe('Hall');
  });

  it('deduplicates logical aliases onto one canonical resident Project generation', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const alias = '/aliases/resident-session';
    const originalRealpath = fileSystem.realpath.bind(fileSystem);
    fileSystem.realpath = async (value) => {
      const normalized = fileSystem.resolvePath(value);
      if (normalized === alias) return ROOT;
      if (normalized.startsWith(`${alias}/`))
        return originalRealpath(`${ROOT}/${normalized.slice(alias.length + 1)}`);
      return originalRealpath(value);
    };
    const workspace = new ResidentProjectWorkspaceService(fileSystem);
    const canonical = await workspace.open(ROOT);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) throw new Error('Canonical Project open failed.');

    const logical = await workspace.open(alias);
    expect(logical.ok).toBe(true);
    if (!logical.ok) throw new Error('Aliased Project open failed.');
    expect(logical.snapshot.projectRoot).toBe(alias);
    expect(logical.snapshot.project).toBe(canonical.snapshot.project);
    expect(await workspace.hasResidentSession(alias)).toBe(true);
  });

  it('evicts resident Project sessions after their idle cutoff', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const workspace = new ResidentProjectWorkspaceService(fileSystem);
    const opened = await workspace.open(ROOT);
    expect(opened.ok).toBe(true);
    expect(await workspace.hasResidentSession(ROOT)).toBe(true);

    expect(workspace.evictIdleSessions(60_000, Date.now())).toBe(0);
    expect(await workspace.hasResidentSession(ROOT)).toBe(true);
    expect(workspace.evictIdleSessions(1, Date.now() + 60_000)).toBe(1);
    expect(await workspace.hasResidentSession(ROOT)).toBe(false);
  });

  it('reconciles watcher-driven resident changes without treating unchanged observations as activity', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const opened = await workspace.open(ROOT);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Initial Project open failed.');

    expect(await workspace.reconcileResidentSessions()).toBe(0);

    const changed = structuredClone(project);
    changed.rooms.foyer.label = 'Watcher Reconciled';
    const relativePath = 'records/rooms/foyer.json';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${relativePath}`,
      projectWorkspaceFiles(changed, changed.editor)[relativePath]!,
    );
    probe.change(relativePath);

    expect(await workspace.reconcileResidentSessions()).toBe(1);
    const resident = await workspace.open(ROOT);
    expect(resident.ok).toBe(true);
    if (!resident.ok) throw new Error('Reconciled Project open failed.');
    expect(resident.snapshot.project.rooms.foyer.label).toBe('Watcher Reconciled');
    expect(await workspace.reconcileResidentSessions()).toBe(0);
  });

  it('round-trips a portable resident generation without reopening authored Project sources', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const layout = defaultLayoutData('HUD', 'document');
    layout.rml.sourceText = '<rml><body>Portable Layout</body></rml>';
    layout.lua.sourceText = 'local portable_layout = true\n';
    project.layouts.hud = { id: 'hud', label: 'HUD', data: layout };
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'local portable_script = true\n',
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const opened = await workspace.open(ROOT);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Initial Project open failed.');

    const prepared = await workspace.preparePortableSnapshot(ROOT);
    expect(prepared).not.toBeNull();
    if (!prepared) throw new Error('Portable Project snapshot was not prepared.');
    expect(prepared.identity).toEqual(await workspace.residentGenerationIdentity(ROOT));

    const originalReadText = fileSystem.readText.bind(fileSystem);
    fileSystem.readText = async (value) => {
      const relative = fileSystem
        .relativePath(ROOT, fileSystem.resolvePath(value))
        .replaceAll('\\', '/');
      if (opened.snapshot.canonicalSourceFiles.includes(relative))
        throw new Error(`Authored source '${relative}' was reopened during snapshot rehydration.`);
      return originalReadText(value);
    };

    const replacement = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    expect(
      await replacement.rehydratePortableSnapshot(
        ROOT,
        prepared.snapshotText,
        prepared.ownerMetadataText,
      ),
    ).toBe(true);
    expect(await replacement.residentGenerationIdentity(ROOT)).toEqual(prepared.identity);

    const rehydrated = await replacement.open(ROOT);
    expect(rehydrated.ok).toBe(true);
    if (!rehydrated.ok) throw new Error('Rehydrated Project open failed.');
    expect(rehydrated.snapshot.project).toEqual(opened.snapshot.project);
    expect(rehydrated.snapshot.scriptSourcePaths).toEqual(opened.snapshot.scriptSourcePaths);
    expect(rehydrated.snapshot.saveUnitFileOwnership).toEqual(
      opened.snapshot.saveUnitFileOwnership,
    );
    expect(rehydrated.snapshot.project.layouts.hud.data.rml.sourceText).toBe(
      '<rml><body>Portable Layout</body></rml>',
    );
    expect(
      rehydrated.snapshot.externalSourceDescriptors.find(
        (descriptor) => descriptor.sourceUrl === 'project:/scripts/bootstrap.lua',
      )?.inlineText,
    ).toBe('local portable_script = true\n');
  });

  it('treats portable resident documents as strict daemon-internal state without an independent version', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(
        Object.entries(projectWorkspaceFiles(project, project.editor)).map(
          ([relativePath, text]) => [`${ROOT}/${relativePath}`, text],
        ),
      ),
    );
    const probe = createProjectAuthorityProbe();
    const owner = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const opened = await owner.open(ROOT);
    expect(opened.ok).toBe(true);
    const prepared = await owner.preparePortableSnapshot(ROOT);
    if (!prepared) throw new Error('Portable Project snapshot was not prepared.');

    const snapshot = JSON.parse(prepared.snapshotText) as Record<string, unknown>;
    const ownerMetadata = JSON.parse(prepared.ownerMetadataText) as Record<string, unknown>;
    expect(snapshot).not.toHaveProperty('version');
    expect(ownerMetadata).not.toHaveProperty('version');

    const legacySnapshot = JSON.stringify({ ...snapshot, version: 2 });
    const legacyMetadata = JSON.stringify({ ...ownerMetadata, version: 2 });
    expect(
      await new ResidentProjectWorkspaceService(
        fileSystem,
        undefined,
        probe.authority,
      ).hydratePortableSnapshot(ROOT, legacySnapshot),
    ).toBe(false);
    expect(
      await new ResidentProjectWorkspaceService(
        fileSystem,
        undefined,
        probe.authority,
      ).rehydratePortableSnapshot(ROOT, prepared.snapshotText, legacyMetadata),
    ).toBe(false);
  });

  it('hydrates a pinned portable generation without admitting newer structural disk state', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const owner = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const opened = await owner.open(ROOT);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Initial Project open failed.');
    const prepared = await owner.preparePortableSnapshot(ROOT);
    if (!prepared) throw new Error('Portable Project snapshot was not prepared.');

    await fileSystem.writeTextAtomic(
      `${ROOT}/records/rooms/live-only.json`,
      JSON.stringify({ id: 'live-only', label: 'Live Only', data: defaultRoomData('Live Only') }),
    );

    const originalReadText = fileSystem.readText.bind(fileSystem);
    fileSystem.readText = async (value) => {
      const relative = fileSystem
        .relativePath(ROOT, fileSystem.resolvePath(value))
        .replaceAll('\\', '/');
      if (
        relative === 'records/rooms/live-only.json' ||
        opened.snapshot.canonicalSourceFiles.includes(relative)
      )
        throw new Error(`Authored source '${relative}' was read during pinned snapshot hydration.`);
      return originalReadText(value);
    };

    const disposable = new ResidentProjectWorkspaceService(fileSystem);
    expect(await disposable.hydratePortableSnapshot(ROOT, prepared.snapshotText)).toBe(true);
    expect(await disposable.residentGenerationIdentity(ROOT)).toEqual(prepared.identity);
    const pinned = await disposable.open(ROOT);
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) throw new Error('Pinned Project snapshot did not hydrate.');
    expect(pinned.snapshot.project.rooms.foyer.label).toBe('Foyer');
    expect(pinned.snapshot.project.rooms['live-only']).toBeUndefined();
    await expect(disposable.openForMutation(ROOT)).rejects.toThrow(
      'Pinned disposable Project generations are immutable.',
    );
  });

  it('retains Project-owned Script Module and Layout dependency source bytes in the pinned generation', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.scripts.main = {
      id: 'main',
      label: 'Main',
      data: {
        kind: 'script-module',
        source: { kind: 'project-file', path: 'scripts/main.lua' },
      },
    };
    const layout = defaultLayoutData('HUD', 'document');
    layout.dependencies.scripts = ['scripts/layout-helper.lua'];
    project.layouts.hud = { id: 'hud', label: 'HUD', data: layout };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    files[`${ROOT}/scripts/main.lua`] = 'return "generation-one-main"\n';
    files[`${ROOT}/scripts/layout-helper.lua`] = 'return "generation-one-layout"\n';
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const owner = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const opened = await owner.open(ROOT);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Initial Project open failed.');
    const prepared = await owner.preparePortableSnapshot(ROOT);
    if (!prepared) throw new Error('Portable Project snapshot was not prepared.');

    await fileSystem.writeTextAtomic(`${ROOT}/scripts/main.lua`, 'return "generation-two-main"\n');
    await fileSystem.writeTextAtomic(
      `${ROOT}/scripts/layout-helper.lua`,
      'return "generation-two-layout"\n',
    );

    const disposable = new ResidentProjectWorkspaceService(fileSystem);
    const parse = vi.spyOn(JSON, 'parse');
    expect(await disposable.hydratePortableSnapshot(ROOT, prepared.snapshotText)).toBe(true);
    const inputs = await disposable.pinnedPortableInputs(ROOT);
    expect(parse.mock.calls.filter(([text]) => text === prepared.snapshotText)).toHaveLength(1);
    parse.mockRestore();
    expect(inputs?.projectTextSources['scripts/main.lua']).toMatchObject({
      text: 'return "generation-one-main"\n',
    });
    expect(inputs?.projectTextSources['scripts/layout-helper.lua']).toMatchObject({
      text: 'return "generation-one-layout"\n',
    });
  });

  it('rehydrates the retained generation after the original resident session is evicted', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const opened = await workspace.open(ROOT);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Initial Project open failed.');
    const prepared = await workspace.preparePortableSnapshot(ROOT);
    if (!prepared) throw new Error('Portable Project snapshot was not prepared.');

    expect(workspace.evictIdleSessions(1, Date.now() + 60_000)).toBe(1);
    expect(await workspace.hasResidentSession(ROOT)).toBe(false);

    const replacement = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    expect(
      await replacement.rehydratePortableSnapshot(
        ROOT,
        prepared.snapshotText,
        prepared.ownerMetadataText,
      ),
    ).toBe(true);
    expect(await replacement.residentGenerationIdentity(ROOT)).toEqual(prepared.identity);
    const resumed = await replacement.open(ROOT);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('Evicted Project snapshot did not resume.');
    expect(resumed.snapshot.project.rooms.foyer.label).toBe('Foyer');
  });

  it('falls back to a cold Project admission when no retained snapshot is available', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    let authoredReads = 0;
    const originalReadText = fileSystem.readText.bind(fileSystem);
    fileSystem.readText = async (value) => {
      const relative = fileSystem
        .relativePath(ROOT, fileSystem.resolvePath(value))
        .replaceAll('\\', '/');
      if (
        relative === 'project.json' ||
        relative === 'traits.json' ||
        relative.startsWith('records/')
      )
        authoredReads += 1;
      return originalReadText(value);
    };

    const replacement = new ResidentProjectWorkspaceService(
      fileSystem,
      undefined,
      probe.authority,
      97,
    );
    const opened = await replacement.open(ROOT);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Cold Project fallback failed.');
    expect(await replacement.residentGenerationIdentity(ROOT)).toEqual({
      sessionEpoch: 97,
      generation: 1,
    });
    expect(authoredReads).toBeGreaterThan(0);
  });

  it('records external Asset identity metadata without embedding Asset payload bytes', async () => {
    const { probe, workspace } = await createNativeAssetWorkspace();
    probe.setManifestEntries([
      {
        path: 'assets/original.png',
        sourceIdentity: 'dev:1:ino:2',
        byteSize: 1,
        mtimeNanoseconds: '123456789',
        contentHash: null,
      },
    ]);

    const prepared = await workspace.preparePortableSnapshot(ROOT);
    expect(prepared).not.toBeNull();
    if (!prepared) throw new Error('Portable Project snapshot was not prepared.');
    const portable = JSON.parse(prepared.snapshotText) as {
      externalAssets: readonly Readonly<Record<string, unknown>>[];
    };
    expect(portable.externalAssets).toEqual([
      {
        path: 'assets/original.png',
        sourceIdentity: 'dev:1:ino:2',
        byteSize: 1,
        mtimeNanoseconds: '123456789',
        contentHash: null,
      },
    ]);
    expect(prepared.snapshotText).not.toContain('PNG payload bytes');
  });

  it('advances the portable Project generation when an external Asset payload changes', async () => {
    const { first, probe, workspace } = await createNativeAssetWorkspace();
    probe.setManifestEntries([
      {
        path: 'assets/original.png',
        sourceIdentity: 'dev:1:ino:2',
        byteSize: 1,
        mtimeNanoseconds: '100',
        contentHash: null,
      },
    ]);
    const before = await workspace.preparePortableSnapshot(ROOT);
    if (!before) throw new Error('Initial portable Project snapshot was not prepared.');

    probe.change('assets/original.png');
    probe.setManifestEntries([
      {
        path: 'assets/original.png',
        sourceIdentity: 'dev:1:ino:2',
        byteSize: 2,
        mtimeNanoseconds: '200',
        contentHash: null,
      },
    ]);
    const after = await workspace.preparePortableSnapshot(ROOT);
    if (!after) throw new Error('Changed portable Project snapshot was not prepared.');

    expect(after.identity.sessionEpoch).toBe(before.identity.sessionEpoch);
    expect(after.identity.generation).toBe(before.identity.generation + 1);
    expect(after.snapshotText).not.toBe(before.snapshotText);
    expect(await workspace.verifyReadAuthority(first.snapshot)).toBe(false);
    const latest = await workspace.open(ROOT);
    expect(latest.ok).toBe(true);
    if (!latest.ok) throw new Error('Asset authority generation did not remain resident.');
    expect(latest.snapshot).not.toBe(first.snapshot);
    expect(await workspace.verifyReadAuthority(latest.snapshot)).toBe(true);
  });

  it('retains an external Asset change consumed by final read proof until generation advances', async () => {
    const { first, probe, workspace } = await createNativeAssetWorkspace();
    probe.setManifestEntries([
      {
        path: 'assets/original.png',
        sourceIdentity: 'dev:1:ino:2',
        byteSize: 1,
        mtimeNanoseconds: '100',
        contentHash: null,
      },
    ]);
    const before = await workspace.preparePortableSnapshot(ROOT);
    if (!before) throw new Error('Initial portable Project snapshot was not prepared.');

    probe.change('assets/original.png');
    probe.setManifestEntries([
      {
        path: 'assets/original.png',
        sourceIdentity: 'dev:1:ino:2',
        byteSize: 2,
        mtimeNanoseconds: '200',
        contentHash: null,
      },
    ]);

    // This is the post-command proof path: it consumes the native delta before the retry opens the
    // resident Project again.
    expect(await workspace.verifyReadAuthority(first.snapshot)).toBe(false);
    const reopened = await workspace.open(ROOT);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('Resident Project retry failed.');
    const after = await workspace.preparePortableSnapshot(ROOT);
    if (!after) throw new Error('Portable Project snapshot was not refreshed after Asset drift.');

    expect(after.identity.sessionEpoch).toBe(before.identity.sessionEpoch);
    expect(after.identity.generation).toBe(before.identity.generation + 1);
    const portable = JSON.parse(after.snapshotText) as {
      externalAssets: readonly Readonly<Record<string, unknown>>[];
    };
    expect(portable.externalAssets).toEqual([
      {
        path: 'assets/original.png',
        sourceIdentity: 'dev:1:ino:2',
        byteSize: 2,
        mtimeNanoseconds: '200',
        contentHash: null,
      },
    ]);
  });

  it('reconciles an authored delta consumed by snapshot maintenance before serialization', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');

    const changed = structuredClone(project);
    changed.rooms.foyer.label = 'Changed During Snapshot Maintenance';
    const relativePath = 'records/rooms/foyer.json';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${relativePath}`,
      projectWorkspaceFiles(changed, changed.editor)[relativePath]!,
    );
    probe.change(relativePath);

    const prepared = await workspace.preparePortableSnapshot(ROOT);
    expect(prepared).not.toBeNull();
    if (!prepared) throw new Error('Snapshot maintenance did not reconcile the consumed delta.');
    const portable = JSON.parse(prepared.snapshotText) as {
      snapshot: { project: { rooms: Record<string, { label: string }> } };
      sourceContributions: Record<string, unknown>;
    };
    expect(portable.snapshot.project.rooms.foyer?.label).toBe(
      'Changed During Snapshot Maintenance',
    );
    expect(Object.hasOwn(portable.sourceContributions, relativePath)).toBe(true);
    expect(prepared.identity.generation).toBeGreaterThan(1);
  });

  it('rehydrates a retained generation and reconciles only a changed authored source before promotion', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    project.rooms.hall = {
      id: 'hall',
      label: 'Hall',
      data: defaultRoomData('Hall'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const probe = createProjectAuthorityProbe();
    const workspace = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');
    const prepared = await workspace.preparePortableSnapshot(ROOT);
    if (!prepared) throw new Error('Portable Project snapshot was not prepared.');

    const changed = structuredClone(project);
    changed.rooms.foyer.label = 'Changed While Dormant';
    const relativePath = 'records/rooms/foyer.json';
    await fileSystem.writeTextAtomic(
      `${ROOT}/${relativePath}`,
      projectWorkspaceFiles(changed, changed.editor)[relativePath]!,
    );
    probe.change(relativePath);

    const replacement = new ResidentProjectWorkspaceService(fileSystem, undefined, probe.authority);
    expect(
      await replacement.rehydratePortableSnapshot(
        ROOT,
        prepared.snapshotText,
        prepared.ownerMetadataText,
      ),
    ).toBe(true);
    const reconciled = await replacement.open(ROOT);
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw new Error('Rehydrated Project reconciliation failed.');
    expect(reconciled.snapshot.project.rooms.foyer.label).toBe('Changed While Dormant');
    expect(reconciled.snapshot.project.rooms.hall).toEqual(first.snapshot.project.rooms.hall);
    expect(reconciled.sourceWork.authoredFilesReread).toBe(1);
  });

  it('retains the coherent generation across an invalid overlay and repairs incrementally', async () => {
    const project = createAuthoringProject({ id: 'resident-session', name: 'Resident Session' });
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: defaultRoomData('Foyer'),
    };
    const files = Object.fromEntries(
      Object.entries(projectWorkspaceFiles(project, project.editor)).map(([relativePath, text]) => [
        `${ROOT}/${relativePath}`,
        text,
      ]),
    );
    const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata: true });
    const workspace = new ResidentProjectWorkspaceService(fileSystem);
    const first = await workspace.open(ROOT);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('Initial Project open failed.');

    const relativePath = 'records/rooms/foyer.json';
    await fileSystem.writeTextAtomic(`${ROOT}/${relativePath}`, '{');
    const invalid = await workspace.open(ROOT);
    expect(invalid.ok).toBe(false);
    expect(first.snapshot.project.rooms.foyer.label).toBe('Foyer');

    const repaired = structuredClone(project);
    repaired.rooms.foyer.label = 'Repaired Foyer';
    const repairedFiles = projectWorkspaceFiles(repaired, repaired.editor);
    await fileSystem.writeTextAtomic(`${ROOT}/${relativePath}`, repairedFiles[relativePath]!);
    const reopened = await workspace.open(ROOT);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('Repaired Project open failed.');
    expect(reopened.snapshot.project.rooms.foyer.label).toBe('Repaired Foyer');
    expect(reopened.sourceWork.parsedJsonSources).toBe(1);
    expect(reopened.sourceWork.wholeProjectSchemaParses).toBe(0);
  });

  it('reassembles changed authoring source through an injected non-Electron filesystem host', async () => {
    const { fileSystem, project, session } = await createResidentSession();
    const changed = structuredClone(project);
    changed.rooms.foyer.label = 'Changed Foyer';
    const changedFiles = projectWorkspaceFiles(changed, changed.editor);
    const relativePath = 'records/rooms/foyer.json';
    await fileSystem.writeTextAtomic(`${ROOT}/${relativePath}`, changedFiles[relativePath]!);

    const revision = await session.readFreshRevision(relativePath);
    expect(session.requiresAuthoringReassembly(relativePath, revision)).toBe(true);

    const reopened = await session.reassemble([relativePath]);
    expect(reopened.ok).toBe(true);
    expect(session.project().rooms.foyer.label).toBe('Changed Foyer');
  });

  it('serializes work within one resident Project session', async () => {
    const { session } = await createResidentSession();
    const order: string[] = [];
    let releaseFirst!: () => void;
    let signalStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    const first = session.runExclusive(async () => {
      order.push('first:start');
      signalStarted();
      await firstGate;
      order.push('first:end');
    });
    const second = session.runExclusive(async () => {
      order.push('second');
    });

    await firstStarted;
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });
});
