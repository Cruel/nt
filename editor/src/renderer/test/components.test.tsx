import { describe, it, expect } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

describe('UI Components', () => {
  it('preserves native disabled-button semantics', () => {
    render(<Button disabled>Save</Button>);

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('renders a Select label instead of its internal value', () => {
    render(
      <Select items={[{ value: 'internal-id', label: 'Friendly label' }]} value="internal-id">
        <SelectTrigger aria-label="Example select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="internal-id">Friendly label</SelectItem>
        </SelectContent>
      </Select>,
    );

    const trigger = screen.getByRole('combobox', { name: 'Example select' });
    expect(trigger).toHaveTextContent('Friendly label');
    expect(trigger).not.toHaveTextContent('internal-id');
  });

  it('supports an unset Select entry and aligned popup by default', () => {
    render(
      <Select
        items={[{ value: 'one', label: 'One' }]}
        placeholderItem="Select item"
        value={null}
        open
      >
        <SelectTrigger aria-label="Optional select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">One</SelectItem>
        </SelectContent>
      </Select>,
    );

    expect(screen.getByRole('combobox', { name: 'Optional select' })).toHaveTextContent(
      'Select item',
    );
    expect(screen.getByRole('option', { name: 'Select item' })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="select-content"]')).toHaveAttribute(
      'data-align-trigger',
      'true',
    );
  });

  it('normalizes shorthand Select items through the shared trigger and value model', () => {
    render(
      <Select value="two">
        <SelectItem value="one">One</SelectItem>
        <SelectItem value="two">Two</SelectItem>
      </Select>,
    );

    expect(screen.getByRole('combobox')).toHaveTextContent('Two');
  });
});
