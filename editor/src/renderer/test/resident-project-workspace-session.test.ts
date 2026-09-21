import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { cloneAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { ResidentProjectWorkspaceSession } from '../../shared/project-workspace/resident-project-workspace-session';
import {
  ResidentProjectWorkspaceService,
  type ResidentProjectAuthority,
} from '../../shared/project-workspace/resident-project-workspace-service';

const ROOT = '/projects/resident-session';

function createProjectAuthorityProbe() {
  let tracked = false;
  let pending = { added: [] as string[], changed: [] as string[], removed: [] as string[] };
  let beforeObserve: ((count: number) => void | Promise<void>) | null = null;
  let observationCount = 0;
  const observations: Array<Readonly<{ added: string[]; changed: string[]; removed: string[] }>> =
    [];
  const authority: ResidentProjectAuthority = {
    async observe(request) {
      observationCount += 1;
      await beforeObserve?.(observationCount);
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
        manifest: { canonicalRoot: request.projectRoot, entries: [] },
      };
    },
    async release() {},
  };
  return {
    authority,
    observations,
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
  };
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
    await fileSystem.writeTextAtomic(
      `${ROOT}/${hallPath}`,
      projectWorkspaceFiles(withHall, withHall.editor)[hallPath]!,
    );
    probe.add(hallPath);
    const added = await workspace.open(ROOT);
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error('Structural add reconciliation failed.');
    expect(added.snapshot.project.rooms.hall.label).toBe('Hall');

    await fileSystem.removeFile(`${ROOT}/${hallPath}`);
    probe.remove(hallPath);
    const removed = await workspace.open(ROOT);
    expect(removed.ok).toBe(true);
    if (!removed.ok) throw new Error('Structural remove reconciliation failed.');
    expect(removed.snapshot.project.rooms.hall).toBeUndefined();
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
