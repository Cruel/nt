import { describe, expect, it } from 'vite-plus/test';
import {
  createNovelTeaProject,
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
} from '../../shared/project-workspace';

describe('NovelTea project creation service', () => {
  it('rejects an existing empty destination', async () => {
    const fileSystem = new InMemoryProjectWorkspaceFileSystem();
    await fileSystem.createDirectory('/projects/empty');
    const workspace = new ProjectWorkspaceService(fileSystem);

    await expect(
      createNovelTeaProject(fileSystem, workspace, {
        projectName: 'Existing',
        projectDirectory: '/projects/empty',
      }),
    ).rejects.toThrow('already exists');

    expect(await fileSystem.inspect('/projects/empty')).toBe('directory');
    expect(await fileSystem.listDirectory('/projects/empty')).toEqual([]);
  });

  it('does not create the destination when activation fails', async () => {
    const fileSystem = new InMemoryProjectWorkspaceFileSystem();
    const workspace = new ProjectWorkspaceService(fileSystem);

    await expect(
      createNovelTeaProject(fileSystem, workspace, {
        projectName: 'Rollback',
        projectDirectory: '/projects/rollback',
        beforeActivate() {
          throw new Error('injected activation failure');
        },
      }),
    ).rejects.toThrow('injected activation failure');

    expect(await fileSystem.inspect('/projects/rollback')).toBe('missing');
  });

  it('fails when the destination appears before activation', async () => {
    const fileSystem = new InMemoryProjectWorkspaceFileSystem();
    const workspace = new ProjectWorkspaceService(fileSystem);

    await expect(
      createNovelTeaProject(fileSystem, workspace, {
        projectName: 'Raced',
        projectDirectory: '/projects/raced',
        beforeActivate() {
          return fileSystem.createDirectory('/projects/raced');
        },
      }),
    ).rejects.toThrow('created while the project was being prepared');

    expect(await fileSystem.inspect('/projects/raced')).toBe('directory');
  });
});
