import { fireEvent, render, screen, within } from '@testing-library/react';
import { Circle, Square } from 'lucide-react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { CategorizedEditorLayout } from '@/components/CategorizedEditorLayout';

describe('CategorizedEditorLayout', () => {
  it('renders accessible shared category navigation and reports selection changes', () => {
    const onCategoryChange = vi.fn();
    render(
      <CategorizedEditorLayout
        categories={[
          { id: 'general', label: 'General', description: 'General settings.', icon: Circle },
          {
            id: 'items',
            label: 'Items',
            description: 'Manage items.',
            icon: Square,
            trailing: 3,
          },
        ]}
        activeCategory="general"
        onCategoryChange={onCategoryChange}
        navigationLabel="Editor categories"
        header={<h1>Editor</h1>}
      >
        <p>Category content</p>
      </CategorizedEditorLayout>,
    );

    const navigation = screen.getByRole('navigation', { name: 'Editor categories' });
    expect(within(navigation).getByRole('button', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const items = within(navigation).getByRole('button', { name: 'Items' });
    expect(items).toHaveTextContent('3');
    expect(screen.getByText('General settings.')).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveClass('overflow-y-auto');

    fireEvent.click(items);
    expect(onCategoryChange).toHaveBeenCalledWith('items');
  });
});
