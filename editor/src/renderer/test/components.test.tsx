import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('UI Components', () => {
  it('renders button variants', () => {
    const { rerender } = render(<Button>Default</Button>, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText('Default')).toHaveClass('bg-primary');

    rerender(
      <Button variant="destructive">Delete</Button>,
    );
    expect(screen.getByText('Delete')).toHaveClass('bg-destructive');

    rerender(<Button variant="ghost">Ghost</Button>);
    expect(screen.getByText('Ghost')).toHaveClass('hover:bg-accent');
  });

  it('renders a badge', () => {
    render(<Badge>Beta</Badge>, { wrapper: createWrapper() });
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toHaveClass('bg-primary');
  });

  it('renders a skeleton', () => {
    const { container } = render(
      <Skeleton className="h-4 w-full" data-testid="skel" />,
      { wrapper: createWrapper() },
    );
    const skel = container.querySelector('.animate-pulse');
    expect(skel).toBeInTheDocument();
  });
});
