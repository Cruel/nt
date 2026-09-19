import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import type { ProjectSourceFile } from '../../shared/project-source-files';
import { searchProjectSourceFiles } from '../../shared/project-search/project-source-search';
import { useProjectStore } from '@/project/project-store';
import { toJsonValue } from '@/project/json-value';
import { useProjectSourceStore } from '@/project/project-source-store';
import { ProjectExplorer } from '@/workspace/ProjectExplorer';
import { useProjectExplorerStore } from '@/workspace/project-explorer-store';
import { buildProjectSourceTab, buildRoomDetailTabForRecord } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { buildEditorProjectStateSnapshot } from '@/workbench/project-editor-state';
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

  it('does not restore obsolete source recovery after switching Projects during source loading', async () => {
    const firstSession = '11111111-1111-4111-8111-111111111111';
    const secondSession = '22222222-2222-4222-8222-222222222222';
    const oldSourceId = helperSource.id;
    const secondSource: ProjectSourceFile = {
      id: 'scripts/second.lua',
      displayPath: 'scripts/second.lua',
      projectRelativePath: 'scripts/second.lua',
      kind: 'lua',
      text: true,
    };
    let resolveFirstList!: (value: { files: readonly ProjectSourceFile[] }) => void;
    vi.mocked(window.noveltea.listProjectSourceFiles).mockImplementation(({ projectSessionId }) => {
      if (projectSessionId === firstSession)
        return new Promise((resolve) => {
          resolveFirstList = resolve;
        });
      return Promise.resolve({ files: [secondSource] });
    });
    vi.mocked(window.noveltea.readProjectTextSources).mockImplementation(async (request) => ({
      entries: request.entries.map((entry) => ({
        status: 'ready' as const,
        readKey: entry.readKey,
        projectRelativePath: entry.projectRelativePath,
        contentHash: `sha256:${'b'.repeat(64)}` as const,
        text: entry.readKey === secondSource.id ? 'return second disk' : 'return first disk',
        hadUtf8Bom: false,
      })),
    }));

    const firstProject = createAuthoringProject();
    firstProject.editor.sourceRecoveryById = {
      [oldSourceId]: {
        file: {
          id: oldSourceId,
          displayPath: oldSourceId,
          projectRelativePath: oldSourceId,
          kind: 'lua',
        },
        text: 'return obsolete recovery',
        baseText: 'return first disk',
        baseContentHash: `sha256:${'a'.repeat(64)}`,
      },
    };
    expect(
      useProjectStore.getState().loadProjectDocument({
        document: firstProject,
        savedDocument: firstProject,
        projectPath: '/mock/first',
        projectFilePath: '/mock/first/project.json',
        projectSessionId: firstSession,
      }),
    ).toBe(true);
    render(<ProjectExplorer nodes={[]} />);
    await waitFor(() =>
      expect(window.noveltea.listProjectSourceFiles).toHaveBeenCalledWith({
        projectSessionId: firstSession,
      }),
    );

    const secondProject = createAuthoringProject();
    act(() => {
      expect(
        useProjectStore.getState().loadProjectDocument({
          document: secondProject,
          savedDocument: secondProject,
          projectPath: '/mock/second',
          projectFilePath: '/mock/second/project.json',
          projectSessionId: secondSession,
        }),
      ).toBe(true);
    });
    await waitFor(() =>
      expect(useProjectSourceStore.getState()).toMatchObject({
        projectSessionId: secondSession,
        textById: { [secondSource.id]: 'return second disk' },
      }),
    );

    resolveFirstList({ files: [helperSource] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useProjectSourceStore.getState().projectSessionId).toBe(secondSession);
    expect(useProjectSourceStore.getState().buffersById).not.toHaveProperty(oldSourceId);
    expect(useProjectSourceStore.getState().buffersById[secondSource.id]).toMatchObject({
      text: 'return second disk',
      dirty: false,
      conflict: null,
    });
  });

  it('coalesces concurrent source refreshes onto the actual in-flight load', async () => {
    let resolveList!: (value: { files: readonly ProjectSourceFile[] }) => void;
    vi.mocked(window.noveltea.listProjectSourceFiles).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );

    const first = useProjectSourceStore.getState().refresh('session-coalesced');
    const second = useProjectSourceStore.getState().refresh('session-coalesced');

    expect(second).toBe(first);
    expect(window.noveltea.listProjectSourceFiles).toHaveBeenCalledTimes(1);
    expect(useProjectSourceStore.getState().loading).toBe(true);

    resolveList({ files: [helperSource] });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(useProjectSourceStore.getState()).toMatchObject({
      projectSessionId: 'session-coalesced',
      loading: false,
      error: null,
    });
  });

  it('waits for initial source loading before restoring same-session recovery', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    let resolveList!: (value: { files: readonly ProjectSourceFile[] }) => void;
    vi.mocked(window.noveltea.listProjectSourceFiles).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    vi.mocked(window.noveltea.readProjectTextSources).mockImplementation(async (request) => ({
      entries: request.entries.map((entry) => ({
        status: 'ready' as const,
        readKey: entry.readKey,
        projectRelativePath: entry.projectRelativePath,
        contentHash: `sha256:${'a'.repeat(64)}` as const,
        text: 'return disk baseline',
        hadUtf8Bom: false,
      })),
    }));

    const project = loadProject('project', (next) => {
      next.editor.sourceRecoveryById = {
        [helperSource.id]: {
          file: {
            id: helperSource.id,
            displayPath: helperSource.displayPath,
            projectRelativePath: helperSource.projectRelativePath,
            kind: helperSource.kind,
          },
          text: 'return initial recovery',
          baseText: 'return disk baseline',
          baseContentHash: `sha256:${'a'.repeat(64)}`,
        },
      };
    });
    render(<ProjectExplorer nodes={[]} />);
    await waitFor(() =>
      expect(window.noveltea.listProjectSourceFiles).toHaveBeenCalledWith({
        projectSessionId: sessionId,
      }),
    );

    const updated = structuredClone(project);
    updated.editor.sourceRecoveryById[helperSource.id]!.text = 'return latest recovery';
    act(() => {
      expect(useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(updated), 0)).toBe(
        true,
      );
    });
    await Promise.resolve();
    expect(useProjectSourceStore.getState().buffersById).not.toHaveProperty(helperSource.id);

    resolveList({ files: [helperSource] });
    await waitFor(() =>
      expect(useProjectSourceStore.getState().buffersById[helperSource.id]).toMatchObject({
        text: 'return latest recovery',
        baseText: 'return disk baseline',
        dirty: true,
        conflict: null,
      }),
    );
    expect(window.noveltea.listProjectSourceFiles).toHaveBeenCalledTimes(1);
  });

  it('does not restore source recovery when the initial source load fails', async () => {
    vi.mocked(window.noveltea.listProjectSourceFiles).mockRejectedValueOnce(
      new Error('source inventory unavailable'),
    );
    loadProject('project', (project) => {
      project.editor.sourceRecoveryById = {
        [helperSource.id]: {
          file: {
            id: helperSource.id,
            displayPath: helperSource.displayPath,
            projectRelativePath: helperSource.projectRelativePath,
            kind: helperSource.kind,
          },
          text: 'return should not restore',
          baseText: 'return disk baseline',
          baseContentHash: `sha256:${'a'.repeat(64)}`,
        },
      };
    });

    render(<ProjectExplorer nodes={[]} />);

    await waitFor(() =>
      expect(useProjectSourceStore.getState()).toMatchObject({
        loading: false,
        error: 'source inventory unavailable',
      }),
    );
    expect(useProjectSourceStore.getState().buffersById).not.toHaveProperty(helperSource.id);
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

  it('persists dirty source buffers in editor recovery and restores them against the disk baseline', async () => {
    loadProject();
    await useProjectSourceStore.getState().refresh('session-source');
    useProjectSourceStore.getState().setText(helperSource.id, 'return recovered local');
    const recovered = buildEditorProjectStateSnapshot().sourceRecoveryById;
    expect(recovered[helperSource.id]).toMatchObject({
      text: 'return recovered local',
      baseText: 'return unreferenced_magic_helper()',
    });

    useProjectSourceStore.getState().clear();
    await useProjectSourceStore.getState().refresh('session-source');
    useProjectSourceStore.getState().restoreRecovery(recovered);

    expect(useProjectSourceStore.getState().buffersById[helperSource.id]).toMatchObject({
      text: 'return recovered local',
      baseText: 'return unreferenced_magic_helper()',
      dirty: true,
      conflict: null,
    });
  });

  it('keeps edits made while a source save is in flight dirty against the submitted baseline', async () => {
    await useProjectSourceStore.getState().refresh('session-source');
    useProjectSourceStore.getState().setText(helperSource.id, 'return submitted');
    let resolveWrite!: (
      value: Awaited<ReturnType<typeof window.noveltea.writeProjectSource>>,
    ) => void;
    vi.mocked(window.noveltea.writeProjectSource).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve;
        }),
    );

    const saving = useProjectSourceStore.getState().save(helperSource.id);
    useProjectSourceStore.getState().setText(helperSource.id, 'return typed while saving');
    resolveWrite({
      ok: true,
      success: true,
      sourceId: helperSource.id,
      contentHash: `sha256:${'d'.repeat(64)}`,
    });

    await expect(saving).resolves.toBe(true);
    expect(useProjectSourceStore.getState().buffersById[helperSource.id]).toMatchObject({
      text: 'return typed while saving',
      baseText: 'return submitted',
      dirty: true,
      conflict: null,
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
