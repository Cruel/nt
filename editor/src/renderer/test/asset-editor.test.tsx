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
      contentHash: `sha256:${'a'.repeat(64)}`,
      byteSize: 123,
      imageMetadata: { width: 256, height: 256, hasAlpha: true, orientation: 1 },
    },
  };
  return next;
}

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  vi.mocked(window.noveltea.resolveProjectOriginalAssetUrl).mockResolvedValue({
    ok: true,
    url: 'noveltea-asset://source/session/logo',
  });
  vi.mocked(window.noveltea.inspectProjectAssetMetadata).mockClear();
  vi.mocked(window.noveltea.inspectProjectAssetMetadata).mockResolvedValue({
    ok: true,
    status: 'ready',
    kind: 'image',
    contentHash: `sha256:${'a'.repeat(64)}`,
    groups: [],
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

  it('loads and renders grouped embedded metadata beneath the Asset preview', async () => {
    let resolveInspection!: (
      value: Awaited<ReturnType<typeof window.noveltea.inspectProjectAssetMetadata>>,
    ) => void;
    vi.mocked(window.noveltea.inspectProjectAssetMetadata).mockReturnValue(
      new Promise((resolve) => {
        resolveInspection = resolve;
      }),
    );
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });

    render(<AssetEditor tab={tab} />);

    expect(screen.getByText('Loading embedded metadata…')).toBeInTheDocument();
    expect(window.noveltea.inspectProjectAssetMetadata).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'logo',
    );

    resolveInspection({
      ok: true,
      status: 'ready',
      kind: 'image',
      contentHash: `sha256:${'a'.repeat(64)}`,
      groups: [
        {
          id: 'PNG',
          namespace: 'PNG',
          items: [
            {
              id: 'PNG/prompt/0',
              key: 'prompt',
              value: '{"prompt":"Moonlit room"}',
              valueKind: 'json',
            },
          ],
        },
      ],
    });

    expect(await screen.findByText('Embedded metadata')).toBeInTheDocument();
    expect(screen.getByText('PNG')).toBeInTheDocument();
    expect(screen.getByText('prompt')).toBeInTheDocument();
    expect(screen.getByText('{"prompt":"Moonlit room"}')).toBeInTheDocument();
    expect(screen.getByText('Original name')).toBeInTheDocument();
  });

  it('renders recognized unverified C2PA provenance above the exhaustive raw metadata', async () => {
    vi.mocked(window.noveltea.inspectProjectAssetMetadata).mockResolvedValue({
      ok: true,
      status: 'ready',
      kind: 'image',
      contentHash: `sha256:${'a'.repeat(64)}`,
      c2pa: { trust: 'unverified' },
      provenance: {
        stages: [
          {
            id: 'openai-created-0',
            role: 'generated',
            provider: { id: 'openai', label: 'OpenAI' },
            model: { id: 'openai.gpt-image', label: 'gpt-image 2.0' },
          },
          {
            id: 'google-synthid-1',
            role: 'edited',
            provider: { id: 'google', label: 'Google' },
            tool: { id: 'google.synthid', label: 'SynthID' },
          },
        ],
      },
      groups: [
        {
          id: 'C2PA',
          namespace: 'C2PA',
          items: [
            {
              id: 'C2PA/action/0',
              key: 'actions[0].action',
              value: 'c2pa.created',
              valueKind: 'text',
            },
          ],
        },
      ],
    });
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });

    render(<AssetEditor tab={tab} />);

    expect(await screen.findByText('Generated with gpt-image 2.0')).toBeInTheDocument();
    expect(screen.getByText('Edited with SynthID')).toBeInTheDocument();
    expect(screen.getByText('Embedded claim · unverified')).toBeInTheDocument();
    expect(screen.queryByText('Verified provenance')).not.toBeInTheDocument();
    expect(screen.getByText('C2PA')).toBeInTheDocument();
    expect(screen.getByText('actions[0].action')).toBeInTheDocument();
    expect(screen.getByText('c2pa.created')).toBeInTheDocument();
  });

  it('shows successful-empty, failure, and unsupported metadata inspection states', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });

    const emptyView = render(<AssetEditor tab={tab} />);
    expect(await screen.findByText('No embedded metadata found.')).toBeInTheDocument();
    emptyView.unmount();

    vi.mocked(window.noveltea.inspectProjectAssetMetadata).mockResolvedValue({
      ok: false,
      status: 'failure',
      code: 'revision-mismatch',
      boundaryCode: 'source-revision-mismatch',
      message: 'Asset source changed before inspection completed.',
    });
    const failureView = render(<AssetEditor tab={tab} />);
    expect(
      await screen.findByText('Asset source changed before inspection completed.'),
    ).toBeInTheDocument();
    failureView.unmount();

    const audioProject = project();
    audioProject.assets.logo!.data = {
      ...audioProject.assets.logo!.data,
      kind: 'audio',
      imageMetadata: null,
    };
    useProjectStore.getState().loadProjectDocument({
      document: audioProject,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
    vi.mocked(window.noveltea.inspectProjectAssetMetadata).mockResolvedValue({
      ok: true,
      status: 'unsupported',
      kind: 'audio',
      contentHash: `sha256:${'a'.repeat(64)}`,
      groups: [],
    });

    render(<AssetEditor tab={tab} />);
    expect(
      await screen.findByText('Embedded metadata inspection is not supported for this Asset.'),
    ).toBeInTheDocument();
  });

  it('requests fresh metadata when the Asset content hash changes', async () => {
    const firstProject = project();
    useProjectStore.getState().loadProjectDocument({
      document: firstProject,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
    render(<AssetEditor tab={tab} />);
    await waitFor(() =>
      expect(window.noveltea.inspectProjectAssetMetadata).toHaveBeenCalledTimes(1),
    );

    const changedProject = project();
    changedProject.assets.logo!.data = {
      ...changedProject.assets.logo!.data,
      contentHash: `sha256:${'b'.repeat(64)}`,
    };
    useProjectStore.getState().loadProjectDocument({
      document: changedProject,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });

    await waitFor(() =>
      expect(window.noveltea.inspectProjectAssetMetadata).toHaveBeenCalledTimes(2),
    );
  });
});
