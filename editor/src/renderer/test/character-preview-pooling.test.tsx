import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { CharacterEditor } from '@/editors/characters/CharacterEditor';
import { PreviewHostPoolProvider } from '@/preview/preview-host-pool';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { PreviewDocument, PreviewMode } from '../../shared/preview-protocol';

const previewControllerMocks = vi.hoisted(() => ({
  setPreviewMode: vi.fn<(mode: PreviewMode) => Promise<void>>().mockResolvedValue(undefined),
  loadPreviewDocument: vi.fn<(document: PreviewDocument) => Promise<void>>().mockResolvedValue(undefined),
  loadSession: vi.fn().mockResolvedValue({
    url: 'http://127.0.0.1:5000/?sessionToken=test-token',
    origin: 'http://127.0.0.1:5000',
    sessionToken: 'test-token',
  }),
}));

vi.mock('@/hooks/use-engine-preview', () => ({
  useEnginePreview: () => ({
    iframeRef: { current: null },
    iframeKey: 0,
    iframeSrc: 'http://127.0.0.1:5000/?sessionToken=test-token',
    session: {
      url: 'http://127.0.0.1:5000/?sessionToken=test-token',
      origin: 'http://127.0.0.1:5000',
      sessionToken: 'test-token',
    },
    loadSession: previewControllerMocks.loadSession,
    setPreviewWheelRouting: vi.fn().mockResolvedValue(undefined),
    setPreviewMode: previewControllerMocks.setPreviewMode,
    loadPreviewDocument: previewControllerMocks.loadPreviewDocument,
  }),
}));

vi.mock('@/components/engine-preview-host', () => ({
  EnginePreviewHost: ({ iframeSrc }: { iframeSrc: string | null }) => (
    <iframe title="NovelTea engine preview" src={iframeSrc ?? undefined} />
  ),
}));

const irisTab: WorkbenchTab = {
  id: 'tab:character-detail:characters:iris',
  title: 'Iris',
  editorType: 'character-detail',
  resource: {
    kind: 'record',
    stableId: 'record:characters:iris',
    collection: 'characters',
    entityId: 'iris',
  },
};

const noahTab: WorkbenchTab = {
  id: 'tab:character-detail:characters:noah',
  title: 'Noah',
  editorType: 'character-detail',
  resource: {
    kind: 'record',
    stableId: 'record:characters:noah',
    collection: 'characters',
    entityId: 'noah',
  },
};

function Harness({ activeTabId, tab }: { activeTabId: string; tab: WorkbenchTab }) {
  return (
    <div style={{ position: 'relative', width: 900, height: 700 }}>
      <PreviewHostPoolProvider groupId="group:characters" activeTabId={activeTabId}>
        <CharacterEditor tab={tab} />
      </PreviewHostPoolProvider>
    </div>
  );
}

function hostElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-preview-host-id]')];
}

beforeEach(() => {
  previewControllerMocks.setPreviewMode.mockClear();
  previewControllerMocks.loadPreviewDocument.mockClear();
  previewControllerMocks.loadSession.mockClear();
  useProjectStore.getState().clearProject();

  const project = createAuthoringProject();
  project.characters.iris = { id: 'iris', label: 'Iris', tags: [], data: defaultCharacterData('Iris') };
  project.characters.noah = { id: 'noah', label: 'Noah', tags: [], data: defaultCharacterData('Noah') };
  useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });
});

describe('CharacterEditor pooled preview', () => {
  it('reuses a warm host and sends a complete character payload for the next character', async () => {
    const { container, rerender } = render(<Harness activeTabId={irisTab.id} tab={irisTab} />);

    await waitFor(() => expect(hostElements(container)).toHaveLength(1));
    await waitFor(() => expect(previewControllerMocks.loadPreviewDocument).toHaveBeenCalledTimes(1));
    expect(previewControllerMocks.setPreviewMode).toHaveBeenLastCalledWith('character');
    expect(previewControllerMocks.loadPreviewDocument).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'character-preview',
      recordId: 'iris',
      data: expect.any(Object),
    }));

    const firstHostId = hostElements(container)[0]?.dataset.previewHostId;

    rerender(<Harness activeTabId={noahTab.id} tab={noahTab} />);

    await waitFor(() => expect(previewControllerMocks.loadPreviewDocument).toHaveBeenCalledTimes(2));
    expect(hostElements(container)).toHaveLength(1);
    expect(hostElements(container)[0]?.dataset.previewHostId).toBe(firstHostId);
    expect(previewControllerMocks.setPreviewMode).toHaveBeenLastCalledWith('character');
    expect(previewControllerMocks.loadPreviewDocument).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'character-preview',
      recordId: 'noah',
      data: expect.any(Object),
    }));
  });
});
