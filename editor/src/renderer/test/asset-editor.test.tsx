import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssetEditor } from '@/editors/assets/AssetEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

const tab: WorkbenchTab = {
  id: 'tab:asset-detail:assets:logo',
  title: 'Logo',
  editorType: 'asset-detail',
  resource: {
    kind: 'record',
    stableId: 'record:assets:logo',
    collection: 'assets',
    entityId: 'logo',
  },
};

function project() {
  const next = createAuthoringProject();
  next.assets.logo = {
    id: 'logo',
    label: 'Logo',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/logo.png' },
      aliases: [],
      extension: '.png',
    },
  };
  return next;
}

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  vi.mocked(window.noveltea.resolveProjectAssetUrl).mockResolvedValue({
    url: 'data:image/png;base64,bW9jaw==',
    absolutePath: '/mock/project/assets/images/logo.png',
  });
});

describe('AssetEditor', () => {
  it('edits asset tags through the shared tag input', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    render(<AssetEditor tab={tab} />);

    fireEvent.change(screen.getByLabelText('Asset tags'), { target: { value: 'Hero,' } });

    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        editor: {
          tags: { records: { hero: { name: 'Hero' } } },
          recordMetadata: { assets: { logo: { tags: ['Hero'] } } },
        },
      }),
    );
  });
});
