import { describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import type { SelectorItem } from '@/workspace/command-palette-search';

const items: SelectorItem[] = [
  { id: 'alpha', kind: 'record', title: 'Alpha', tags: [], collectionTerms: [], actionTerms: [] },
  { id: 'beta', kind: 'record', title: 'Beta', tags: [], collectionTerms: [], actionTerms: [] },
  { id: 'gamma', kind: 'record', title: 'Gamma', tags: [], collectionTerms: [], actionTerms: [] },
];

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
});
