import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { CollectionMasterDetail } from '@/components/collection-master-detail';

const items = [
  { id: 'first', label: 'First' },
  { id: 'second', label: 'Second' },
];

describe('collection master-detail', () => {
  it('renders a selected item with arbitrary row and detail content', () => {
    render(
      <CollectionMasterDetail
        title="Items"
        items={items}
        getKey={(item) => item.id}
        selectedKey="second"
        onSelectedKeyChange={() => undefined}
        emptyState="No items"
        getItemPresentation={(item) => ({ label: item.label })}
        renderDetail={(item) => <div>Editing {item.label}</div>}
      />,
    );

    expect(screen.getByText('Editing Second')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Second' })).toHaveAttribute('aria-current', 'true');
  });

  it('scrolls a newly added detail fully into the nearest scroll container', async () => {
    const renderCollection = (currentItems: typeof items, selectedKey: string | null) => (
      <div data-testid="scroll-container" style={{ height: 100, overflowY: 'auto' }}>
        <CollectionMasterDetail
          items={currentItems}
          getKey={(item) => item.id}
          selectedKey={selectedKey}
          onSelectedKeyChange={() => undefined}
          emptyState="No items"
          getItemPresentation={(item) => ({ label: item.label })}
          renderDetail={(item) => <div>Editing {item.label}</div>}
        />
      </div>
    );

    const { rerender } = render(renderCollection([], null));
    const scrollContainer = screen.getByTestId('scroll-container');
    Object.defineProperties(scrollContainer, {
      scrollHeight: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 100 },
    });
    scrollContainer.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 }) as DOMRect;

    rerender(renderCollection([items[0]], 'first'));
    rerender(renderCollection([{ ...items[0] }], 'first'));
    const detail = scrollContainer.querySelector<HTMLElement>('[data-master-detail-detail]');
    expect(detail).not.toBeNull();
    if (!detail) return;
    detail.getBoundingClientRect = () => ({ top: 80, bottom: 150, height: 70 }) as DOMRect;

    await waitFor(() => expect(scrollContainer.scrollTop).toBe(50));
  });

  it('supports keyboard selection in the shared item list', () => {
    const onSelectedKeyChange = vi.fn();
    render(
      <CollectionMasterDetail
        items={items}
        getKey={(item) => item.id}
        selectedKey="first"
        onSelectedKeyChange={onSelectedKeyChange}
        emptyState="No items"
        getItemPresentation={(item) => ({ label: item.label })}
        renderDetail={(item) => <div>Editing {item.label}</div>}
      />,
    );

    const first = screen.getByRole('button', { name: 'First' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });

    expect(onSelectedKeyChange).toHaveBeenCalledWith('second', items[1], 1);
    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
  });
});
