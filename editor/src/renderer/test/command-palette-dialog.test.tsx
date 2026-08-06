import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommandPaletteDialog } from '@/workspace/CommandPaletteDialog';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { buildComfyUiWorkflowsTab, buildSettingsTab } from '@/workbench/editor-registry';
import {
  clearWorkbenchRevealTargets,
  consumeWorkbenchRevealTarget,
} from '@/workbench/workbench-navigation';
import { usePreferencesStore } from '@/stores/preferences-store';

beforeEach(() => {
  vi.stubGlobal('devicePixelRatio', 1);
  useProjectStore.getState().clearProject();
  usePreferencesStore.getState().resetToDefaults();
  clearWorkbenchRevealTargets();
  vi.mocked(window.noveltea.resolveProjectAssetUrl).mockClear();
  vi.mocked(window.noveltea.requestImageThumbnail).mockClear();
});

describe('CommandPaletteDialog', () => {
  it('renders image asset thumbnails in command results', async () => {
    const project = createAuthoringProject();
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/logo.png' },
        aliases: [],
        extension: '.png',
        imageMetadata: { width: 256, height: 256, hasAlpha: true, orientation: 1 },
      },
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(
      <CommandPaletteDialog open project={project} onOpenChange={vi.fn()} onOpenTab={vi.fn()} />,
    );

    expect(screen.getByText('Logo')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByAltText('Logo')).toBeInTheDocument());
    expect(window.noveltea.requestImageThumbnail).toHaveBeenCalledWith({
      source: {
        projectFilePath: '/mock/project.json',
        projectRelativePath: 'assets/images/logo.png',
        width: 256,
        height: 256,
        orientation: 1,
      },
      variant: { kind: 'profile', profile: 'list' },
    });
    expect(window.noveltea.resolveProjectAssetUrl).not.toHaveBeenCalled();
    expect(screen.getByAltText('Logo')).toHaveAttribute(
      'src',
      expect.stringContaining('noveltea-thumbnail:'),
    );
  });

  it('opens settings as a workbench tab', async () => {
    const onOpenTab = vi.fn();
    render(
      <CommandPaletteDialog open project={null} onOpenChange={vi.fn()} onOpenTab={onOpenTab} />,
    );

    const settingsButton = screen.getByRole('button', { name: 'Settings' });
    expect(settingsButton.querySelector('svg')).not.toBeNull();
    fireEvent.click(settingsButton);

    expect(onOpenTab).toHaveBeenCalledWith(buildSettingsTab());
  });

  it('opens the shared reset-settings confirmation from the command palette', () => {
    usePreferencesStore.getState().setTheme('dark');
    const onOpenTab = vi.fn();
    render(
      <CommandPaletteDialog open project={null} onOpenChange={vi.fn()} onOpenTab={onOpenTab} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reset All Settings' }));

    expect(onOpenTab).toHaveBeenCalledWith(buildSettingsTab());
    expect(consumeWorkbenchRevealTarget(buildSettingsTab())).toMatchObject({
      id: 'settings.reset',
    });
  });

  it('disables reset settings when editor and native-frame preferences are defaults', async () => {
    const onOpenTab = vi.fn();
    render(
      <CommandPaletteDialog open project={null} onOpenChange={vi.fn()} onOpenTab={onOpenTab} />,
    );

    const resetSettings = screen.getByRole('button', { name: 'Reset All Settings' });
    await waitFor(() => expect(resetSettings).toBeDisabled());
    fireEvent.click(resetSettings);

    expect(onOpenTab).not.toHaveBeenCalled();
    expect(consumeWorkbenchRevealTarget(buildSettingsTab())).toBeNull();
  });

  it('keeps reset settings enabled when only the native frame differs from its platform default', async () => {
    vi.mocked(window.noveltea.getAppInfo).mockResolvedValueOnce({
      version: '1.0.0',
      electronVersion: '42.0.0',
      platform: 'linux',
      arch: 'x64',
      packaged: false,
      frameless: true,
      nativeFrame: false,
      preferredSystemLanguages: ['en-US'],
      systemLocale: 'en-US',
    });
    render(<CommandPaletteDialog open project={null} onOpenChange={vi.fn()} onOpenTab={vi.fn()} />);

    const resetSettings = screen.getByRole('button', { name: 'Reset All Settings' });
    await waitFor(() => expect(resetSettings).toBeEnabled());
  });

  it('opens ComfyUI workflow manager without a project', async () => {
    const onOpenTab = vi.fn();
    render(
      <CommandPaletteDialog open project={null} onOpenChange={vi.fn()} onOpenTab={onOpenTab} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Manage ComfyUI Workflows' }));

    expect(onOpenTab).toHaveBeenCalledWith(buildComfyUiWorkflowsTab());
  });
});
