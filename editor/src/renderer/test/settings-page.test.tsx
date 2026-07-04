import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '@/routes/settings';
import { usePreferencesStore } from '@/stores/preferences-store';

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({ value, themeId }: { value: string; themeId?: string }) => (
    <textarea aria-label="source-editor-preview" data-theme-id={themeId} readOnly value={value} />
  ),
}));

describe('SettingsPage code editor theme selector', () => {
  beforeEach(() => {
    vi.spyOn(window.noveltea, 'getAppInfo').mockReturnValue(new Promise(() => {}) as ReturnType<typeof window.noveltea.getAppInfo>);
    usePreferencesStore.setState({
      theme: 'system',
      codeEditorTheme: 'noveltea',
      restoreLastProjectOnStart: true,
      lastProjectPath: null,
    });
  });

  it('opens a preview dialog and applies the cycled theme', () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByRole('button', { name: /NovelTea/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next editor theme' }));
    expect(screen.getByLabelText('source-editor-preview')).toHaveAttribute('data-theme-id', 'abcdef');

    fireEvent.click(screen.getByRole('button', { name: 'Apply Theme' }));
    expect(usePreferencesStore.getState().codeEditorTheme).toBe('abcdef');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not persist preview cycling when cancelled', () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByRole('button', { name: /NovelTea/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Next editor theme' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(usePreferencesStore.getState().codeEditorTheme).toBe('noveltea');
  });
});
