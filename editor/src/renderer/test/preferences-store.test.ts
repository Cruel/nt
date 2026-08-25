import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  initializeSharedPreferencesPersistence,
  selectEditorPreferencesAreDefaults,
  usePreferencesStore,
} from '@/stores/preferences-store';

describe('preferences-store', () => {
  beforeEach(() => {
    usePreferencesStore.getState().resetToDefaults();
    usePreferencesStore.getState().setLastProjectPath(null);
  });

  it('has default values', () => {
    const state = usePreferencesStore.getState();
    expect(state.theme).toBe('system');
    expect(state.language).toBe('system');
    expect(state.codeEditorTheme).toBe('noveltea');
    expect(state.restoreLastProjectOnStart).toBe(true);
    expect(state.showPreviewFpsCounter).toBe(false);
    expect(state.previewFpsCap).toBe(0);
    expect(state.previewRmlUiRasterSnap).toBe('all');
    expect(state.lastProjectPath).toBe(null);
    expect(state.defaultProjectDirectory).toBe(null);
    expect(state.exportPreferences.defaultOutputDirectory).toBe('');
    expect(state.exportPreferences.selectedProfileIds).toEqual({});
    expect(state.exportPreferences.profileOutputDirectories).toEqual({});
    expect(state.exportPreferences.profileTemplateTokens).toEqual({});
    expect(state.exportPreferences.profileSigningProfileIds).toEqual({});
  });

  it('updates theme', () => {
    usePreferencesStore.getState().setTheme('dark');
    expect(usePreferencesStore.getState().theme).toBe('dark');
  });

  it('detects defaults and resets all preferences without clearing the recent project', () => {
    expect(selectEditorPreferencesAreDefaults(usePreferencesStore.getState())).toBe(true);
    usePreferencesStore.getState().setTheme('dark');
    usePreferencesStore.getState().setEditorPreviewSplitSize('vertical', 45);
    usePreferencesStore.getState().setExportPreferences({
      profileOutputDirectories: { release: '/tmp/release' },
    });
    usePreferencesStore.getState().setLastProjectPath('/tmp/project.ntp');

    expect(selectEditorPreferencesAreDefaults(usePreferencesStore.getState())).toBe(false);
    usePreferencesStore.getState().resetToDefaults();

    expect(selectEditorPreferencesAreDefaults(usePreferencesStore.getState())).toBe(true);
    expect(usePreferencesStore.getState().lastProjectPath).toBe('/tmp/project.ntp');
  });

  it('updates language', () => {
    usePreferencesStore.getState().setLanguage('pseudo');
    expect(usePreferencesStore.getState().language).toBe('pseudo');
  });

  it('toggles restoring the last project on startup', () => {
    usePreferencesStore.getState().setRestoreLastProjectOnStart(false);
    expect(usePreferencesStore.getState().restoreLastProjectOnStart).toBe(false);
  });

  it('toggles the preview FPS counter', () => {
    usePreferencesStore.getState().setShowPreviewFpsCounter(true);
    expect(usePreferencesStore.getState().showPreviewFpsCounter).toBe(true);
  });

  it('stores and normalizes the editor-wide preview FPS cap', () => {
    usePreferencesStore.getState().setPreviewFpsCap(59.9);
    expect(usePreferencesStore.getState().previewFpsCap).toBe(59);
    usePreferencesStore.getState().setPreviewFpsCap(5000);
    expect(usePreferencesStore.getState().previewFpsCap).toBe(1000);
    usePreferencesStore.getState().setPreviewFpsCap(-10);
    expect(usePreferencesStore.getState().previewFpsCap).toBe(0);
  });

  it('stores the editor-wide RmlUi raster snapping mode', () => {
    usePreferencesStore.getState().setPreviewRmlUiRasterSnap('text');
    expect(usePreferencesStore.getState().previewRmlUiRasterSnap).toBe('text');
  });

  it('updates the code editor theme', () => {
    usePreferencesStore.getState().setCodeEditorTheme('monokai');
    expect(usePreferencesStore.getState().codeEditorTheme).toBe('monokai');
  });

  it('updates the last project path', () => {
    usePreferencesStore.getState().setLastProjectPath('/tmp/project.ntp');
    expect(usePreferencesStore.getState().lastProjectPath).toBe('/tmp/project.ntp');
  });

  it('updates the default project directory', () => {
    usePreferencesStore.getState().setDefaultProjectDirectory('/tmp/NovelTea');
    expect(usePreferencesStore.getState().defaultProjectDirectory).toBe('/tmp/NovelTea');
    usePreferencesStore.getState().setDefaultProjectDirectory(null);
    expect(usePreferencesStore.getState().defaultProjectDirectory).toBe(null);
  });

  it('keeps ComfyUI preferences out of browser-local persistence', () => {
    usePreferencesStore.getState().setComfyUiConfig({
      enabled: true,
      serverUrl: 'https://comfy.example.test',
      requestTimeoutMs: 2345,
      connectionCheckIntervalMs: 6789,
      defaultWorkflows: { 'image.generate': 'shared-default' },
    });

    const persisted = JSON.parse(localStorage.getItem('noveltea-preferences')!);
    expect(persisted.state.comfyUiConfig).toBeUndefined();
  });

  it('keeps export preferences out of browser-local persistence', () => {
    usePreferencesStore.getState().setExportPreferences({
      defaultOutputDirectory: '/tmp/exports',
      profileTemplateTokens: { release: 'windows/build-1' },
      profileSigningProfileIds: { release: 'windows-release' },
    });
    expect(usePreferencesStore.getState().exportPreferences).toMatchObject({
      defaultOutputDirectory: '/tmp/exports',
      profileTemplateTokens: { release: 'windows/build-1' },
      profileSigningProfileIds: { release: 'windows-release' },
    });
    const persisted = JSON.parse(localStorage.getItem('noveltea-preferences')!);
    expect(persisted.state.exportPreferences).toBeUndefined();
  });

  it('does not duplicate durable user preferences in localStorage', () => {
    usePreferencesStore.getState().setTheme('dark');
    usePreferencesStore.getState().setPreviewFpsCap(30);
    usePreferencesStore.getState().setPreviewRmlUiRasterSnap('geometry');
    const stored = localStorage.getItem('noveltea-preferences');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed.state.theme).toBeUndefined();
    expect(parsed.state.previewFpsCap).toBeUndefined();
    expect(parsed.state.previewRmlUiRasterSnap).toBeUndefined();
  });

  it('keeps file persistence active when initialization is mounted again', async () => {
    const firstDispose = await initializeSharedPreferencesPersistence();
    firstDispose();
    const secondDispose = await initializeSharedPreferencesPersistence();
    const save = window.noveltea.saveUserPreferences as ReturnType<typeof vi.fn>;
    save.mockClear();

    usePreferencesStore.getState().setTheme('dark');

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
    secondDispose();
  });
});
