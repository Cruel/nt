import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { ResidentProjectWorkspaceSession } from '../../shared/project-workspace/resident-project-workspace-session';

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
