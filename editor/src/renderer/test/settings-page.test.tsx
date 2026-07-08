import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '@/routes/settings';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useComfyUiStore } from '@/comfyui/comfyui-store';

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
      language: 'system',
      codeEditorTheme: 'noveltea',
      restoreLastProjectOnStart: true,
      showPreviewFpsCounter: false,
      lastProjectPath: null,
      defaultProjectDirectory: null,
      comfyUiConfig: {
        enabled: false,
        serverUrl: 'http://127.0.0.1:8000',
        defaultWorkflowId: 'flux2-klein-text-to-image',
        defaultWorkflows: {
          'image.generate': 'flux2-klein-text-to-image',
          'image.edit': 'flux2-klein-image-edit',
        },
        requestTimeoutMs: 15000,
        connectionCheckIntervalMs: 10000,
      },
    });
    useComfyUiStore.getState().hydrateFromPreferences();
    vi.spyOn(window.noveltea, 'getDefaultProjectDirectory').mockResolvedValue('/home/test/Documents/NovelTea');
    vi.spyOn(window.noveltea, 'selectDirectory').mockResolvedValue('/tmp/NovelTea');
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

  it('renders the editor language selector options', () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'Pseudo-localized' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Portuguese (Brazil)' })).toBeInTheDocument();
  });

  it('toggles the preview FPS counter preference', () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByRole('switch', { name: 'Show FPS counter' }));
    expect(usePreferencesStore.getState().showPreviewFpsCounter).toBe(true);
  });

  it('shows and changes the default project directory preference', async () => {
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByLabelText('Default project directory')).toHaveValue('/home/test/Documents/NovelTea'));
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));

    await waitFor(() => expect(usePreferencesStore.getState().defaultProjectDirectory).toBe('/tmp/NovelTea'));
    expect(screen.getByLabelText('Default project directory')).toHaveValue('/tmp/NovelTea');
  });

  it('resets the default project directory to the app default', async () => {
    usePreferencesStore.getState().setDefaultProjectDirectory('/tmp/NovelTea');
    render(<SettingsPage />);

    expect(screen.getByLabelText('Default project directory')).toHaveValue('/tmp/NovelTea');
    fireEvent.click(screen.getByRole('button', { name: 'Reset default project directory' }));

    await waitFor(() => expect(screen.getByLabelText('Default project directory')).toHaveValue('/home/test/Documents/NovelTea'));
    expect(usePreferencesStore.getState().defaultProjectDirectory).toBe(null);
  });

  it('rejects default project directories containing spaces', async () => {
    vi.mocked(window.noveltea.selectDirectory).mockResolvedValue('/tmp/NovelTea Projects');
    render(<SettingsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));

    expect(await screen.findByText('Project directory paths must not contain spaces.')).toBeInTheDocument();
    expect(usePreferencesStore.getState().defaultProjectDirectory).toBe(null);
  });

  it('stores ComfyUI connection settings as editor preferences', async () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByRole('switch', { name: 'Enable ComfyUI integration' }));
    await waitFor(() => expect(window.noveltea.checkComfyUiConnection).toHaveBeenCalledWith(expect.objectContaining({ enabled: true })));
    vi.mocked(window.noveltea.checkComfyUiConnection).mockClear();

    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'http://127.0.0.1:8000/' } });
    fireEvent.change(screen.getByLabelText('Default generate workflow'), { target: { value: 'custom-workflow' } });

    expect(usePreferencesStore.getState().comfyUiConfig).toMatchObject({
      enabled: true,
      serverUrl: 'http://127.0.0.1:8000',
      defaultWorkflowId: 'custom-workflow',
      defaultWorkflows: { 'image.generate': 'custom-workflow' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    await waitFor(() => expect(window.noveltea.checkComfyUiConnection).toHaveBeenCalledWith(expect.objectContaining({ enabled: true })));
  });
});
