import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { SettingsPage } from '@/routes/settings';
import { SettingsTabEditor } from '@/editors/utility/SettingsTabEditor';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { invokeWorkbenchTargetHandler } from '@/workbench/workbench-navigation';
import { captureWorkbenchTabState, clearWorkbenchTabStates } from '@/workbench/workbench-tab-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import type {
  ComfyUiWorkflowActiveEntry,
  ComfyUiWorkflowClassification,
} from '../../shared/comfyui-workflows';
import { NOVELTEA_VERSION } from '../../shared/product-version';
import { defaultUserExportConfig } from '../../shared/project-schema/platform-export-contracts';

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({ value, themeId }: { value: string; themeId?: string }) => (
    <textarea aria-label="source-editor-preview" data-theme-id={themeId} readOnly value={value} />
  ),
}));

function activeWorkflow(
  id: string,
  classification: ComfyUiWorkflowClassification,
): ComfyUiWorkflowActiveEntry {
  return {
    workflowKey: `user:${id}.manifest.json`,
    source: 'user',
    id,
    label: id,
    classification,
    definition: {
      schemaVersion: 2,
      id,
      label: id,
      provider: 'comfyui',
      classification,
      workflowFile: `${id}.workflow.json`,
      contract: {
        inputs: {},
        outputs: { images: { mediaType: 'image', required: true, cardinality: 'many' } },
      },
      requiredNodeClasses: [],
      bindings: {},
      outputBindings: {
        images: [{ nodeId: '9' }],
      },
      manifestFile: `${id}.manifest.json`,
    },
    offlineStatus: 'valid',
    onlineStatus: 'unverified',
    runnable: true,
    diagnostics: [],
    verificationDiagnostics: [],
  };
}

async function renderSettingsPage() {
  await act(async () => {
    render(<SettingsPage />);
  });
}

function selectSettingsCategory(name: string) {
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Settings categories' })).getByRole('button', {
      name,
    }),
  );
}

const settingsTab: WorkbenchTab = {
  id: 'tab:settings',
  title: 'Settings',
  editorType: 'settings',
  resource: { kind: 'tool', stableId: 'utility:settings' },
};

