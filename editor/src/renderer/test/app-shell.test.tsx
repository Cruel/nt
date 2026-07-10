import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { AppShell } from '@/components/app-shell';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { editorI18n } from '@/i18n';

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
  it('renders children', async () => {
    await act(async () => {
      renderWithProviders(
        <AppShell>
          <div data-testid="child">Hello</div>
        </AppShell>,
      );
    });
    expect(screen.getByTestId('child')).toHaveTextContent('Hello');
  });

  it('renders the application menu across the top chrome', async () => {
    await act(async () => {
      renderWithProviders(
        <AppShell>
          <div />
        </AppShell>,
      );
    });
    expect(screen.getByLabelText('Application menu')).toBeInTheDocument();
  });

  it('renders translated chrome labels after a language switch', async () => {
    await act(async () => {
      await editorI18n.changeLanguage('pt-BR');
      renderWithProviders(
        <AppShell>
          <div />
        </AppShell>,
      );
    });
    expect(screen.getByLabelText('Menu do aplicativo')).toBeInTheDocument();
  });
});
