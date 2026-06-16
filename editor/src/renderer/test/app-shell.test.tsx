import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppShell } from '@/components/app-shell';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/' }),
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe('AppShell', () => {
  it('renders children', () => {
    renderWithProviders(
      <AppShell>
        <div data-testid="child">Hello</div>
      </AppShell>,
    );
    expect(screen.getByTestId('child')).toHaveTextContent('Hello');
  });

  it('renders the NovelTea brand', () => {
    renderWithProviders(
      <AppShell>
        <div />
      </AppShell>,
    );
    expect(screen.getByText('NovelTea')).toBeInTheDocument();
  });
});
