import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import type { SelectorItem } from '@/workspace/command-palette-search';
import { useProjectStore } from '@/project/project-store';

const items: SelectorItem[] = [
  { id: 'alpha', kind: 'record', title: 'Alpha', tags: [], collectionTerms: [], actionTerms: [] },
  { id: 'beta', kind: 'record', title: 'Beta', tags: [], collectionTerms: [], actionTerms: [] },
  { id: 'gamma', kind: 'record', title: 'Gamma', tags: [], collectionTerms: [], actionTerms: [] },
];

beforeEach(() => {
  useProjectStore.getState().clearProject();
  vi.mocked(window.noveltea.resolveProjectAssetUrl).mockClear();
});

describe('SearchSelectorDialog', () => {
  it('pins the selected item to the top of the results', () => {
    render(
      <SearchSelectorDialog
        open
        title="Pick one"
        placeholder="Search"
        emptyMessage="Empty"
        items={items}
        selectedId="gamma"
        onSelect={vi.fn()}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'a' } });

    const resultButtons = screen
      .getAllByRole('button')
      .filter(
        (button) =>
          button.textContent?.includes('Alpha') ||
          button.textContent?.includes('Beta') ||
          button.textContent?.includes('Gamma'),
      );
    expect(resultButtons[0]).toHaveTextContent('Gamma');
  });

  it('shows the selected item even when the search has no matches', () => {
    render(
      <SearchSelectorDialog
        open
        title="Pick one"
        placeholder="Search"
        emptyMessage="Empty"
        items={items}
        selectedId="gamma"
        onSelect={vi.fn()}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'zzz' } });

    const resultButtons = screen
      .getAllByRole('button')
      .filter(
        (button) =>
          button.textContent?.includes('Alpha') ||
          button.textContent?.includes('Beta') ||
          button.textContent?.includes('Gamma'),
      );
    expect(resultButtons[0]).toHaveTextContent('Gamma');
    expect(screen.getByText('Empty')).toBeInTheDocument();
  });

  it('can toggle view all to reveal items beyond the default limit', () => {
    const manyItems: SelectorItem[] = Array.from({ length: 30 }, (_value, index) => ({
      id: `item-${index + 1}`,
      kind: 'record',
      title: `Item ${index + 1}`,
      tags: [],
      collectionTerms: [],
      actionTerms: [],
    }));

    render(
      <SearchSelectorDialog
        open
        title="Pick one"
        placeholder="Search"
        emptyMessage="Empty"
        items={manyItems}
        onSelect={vi.fn()}
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.queryByText('Item 30')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('View all results'));
    expect(screen.getByLabelText('Show limited results')).toBeInTheDocument();
    expect(screen.getByText('Item 30')).toBeInTheDocument();
  });

  it('renders image results through the thumbnail request path', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: { project: { schema: 'noveltea.authoring.project', version: 2 } },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
    });
    const imageItems: SelectorItem[] = [
      {
        id: 'logo',
        kind: 'record',
        title: 'Logo',
        tags: [],
        collectionTerms: [],
        actionTerms: [],
        preview: {
          kind: 'image',
          label: 'Logo',
          source: {
            projectRelativePath: 'assets/images/logo.png',
            contentHash: `sha256:${'b'.repeat(64)}`,
            width: 1920,
            height: 1080,
            orientation: 1,
          },
        },
      },
    ];

    render(
      <SearchSelectorDialog
        open
        title="Pick image"
        placeholder="Search"
        emptyMessage="Empty"
        items={imageItems}
        onSelect={vi.fn()}
        onOpenChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(window.noveltea.requestImageThumbnail).toHaveBeenCalled());
    expect(window.noveltea.requestImageThumbnail).toHaveBeenCalledWith({
      source: {
        projectFilePath: '/mock/project/project.json',
        projectRelativePath: 'assets/images/logo.png',
        contentHash: `sha256:${'b'.repeat(64)}`,
        width: 1920,
        height: 1080,
        orientation: 1,
      },
      variant: { kind: 'profile', profile: 'list' },
    });
    expect(window.noveltea.resolveProjectAssetUrl).not.toHaveBeenCalled();
    expect(await screen.findByAltText('Logo')).toHaveAttribute(
      'src',
      `noveltea-thumbnail://image-v2/aa/${'a'.repeat(64)}.webp`,
    );
  });
});
