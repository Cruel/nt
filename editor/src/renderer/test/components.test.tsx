import { describe, it, expect } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { Button } from '@/components/ui/button';

describe('UI Components', () => {
  it('preserves native disabled-button semantics', () => {
    render(<Button disabled>Save</Button>);

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
