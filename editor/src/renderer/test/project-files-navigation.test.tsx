import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import type { ProjectSourceFile } from '../../shared/project-source-files';
import { searchProjectSourceFiles } from '../../shared/project-search/project-source-search';
import { useProjectStore } from '@/project/project-store';
import { useProjectSourceStore } from '@/project/project-source-store';
import { ProjectExplorer } from '@/workspace/ProjectExplorer';
import { useProjectExplorerStore } from '@/workspace/project-explorer-store';
import { buildProjectSourceTab, buildRoomDetailTabForRecord } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import {
  buildCommandPaletteItems,
  searchCommandPaletteItems,
} from '@/workspace/command-palette-search';

const helperSource: ProjectSourceFile = {
  id: 'scripts/helpers/utility.lua',
  displayPath: 'scripts/helpers/utility.lua',
  projectRelativePath: 'scripts/helpers/utility.lua',
  kind: 'lua',
  text: true,
};

function loadProject(
  navigationMode: 'project' | 'files' = 'project',
  configure?: (project: ReturnType<typeof createAuthoringProject>) => void,
) {
  const project = createAuthoringProject();
  project.editor.explorer.navigationMode = navigationMode;
  project.rooms.utility = {
    id: 'utility',
    label: 'Utility',
    data: defaultRoomData('Utility'),
  };
  configure?.(project);
  expect(
    useProjectStore.getState().loadProjectDocument({
      document: project,
      savedDocument: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId: '11111111-1111-4111-8111-111111111111',
    }),
  ).toBe(true);
  return project;
}

