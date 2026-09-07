import { fireEvent, render, screen, within } from '@testing-library/react';
import { Circle, Square } from 'lucide-react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CategorizedEditorLayout } from '@/components/CategorizedEditorLayout';
import { usePreferencesStore } from '@/stores/preferences-store';

describe('CategorizedEditorLayout', () => {
  beforeEach(() => {
    usePreferencesStore.setState({ categorizedEditorSidebarCollapsed: false });
  });
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

  it('persists the user sidebar preference without changing category navigation', () => {
    render(
      <CategorizedEditorLayout
        categories={[{ id: 'general', label: 'General', icon: Circle }]}
        activeCategory="general"
        onCategoryChange={() => undefined}
        navigationLabel="Editor categories"
        header={<h1>Editor</h1>}
      >
        <p>Category content</p>
      </CategorizedEditorLayout>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(usePreferencesStore.getState().categorizedEditorSidebarCollapsed).toBe(true);
    expect(screen.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });
});
