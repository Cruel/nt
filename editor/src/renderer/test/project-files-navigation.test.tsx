import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
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

function loadProject(navigationMode: 'project' | 'files' = 'project') {
  const project = createAuthoringProject();
  project.editor.explorer.navigationMode = navigationMode;
  project.rooms.utility = {
    id: 'utility',
    label: 'Utility',
    data: defaultRoomData('Utility'),
  };
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