describe('SettingsPage code editor theme selector', () => {
  beforeEach(() => {
    vi.spyOn(window.noveltea, 'getAppInfo').mockReturnValue(
      new Promise(() => {}) as ReturnType<typeof window.noveltea.getAppInfo>,
    );
    usePreferencesStore.getState().resetToDefaults();
    usePreferencesStore.setState({
      theme: 'system',
      language: 'system',
      codeEditorTheme: 'noveltea',
      developerMode: false,
      restoreLastProjectOnStart: true,
      showPreviewFpsCounter: false,
      editorPreviewLayout: 'automatic',
      lastProjectPath: null,
      defaultProjectDirectory: null,
      comfyUiConfig: {
        enabled: false,
        serverUrl: 'http://127.0.0.1:8000',
        defaultWorkflows: {
          'image.generate': 'flux2-klein-text-to-image',
          'image.edit': 'flux2-klein-image-edit',
        },
        requestTimeoutMs: 15000,
        connectionCheckIntervalMs: 10000,
      },
    });
    useComfyUiStore.getState().hydrateFromPreferences();
    useWorkbenchStore.getState().resetWorkbench();
    clearWorkbenchTabStates();
    vi.spyOn(window.noveltea, 'getDefaultProjectDirectory').mockResolvedValue(
      '/home/test/Documents/NovelTea',
    );
    vi.spyOn(window.noveltea, 'selectDirectory').mockResolvedValue('/tmp/NovelTea');
  });

  it('opens a preview dialog and applies the cycled theme', async () => {
    await renderSettingsPage();

    fireEvent.click(screen.getByRole('button', { name: /NovelTea/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next editor theme' }));
    expect(screen.getByLabelText('source-editor-preview')).toHaveAttribute(
      'data-theme-id',
      'abcdef',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply Theme' }));
    expect(usePreferencesStore.getState().codeEditorTheme).toBe('abcdef');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not persist preview cycling when cancelled', async () => {
    await renderSettingsPage();

    fireEvent.click(screen.getByRole('button', { name: /NovelTea/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Next editor theme' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(usePreferencesStore.getState().codeEditorTheme).toBe('noveltea');
  });

  it('renders the editor language selector options', async () => {
    await renderSettingsPage();

    fireEvent.click(screen.getByRole('combobox', { name: 'Language' }));
    expect(screen.getByRole('option', { name: 'Pseudo-localized' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Portuguese (Brazil)' })).toBeInTheDocument();
  });

  it('selects the owning category for a workbench settings target', async () => {
    await act(async () => {
      render(<SettingsPage tabId="tab:settings" />);
    });

    act(() => {
      invokeWorkbenchTargetHandler('tab:settings', {
        id: 'settings.comfyui',
        requestId: 1,
      });
    });

    expect(screen.getByRole('button', { name: 'ComfyUI' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('switch', { name: 'Enable ComfyUI integration' })).toBeInTheDocument();
  });

  it('restores the selected category after the settings tab remounts', async () => {
    const firstRender = render(<SettingsTabEditor tab={settingsTab} />);
    selectSettingsCategory('Preview');
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-current', 'page');

    act(() => {
      captureWorkbenchTabState(settingsTab.id);
    });
    firstRender.unmount();

    render(<SettingsTabEditor tab={settingsTab} />);
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-current', 'page');
  });

  it('confirms before resetting every settings category', async () => {
    vi.mocked(window.noveltea.getAppInfo).mockResolvedValue({
      version: NOVELTEA_VERSION,
      electronVersion: '42.0.0',
      platform: 'linux',
      arch: 'x64',
      packaged: false,
      frameless: false,
      nativeFrame: true,
      preferredSystemLanguages: ['en-US'],
      systemLocale: 'en-US',
    });
    usePreferencesStore.setState({
      theme: 'dark',
      developerMode: true,
      previewFpsCap: 30,
      editorPreviewLayout: 'horizontal',
    });
    await renderSettingsPage();

    const resetAction = screen.getByRole('button', { name: 'Reset All Settings' });
    expect(resetAction.closest('aside')).not.toBeNull();
    fireEvent.click(resetAction);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Reset all editor settings?')).toBeInTheDocument();
    expect(usePreferencesStore.getState().theme).toBe('dark');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(usePreferencesStore.getState().theme).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'Reset All Settings' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset All Settings' }),
    );

    await waitFor(() =>
      expect(usePreferencesStore.getState()).toMatchObject({
        theme: 'system',
        developerMode: false,
        previewFpsCap: 0,
        previewDisplay: { mode: 'project' },
        editorPreviewLayout: 'automatic',
      }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reset All Settings' })).toBeDisabled(),
    );
  });

  it('keeps Reset All Settings disabled until shared export configuration finishes loading', async () => {
    let resolveConfig!: (value: ReturnType<typeof defaultUserExportConfig>) => void;
    vi.mocked(window.noveltea.loadUserExportConfig).mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );

    await renderSettingsPage();
    const reset = screen.getByRole('button', { name: 'Reset All Settings' });
    expect(reset).toBeDisabled();

    resolveConfig({
      ...defaultUserExportConfig(),
      toolchains: { androidSdk: '/opt/android' },
    });
    await waitFor(() => expect(reset).toBeEnabled());
  });

  it('includes shared export and signing configuration in Reset All Settings', async () => {
    vi.mocked(window.noveltea.loadUserExportConfig).mockResolvedValue({
      ...defaultUserExportConfig(),
      toolchains: { androidSdk: '/opt/android' },
      signingProfiles: [
        {
          id: 'windows-release',
          label: 'Windows Release',
          target: 'windows',
          command: 'signtool',
          args: ['sign', '{executable}'],
          verifyCommand: 'signtool',
          verifyArgs: ['verify', '{executable}'],
        },
      ],
    });
    await renderSettingsPage();

    const reset = await screen.findByRole('button', { name: 'Reset All Settings' });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset All Settings' }),
    );

    await waitFor(() =>
      expect(window.noveltea.saveUserExportConfig).toHaveBeenCalledWith(defaultUserExportConfig()),
    );
  });

  it('opens the same confirmation for the reset-settings workbench command', async () => {
    await act(async () => {
      render(<SettingsPage tabId="tab:settings" />);
    });

    act(() => {
      invokeWorkbenchTargetHandler('tab:settings', {
        id: 'settings.reset',
        requestId: 2,
      });
    });

    expect(screen.getByRole('dialog')).toHaveTextContent('Reset all editor settings?');
  });

  it('toggles the preview FPS counter preference', async () => {
    await renderSettingsPage();
    selectSettingsCategory('Preview');

    fireEvent.click(screen.getByRole('switch', { name: 'Show FPS counter' }));
    expect(usePreferencesStore.getState().showPreviewFpsCounter).toBe(true);
  });

  it('changes the preview RmlUi pixel snapping preference', async () => {
    await renderSettingsPage();
    selectSettingsCategory('Preview');

    fireEvent.click(screen.getByRole('combobox', { name: 'RmlUi pixel snapping' }));
    const option = screen.getByRole('option', { name: 'Text only' });
    fireEvent.pointerDown(option, { pointerType: 'mouse', button: 0 });
    fireEvent.click(option);

    expect(usePreferencesStore.getState().previewRmlUiRasterSnap).toBe('text');
  });

  it('toggles developer mode', async () => {
    await renderSettingsPage();
    selectSettingsCategory('Workspace');

    fireEvent.click(screen.getByRole('switch', { name: 'Developer mode' }));
    expect(usePreferencesStore.getState().developerMode).toBe(true);
  });

  it('shows and changes the default project directory preference', async () => {
    render(<SettingsPage />);
    selectSettingsCategory('Workspace');

    await waitFor(() =>
      expect(screen.getByLabelText('Default project directory')).toHaveValue(
        '/home/test/Documents/NovelTea',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));

    await waitFor(() =>
      expect(usePreferencesStore.getState().defaultProjectDirectory).toBe('/tmp/NovelTea'),
    );
    expect(screen.getByLabelText('Default project directory')).toHaveValue('/tmp/NovelTea');
  });

  it('resets the default project directory to the app default', async () => {
    usePreferencesStore.getState().setDefaultProjectDirectory('/tmp/NovelTea');
    render(<SettingsPage />);
    selectSettingsCategory('Workspace');

    expect(screen.getByLabelText('Default project directory')).toHaveValue('/tmp/NovelTea');
    fireEvent.click(screen.getByRole('button', { name: 'Reset default project directory' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Default project directory')).toHaveValue(
        '/home/test/Documents/NovelTea',
      ),
    );
    expect(usePreferencesStore.getState().defaultProjectDirectory).toBe(null);
  });

  it('rejects default project directories containing spaces', async () => {
    vi.mocked(window.noveltea.selectDirectory).mockResolvedValue('/tmp/NovelTea Projects');
    render(<SettingsPage />);
    selectSettingsCategory('Workspace');

    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));

    expect(
      await screen.findByText('Project directory paths must not contain spaces.'),
    ).toBeInTheDocument();
    expect(usePreferencesStore.getState().defaultProjectDirectory).toBe(null);
  });

  it('keeps ComfyUI enablement editor-local while saving shared connection and default state', async () => {
    vi.mocked(window.noveltea.listComfyUiWorkflowLibrary).mockResolvedValue({
      ok: true,
      success: true,
      diagnostics: [],
      entries: [],
      activeWorkflows: [
        activeWorkflow('custom-workflow', 'image.generate'),
        activeWorkflow('custom-edit-workflow', 'image.edit'),
      ],
      overriddenEntries: [],
      summary: {
        sources: [],
        totalCount: 2,
        activeCount: 2,
        overriddenCount: 0,
        invalidCount: 0,
        verifiedCount: 0,
        failedVerificationCount: 0,
      },
    });

    render(<SettingsPage />);
    selectSettingsCategory('ComfyUI');

    fireEvent.click(screen.getByRole('switch', { name: 'Enable ComfyUI integration' }));
    await waitFor(() =>
      expect(window.noveltea.checkComfyUiConnection).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      ),
    );
    vi.mocked(window.noveltea.checkComfyUiConnection).mockClear();

    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'http://127.0.0.1:8000/' },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Default generate workflow')).toHaveValue(
        'flux2-klein-text-to-image',
      ),
    );
    fireEvent.change(screen.getByLabelText('Default generate workflow'), {
      target: { value: 'custom-workflow' },
    });
    fireEvent.change(screen.getByLabelText('Default edit workflow'), {
      target: { value: 'custom-edit-workflow' },
    });

    expect(usePreferencesStore.getState().comfyUiConfig).toMatchObject({
      enabled: true,
      serverUrl: 'http://127.0.0.1:8000',
      defaultWorkflows: {
        'image.generate': 'custom-workflow',
        'image.edit': 'custom-edit-workflow',
      },
    });
    await waitFor(() =>
      expect(window.noveltea.saveComfyUiUserConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({
          format: 'noveltea.comfyui-user-config',
          formatVersion: 1,
          serverUrl: 'http://127.0.0.1:8000',
          defaultWorkflows: {
            'image.generate': 'custom-workflow',
            'image.edit': 'custom-edit-workflow',
          },
        }),
      ),
    );
    expect(vi.mocked(window.noveltea.saveComfyUiUserConfig).mock.lastCall?.[0]).not.toHaveProperty(
      'enabled',
    );
    expect(vi.mocked(window.noveltea.saveComfyUiUserConfig).mock.lastCall?.[0]).not.toHaveProperty(
      'connectionCheckIntervalMs',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Manage ComfyUI Workflows' }));
    expect(useWorkbenchStore.getState().tabsById['tab:comfyui-workflows']).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    await waitFor(() =>
      expect(window.noveltea.checkComfyUiConnection).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      ),
    );
  });

  it('derives future classifications and visibly preserves an unavailable configured default', async () => {
    vi.mocked(window.noveltea.listComfyUiWorkflowLibrary).mockResolvedValue({
      ok: true,
      success: true,
      diagnostics: [],
      entries: [],
      activeWorkflows: [activeWorkflow('audio-live', 'audio.generate')],
      overriddenEntries: [],
      summary: {
        sources: [],
        totalCount: 1,
        activeCount: 1,
        overriddenCount: 0,
        invalidCount: 0,
        verifiedCount: 0,
        failedVerificationCount: 0,
      },
    });
    usePreferencesStore.getState().setComfyUiConfig({
      defaultWorkflows: {
        ...usePreferencesStore.getState().comfyUiConfig.defaultWorkflows,
        'audio.generate': 'audio-missing',
      },
    });

    render(<SettingsPage />);
    selectSettingsCategory('ComfyUI');

    const selector = await screen.findByLabelText('audio.generate');
    expect(selector).toHaveValue('audio-missing');
    expect(
      screen.getByText("Configured workflow 'audio-missing' is currently unavailable."),
    ).toBeInTheDocument();
    fireEvent.change(selector, { target: { value: 'audio-live' } });
    await waitFor(() =>
      expect(window.noveltea.saveComfyUiUserConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({
          defaultWorkflows: expect.objectContaining({ 'audio.generate': 'audio-live' }),
        }),
      ),
    );
  });
});

describe('SettingsPage editor cache', () => {
  it('requires confirmation, reports success, and remains separate from reset settings', async () => {
    const clear = vi
      .spyOn(window.noveltea, 'clearEditorCache')
      .mockResolvedValue({ ok: true, cacheEpoch: 2 });
    await renderSettingsPage();
    selectSettingsCategory('Workspace');

    fireEvent.click(screen.getByRole('button', { name: 'Clear Editor Cache' }));
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear Editor Cache' }),
    );
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Editor cache cleared.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset All Settings' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset All Settings' }),
    );
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('shows localized failure feedback inside the confirmation dialog', async () => {
    vi.spyOn(window.noveltea, 'clearEditorCache').mockResolvedValue({
      ok: false,
      message: 'sensitive cache path failure',
      cacheEpoch: 3,
    });
    await renderSettingsPage();
    selectSettingsCategory('Workspace');

    fireEvent.click(screen.getByRole('button', { name: 'Clear Editor Cache' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear Editor Cache' }));

    expect(
      await within(dialog).findByText('The editor cache could not be cleared.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('sensitive cache path failure')).not.toBeInTheDocument();
  });
});
