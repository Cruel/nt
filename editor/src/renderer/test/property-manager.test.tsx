import { describe, expect, it } from 'vite-plus/test';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PropertyManager } from '@/components/properties/PropertyManager';

describe('PropertyManager', () => {
  it('shows a delete failure inside the open confirmation dialog', async () => {
    const user = userEvent.setup();

    render(
      <PropertyManager
        valueLabel="Value"
        rows={[
          {
            id: 'locked',
            label: 'Locked',
            type: 'boolean',
            nullable: false,
            value: true,
            valueState: 'normal',
            deletable: true,
          },
        ]}
        emptyLabel="No Properties."
        onDelete={() => 'Delete failed for this Property.'}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Delete Locked' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete Property' }));

    expect(within(dialog).getByText('Delete failed for this Property.')).toBeVisible();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Delete failed for this Property.')).not.toBeInTheDocument();
  });
});