describe('project Files navigation', () => {
  beforeEach(() => {
    useProjectStore.getState().clearProject();
    useProjectSourceStore.getState().clear();
    useProjectExplorerStore.getState().hydrate(undefined, undefined);
    useWorkbenchStore.getState().resetWorkbench();
    vi.mocked(window.noveltea.listProjectSourceFiles).mockReset();
    vi.mocked(window.noveltea.listProjectSourceFiles).mockResolvedValue({ files: [helperSource] });
    vi.mocked(window.noveltea.readProjectTextSources).mockReset();
    vi.mocked(window.noveltea.readProjectTextSources).mockImplementation(async (request) => ({
      entries: request.entries.map((entry) => ({
        status: 'ready' as const,
        readKey: entry.readKey,
        projectRelativePath: entry.projectRelativePath,
        contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        text: 'return unreferenced_magic_helper()',
        hadUtf8Bom: false,
      })),
    }));
  });

  it('follows source and semantic tabs while respecting a manual mode change until the tab changes', async () => {
    loadProject();
    render(<ProjectExplorer nodes={[]} />);
    await waitFor(() => expect(useProjectSourceStore.getState().files).toHaveLength(1));

    act(() => useWorkbenchStore.getState().openTab(buildProjectSourceTab(helperSource)));
    await waitFor(() => expect(useProjectExplorerStore.getState().navigationMode).toBe('files'));

    act(() => useProjectExplorerStore.getState().setNavigationMode('project'));
    act(() => useWorkbenchStore.getState().openTab(buildProjectSourceTab(helperSource)));
    expect(useProjectExplorerStore.getState().navigationMode).toBe('project');

    act(() =>
      useWorkbenchStore.getState().openTab(buildRoomDetailTabForRecord('utility', 'Utility')),
    );
    expect(useProjectExplorerStore.getState().navigationMode).toBe('project');

    act(() => useWorkbenchStore.getState().openTab(buildProjectSourceTab(helperSource)));
    await waitFor(() => expect(useProjectExplorerStore.getState().navigationMode).toBe('files'));
    expect(useProjectExplorerStore.getState().serializeExplorer().navigationMode).toBe('files');
  });

  it('restores a persisted manual navigation mode until the active tab changes', async () => {
    loadProject('files');
    act(() =>
      useWorkbenchStore.getState().openTab(buildRoomDetailTabForRecord('utility', 'Utility')),
    );

    render(<ProjectExplorer nodes={[]} />);

    await waitFor(() => expect(useProjectExplorerStore.getState().navigationMode).toBe('files'));
  });

  it('reuses the canonical source tab and permits an explicit duplicate instance', () => {
    const canonical = buildProjectSourceTab(helperSource);
    act(() => useWorkbenchStore.getState().openTab(canonical));
    act(() => useWorkbenchStore.getState().openTab(canonical));
    expect(Object.keys(useWorkbenchStore.getState().tabsById)).toEqual([canonical.id]);

    act(() =>
      useWorkbenchStore
        .getState()
        .openTab({ ...canonical, id: `${canonical.id}:duplicate:test` }, { duplicate: true }),
    );
    expect(Object.keys(useWorkbenchStore.getState().tabsById)).toHaveLength(2);
  });

  it('reloads clean external source changes and surfaces dirty-buffer conflicts', async () => {
    let diskText = 'return 1';
    let diskHash = `sha256:${'a'.repeat(64)}` as const;
    vi.mocked(window.noveltea.readProjectTextSources).mockImplementation(async (request) => ({
      entries: request.entries.map((entry) => ({
        status: 'ready' as const,
        readKey: entry.readKey,
        projectRelativePath: entry.projectRelativePath,
        contentHash: diskHash,
        text: diskText,
        hadUtf8Bom: false,
      })),
    }));
    await useProjectSourceStore.getState().refresh('session-source');
    expect(useProjectSourceStore.getState().buffersById[helperSource.id]?.text).toBe('return 1');

    diskText = 'return 2';
    diskHash = `sha256:${'b'.repeat(64)}`;
    await useProjectSourceStore.getState().reconcileExternal('session-source');
    expect(useProjectSourceStore.getState().buffersById[helperSource.id]).toMatchObject({
      text: 'return 2',
      dirty: false,
      conflict: null,
    });

    useProjectSourceStore.getState().setText(helperSource.id, 'return local');
    diskText = 'return 3';
    diskHash = `sha256:${'c'.repeat(64)}`;
    await useProjectSourceStore.getState().reconcileExternal('session-source');
    expect(useProjectSourceStore.getState().buffersById[helperSource.id]).toMatchObject({
      text: 'return local',
      dirty: true,
      conflict: {
        externalExists: true,
        externalText: 'return 3',
        externalContentHash: diskHash,
      },
    });
  });

  it('preserves local text across external delete and can explicitly recreate it with Keep Mine', async () => {
    await useProjectSourceStore.getState().refresh('session-source');
    useProjectSourceStore.getState().setText(helperSource.id, 'return local');
    vi.mocked(window.noveltea.listProjectSourceFiles).mockResolvedValueOnce({ files: [] });

    await useProjectSourceStore.getState().reconcileExternal('session-source');

    expect(useProjectSourceStore.getState().buffersById[helperSource.id]).toMatchObject({
      text: 'return local',
      dirty: true,
      conflict: {
        externalExists: false,
        externalContentHash: 'absent',
      },
    });
    vi.mocked(window.noveltea.writeProjectSource).mockResolvedValueOnce({
      ok: true,
      success: true,
      sourceId: helperSource.id,
      contentHash: `sha256:${'d'.repeat(64)}`,
    });

    await expect(useProjectSourceStore.getState().save(helperSource.id, true)).resolves.toBe(true);
    expect(window.noveltea.writeProjectSource).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: helperSource.id,
        expectedRevision: 'absent',
        text: 'return local',
      }),
    );
    expect(useProjectSourceStore.getState().buffersById[helperSource.id]).toMatchObject({
      text: 'return local',
      dirty: false,
      conflict: null,
    });
  });

  it('keeps open source tab identity and semantic Layout references while remapping after a move', async () => {
    loadProject('project', (project) => {
      const layout = defaultLayoutData('HUD', 'document');
      layout.dependencies.scripts = [helperSource.id];
      layout.rml.sourceText = `<rml><head><script src="project:/${helperSource.id}"/></head><body></body></rml>`;
      project.layouts.hud = { id: 'hud', label: 'HUD', data: layout };
    });
    await useProjectSourceStore.getState().refresh('session-source');
    const tab = buildProjectSourceTab(helperSource);
    act(() => useWorkbenchStore.getState().openTab(tab));
    vi.mocked(window.noveltea.mutateProjectSources).mockResolvedValueOnce({
      ok: true,
      success: true,
      pathRemap: { [helperSource.id]: 'scripts/lib/utility.lua' },
      changedPaths: [helperSource.id, 'scripts/lib/utility.lua'],
    });
    vi.mocked(window.noveltea.listProjectSourceFiles).mockResolvedValueOnce({
      files: [
        {
          ...helperSource,
          id: 'scripts/lib/utility.lua',
          displayPath: 'scripts/lib/utility.lua',
          projectRelativePath: 'scripts/lib/utility.lua',
        },
      ],
    });

    const result = await useProjectSourceStore.getState().mutate({
      kind: 'move',
      fromPath: helperSource.id,
      toPath: 'scripts/lib/utility.lua',
    });

    expect(result.success).toBe(true);
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toMatchObject({
      id: tab.id,
      title: 'utility.lua',
      resource: {
        kind: 'source',
        sourceId: 'scripts/lib/utility.lua',
        stableId: 'source:scripts/lib/utility.lua',
      },
    });
    const project = useProjectStore.getState().document as ReturnType<
      typeof createAuthoringProject
    >;
    const layout = project.layouts.hud!.data as ReturnType<typeof defaultLayoutData>;
    expect(layout.dependencies.scripts).toEqual(['scripts/lib/utility.lua']);
    expect(layout.rml.sourceText).toContain('project:/scripts/lib/utility.lua');
  });

  it('indexes unreferenced source contents and keeps source quick-open results distinct from records', () => {
    const project = loadProject();
    const search = searchProjectSourceFiles(
      [helperSource],
      { [helperSource.id]: 'return unreferenced_magic_helper()' },
      'unreferenced_magic_helper',
    );
    expect(search.results.map((result) => result.document.id)).toEqual([
      `source:${helperSource.id}`,
    ]);

    const quickOpen = searchCommandPaletteItems(
      buildCommandPaletteItems(project, undefined, [helperSource]),
      'utility',
    );
    expect(new Set(quickOpen.map((result) => result.item.kind))).toEqual(
      new Set(['record', 'source']),
    );
  });
});
