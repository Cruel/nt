import { describe, expect, it } from 'vite-plus/test';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  compareProjectWorkspaceUnicodeCodePoints,
  searchProjectWorkspaceSnapshot,
} from '../../shared/project-workspace';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { stripEditorProjectState } from '../../shared/project-schema/editor-project-state';

function workspaceFor(project = createAuthoringProject({ id: 'headless', name: 'Headless' })) {
  return new ProjectWorkspaceService(
    new InMemoryProjectWorkspaceFileSystem({
      '/projects/headless/project.json': `${JSON.stringify(project, null, 2)}\n`,
    }),
  );
}

describe('ProjectWorkspaceService', () => {
  it('uses Unicode code-point ordering for deterministic snapshot maps', () => {
    expect(['ä', 'z', 'Z'].sort(compareProjectWorkspaceUnicodeCodePoints)).toEqual(['Z', 'z', 'ä']);
  });

  it('loads and validates a current monolithic project without Electron', async () => {
    const opened = await workspaceFor().open('/projects/headless');

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.snapshot.projectRoot).toBe('/projects/headless');
    expect(opened.snapshot.manifestPath).toBe('/projects/headless/project.json');
    expect(opened.snapshot.canonicalSourceFiles).toEqual(['project.json']);
    expect(opened.snapshot.fileRevisions['project.json']).toMatchObject({
      contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(opened.snapshot.saveUnitFileOwnership['project:settings']).toEqual({
      file: 'project.json',
      paths: ['/project', '/settings', '/startupHook', '/entrypoint'],
    });
    expect(opened.snapshot.externalSourceDescriptors).toEqual([]);
    expect(opened.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });

  it('preserves the on-disk baseline when decoding repairs an assembled project', async () => {
    const project = createAuthoringProject({ id: 'repaired', name: 'Repaired' });
    project.settings.presentation.roomNavigationTransition = {
      ...project.settings.presentation.roomNavigationTransition,
      kind: 'unknown' as never,
    };
    const savedContentProject = stripEditorProjectState(project) as Record<string, unknown>;
    const workspace = new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem({
        '/projects/repaired/project.json': `${JSON.stringify(savedContentProject, null, 2)}\n`,
      }),
    );

    const opened = await workspace.open('/projects/repaired');

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.savedContentProject).toEqual(savedContentProject);
    expect(opened.contentProject).toMatchObject({
      settings: { presentation: { roomNavigationTransition: { kind: 'cut' } } },
    });
    expect(opened.contentProject).not.toEqual(opened.savedContentProject);
  });

  it('exposes the compiler, graph, source-analysis, and search seams from one snapshot', async () => {
    const project = createAuthoringProject({ id: 'seams', name: 'Snapshot Seams' });
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    const workspace = workspaceFor(project);
    const opened = await workspace.open('/projects/headless');

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(workspace.publishCompiledArtifact(opened.snapshot)).toMatchObject({
      diagnostics: expect.any(Array),
    });
    expect(workspace.buildDependencyGraph(opened.snapshot).nodesByKey.size).toBeGreaterThan(0);
    expect(
      workspace.analyzeSources(opened.snapshot, { entriesByAssetId: new Map() }),
    ).toBeInstanceOf(Map);
    expect(searchProjectWorkspaceSnapshot(opened.snapshot, { text: 'foyer' }).results).toEqual([
      expect.objectContaining({ document: expect.objectContaining({ entityId: 'foyer' }) }),
    ]);
  });

  it('keeps current monolithic discovery and rejects an invalid document', async () => {
    const workspace = new ProjectWorkspaceService(
      new InMemoryProjectWorkspaceFileSystem({ '/projects/broken/game.json': '{not json' }),
    );
    const opened = await workspace.open('/projects/broken');

    expect(opened).toMatchObject({
      ok: false,
      projectRoot: '/projects/broken',
      manifestPath: '/projects/broken/game.json',
      diagnostics: [expect.objectContaining({ code: 'authoring.schema.unsupported' })],
    });
  });
});
