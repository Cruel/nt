import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { ResidentProjectWorkspaceSession } from '../../shared/project-workspace/resident-project-workspace-session';
import { ResidentProjectWorkspaceService } from '../../shared/project-workspace/resident-project-workspace-service';

const ROOT = '/projects/resident-session';

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
    expect(dependency.work.derivedContributions).toBeGreaterThan(0);
    expect(dependency.work.reusedContributions).toBeGreaterThan(0);
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
