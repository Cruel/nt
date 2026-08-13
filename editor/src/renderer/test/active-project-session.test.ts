import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { openProject } from '../../main/services/editor-tool-service';
import { createProject } from '../../main/services/project-file-service';
import { PROJECT_TEXT_SOURCE_LIMITS } from '../../shared/project-text-sources';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createWorkspace(label: string): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `noveltea-active-project-${label}-`));
  temporaryRoots.push(parent);
  const root = path.join(parent, 'workspace');
  const created = await createProject({ projectName: label, projectDirectory: root });
  if (!created.success) throw new Error(created.error ?? 'Project fixture creation failed.');
  return root;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('active Project session lifecycle', () => {
  it('activates a canonical Project root, refreshes it, and rotates for another Project', async () => {
    const projectA = await createWorkspace('a');
    const projectB = await createWorkspace('b');
    const service = new ActiveProjectSessionService();
    await fs.symlink('.', path.join(projectA, 'alias'), 'dir');

    const sessionA = await service.activateProjectFile(path.join(projectA, 'project.json'));
    const refreshedSessionA = await service.activateProjectFile(
      path.join(projectA, 'alias', 'project.json'),
    );
    const sessionB = await service.activateProjectFile(path.join(projectB, 'project.json'));

    expect(sessionA).toMatch(/^[0-9a-f-]{36}$/u);
    expect(refreshedSessionA).toBe(sessionA);
    expect(sessionB).not.toBe(sessionA);
    expect(service.currentSessionId()).toBe(sessionB);
  });

  it('attaches authority to successful current-schema open and saved-Project creation results', async () => {
    const projectA = await createWorkspace('opened');
    const projectB = await createWorkspace('failed-result');
    const creationParent = await fs.mkdtemp(
      path.join(os.tmpdir(), 'noveltea-active-project-created-result-'),
    );
    temporaryRoots.push(creationParent);
    const service = new ActiveProjectSessionService();

    const opened = await service.attachToSuccessfulResult(await openProject(projectA));
    const created = await service.attachToSuccessfulResult(
      await createProject({
        projectName: 'created',
        projectDirectory: path.join(creationParent, 'workspace'),
      }),
    );
    const failed = await service.attachToSuccessfulResult({
      ok: false,
      success: false,
      projectFilePath: path.join(projectB, 'project.json'),
    });

    expect(opened.projectSessionId).toBeDefined();
    expect(created.projectSessionId).not.toBe(opened.projectSessionId);
    expect(created.projectSessionId).toBe(service.currentSessionId());
    expect(failed).not.toHaveProperty('projectSessionId');
    expect(service.currentSessionId()).toBe(created.projectSessionId);
  });

  it('preserves the prior authority when activation fails', async () => {
    const projectA = await createWorkspace('preserved');
    const projectB = await createWorkspace('failed');
    const service = new ActiveProjectSessionService();
    const sessionA = await service.activateProjectFile(path.join(projectA, 'project.json'));
    await fs.rm(path.join(projectB, 'project.json'));

    await expect(
      service.activateProjectFile(path.join(projectB, 'project.json')),
    ).rejects.toThrow();

    expect(service.currentSessionId()).toBe(sessionA);
  });

  it('rejects random, prior-Project, closed, and disposed sessions before filesystem access', async () => {
    const projectA = await createWorkspace('isolation-a');
    const projectB = await createWorkspace('isolation-b');
    const source = Buffer.from('return "a"\n', 'utf8');
    await fs.mkdir(path.join(projectA, 'assets'), { recursive: true });
    await fs.writeFile(path.join(projectA, 'assets', 'script.lua'), source);
    const service = new ActiveProjectSessionService();
    const sessionA = await service.activateProjectFile(path.join(projectA, 'project.json'));
    const request = {
      projectSessionId: sessionA,
      entries: [
        {
          readKey: 'source',
          projectRelativePath: 'assets/script.lua',
          expectedContentHash: sha256(source),
        },
      ],
    };
    const realpath = vi.spyOn(fs, 'realpath');
    const stat = vi.spyOn(fs, 'stat');
    const open = vi.spyOn(fs, 'open');
    const expectRejectedWithoutFileAccess = async (projectSessionId: string) => {
      realpath.mockClear();
      stat.mockClear();
      open.mockClear();
      await expect(service.read({ ...request, projectSessionId })).resolves.toEqual({
        entries: [expect.objectContaining({ status: 'unavailable', code: 'stale-session' })],
      });
      expect(realpath).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    };

    await expectRejectedWithoutFileAccess('random-session');
    const sessionB = await service.activateProjectFile(path.join(projectB, 'project.json'));
    await expectRejectedWithoutFileAccess(sessionA);
    service.closeActiveProject();
    await expectRejectedWithoutFileAccess(sessionB);
    const reopenedSessionA = await service.activateProjectFile(path.join(projectA, 'project.json'));
    service.dispose();
    await expectRejectedWithoutFileAccess(reopenedSessionA);
  });

  it('does not follow a replaced canonical Project root', async () => {
    const projectA = await createWorkspace('root-replacement-a');
    const projectB = await createWorkspace('root-replacement-b');
    const movedProjectA = `${projectA}-moved`;
    const source = Buffer.from('return "outside"\n', 'utf8');
    await fs.mkdir(path.join(projectB, 'assets'), { recursive: true });
    await fs.writeFile(path.join(projectB, 'assets', 'script.lua'), source);
    const service = new ActiveProjectSessionService();
    const projectSessionId = await service.activateProjectFile(path.join(projectA, 'project.json'));

    await fs.rename(projectA, movedProjectA);
    await fs.symlink(projectB, projectA, 'dir');
    try {
      const response = await service.read({
        projectSessionId,
        entries: [
          {
            readKey: 'replacement',
            projectRelativePath: 'assets/script.lua',
            expectedContentHash: sha256(source),
          },
        ],
      });

      expect(response.entries[0]).toMatchObject({
        status: 'unavailable',
        code: 'symlink-escape',
      });
    } finally {
      await fs.rm(projectA);
      await fs.rename(movedProjectA, projectA);
    }
  });

  it('does not follow a text source replaced by an external symlink before open', async () => {
    const projectA = await createWorkspace('source-replacement-a');
    const projectB = await createWorkspace('source-replacement-b');
    const sourcePath = path.join(projectA, 'assets', 'script.lua');
    const outsidePath = path.join(projectB, 'assets', 'outside.lua');
    const outside = Buffer.from('return "outside"\n', 'utf8');
    await fs.writeFile(sourcePath, 'return "inside"\n', 'utf8');
    await fs.writeFile(outsidePath, outside);
    const service = new ActiveProjectSessionService();
    const projectSessionId = await service.activateProjectFile(path.join(projectA, 'project.json'));
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (value, flags) => {
      await fs.rm(sourcePath);
      await fs.symlink(outsidePath, sourcePath, 'file');
      return originalOpen(value, flags);
    });

    const response = await service.read({
      projectSessionId,
      entries: [
        {
          readKey: 'replacement',
          projectRelativePath: 'assets/script.lua',
          expectedContentHash: sha256(outside),
        },
      ],
    });

    expect(response.entries[0]).toMatchObject({
      status: 'unavailable',
      code: 'symlink-escape',
    });
  });

  it('does not publish an in-flight Project A read after Project B activation', async () => {
    const projectA = await createWorkspace('in-flight-a');
    const projectB = await createWorkspace('in-flight-b');
    const source = Buffer.from('return "a"\n', 'utf8');
    const sourcePath = path.join(projectA, 'assets', 'script.lua');
    await fs.writeFile(sourcePath, source);
    const service = new ActiveProjectSessionService();
    const projectSessionId = await service.activateProjectFile(path.join(projectA, 'project.json'));
    const originalRealpath = fs.realpath.bind(fs);
    let entered!: () => void;
    let release!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(fs, 'realpath').mockImplementation(async (value) => {
      if (path.resolve(String(value)) === sourcePath) {
        entered();
        await readGate;
      }
      return originalRealpath(value);
    });

    const pending = service.read({
      projectSessionId,
      entries: [
        {
          readKey: 'source',
          projectRelativePath: 'assets/script.lua',
          expectedContentHash: sha256(source),
        },
      ],
    });
    await enteredGate;
    await service.activateProjectFile(path.join(projectB, 'project.json'));
    release();

    await expect(pending).resolves.toEqual({
      entries: [expect.objectContaining({ status: 'unavailable', code: 'stale-session' })],
    });
  });

  it('preserves ordering, UTF-8 and hash checks, and source and aggregate limits', async () => {
    const project = await createWorkspace('text-sources');
    await fs.mkdir(path.join(project, 'assets'), { recursive: true });
    const source = Buffer.from('\ufeffreturn "ready"\n', 'utf8');
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    const aggregateSource = Buffer.alloc(PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes, 0x61);
    const oversizedSource = Buffer.alloc(PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes + 1, 0x62);
    await Promise.all([
      fs.writeFile(path.join(project, 'assets', 'source.lua'), source),
      fs.writeFile(path.join(project, 'assets', 'invalid.lua'), invalidUtf8),
      fs.writeFile(path.join(project, 'assets', 'aggregate.lua'), aggregateSource),
      fs.writeFile(path.join(project, 'assets', 'oversized.lua'), oversizedSource),
    ]);
    const service = new ActiveProjectSessionService();
    const projectSessionId = await service.activateProjectFile(path.join(project, 'project.json'));

    const response = await service.read({
      projectSessionId,
      entries: [
        {
          readKey: 'ready',
          projectRelativePath: 'assets/source.lua',
          expectedContentHash: sha256(source),
        },
        {
          readKey: 'hash',
          projectRelativePath: 'assets/source.lua',
          expectedContentHash: `sha256:${'0'.repeat(64)}`,
        },
        {
          readKey: 'utf8',
          projectRelativePath: 'assets/invalid.lua',
          expectedContentHash: sha256(invalidUtf8),
        },
        {
          readKey: 'oversized',
          projectRelativePath: 'assets/oversized.lua',
          expectedContentHash: sha256(oversizedSource),
        },
      ],
    });
    const aggregate = await service.read({
      projectSessionId,
      entries: Array.from({ length: 9 }, (_, index) => ({
        readKey: `aggregate-${index}`,
        projectRelativePath: 'assets/aggregate.lua',
        expectedContentHash: sha256(aggregateSource),
      })),
    });

    expect(response.entries.map((entry) => entry.readKey)).toEqual([
      'ready',
      'hash',
      'utf8',
      'oversized',
    ]);
    expect(response.entries).toEqual([
      expect.objectContaining({ status: 'ready', text: 'return "ready"\n', hadUtf8Bom: true }),
      expect.objectContaining({ status: 'unavailable', code: 'hash-mismatch' }),
      expect.objectContaining({ status: 'unavailable', code: 'invalid-utf8' }),
      expect.objectContaining({ status: 'unavailable', code: 'source-limit' }),
    ]);
    expect(aggregate.entries.slice(0, 8).every((entry) => entry.status === 'ready')).toBe(true);
    expect(aggregate.entries[8]).toMatchObject({
      status: 'unavailable',
      code: 'aggregate-limit',
    });
  });

  it('enforces the source limit against bytes observed after the metadata check', async () => {
    const project = await createWorkspace('growing-source');
    const source = Buffer.alloc(PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes + 1, 0x61);
    await fs.writeFile(path.join(project, 'assets', 'growing.lua'), source);
    const service = new ActiveProjectSessionService();
    const projectSessionId = await service.activateProjectFile(path.join(project, 'project.json'));
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (value, flags) => {
      const file = await originalOpen(value, flags);
      const actual = await file.stat();
      vi.spyOn(file, 'stat').mockResolvedValue({
        dev: actual.dev,
        ino: actual.ino,
        size: 1,
        isFile: () => true,
      } as typeof actual);
      return file;
    });

    const response = await service.read({
      projectSessionId,
      entries: [
        {
          readKey: 'growing',
          projectRelativePath: 'assets/growing.lua',
          expectedContentHash: sha256(source),
        },
      ],
    });

    expect(response.entries[0]).toMatchObject({
      status: 'unavailable',
      code: 'source-limit',
    });
  });
});
