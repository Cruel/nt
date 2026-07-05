import { describe, it, expect, beforeEach } from 'vitest';
import { usePreferencesStore } from '@/stores/preferences-store';

describe('preferences-store', () => {
  beforeEach(() => {
    usePreferencesStore.setState({
      theme: 'system',
      language: 'system',
      codeEditorTheme: 'noveltea',
      restoreLastProjectOnStart: true,
      showPreviewFpsCounter: false,
      lastProjectPath: null,
    });
  });

  it('has default values', () => {
    const state = usePreferencesStore.getState();
    expect(state.theme).toBe('system');
    expect(state.language).toBe('system');
    expect(state.codeEditorTheme).toBe('noveltea');
    expect(state.restoreLastProjectOnStart).toBe(true);
    expect(state.showPreviewFpsCounter).toBe(false);
    expect(state.lastProjectPath).toBe(null);
  });

  it('updates theme', () => {
    usePreferencesStore.getState().setTheme('dark');
    expect(usePreferencesStore.getState().theme).toBe('dark');
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

  it('updates the code editor theme', () => {
    usePreferencesStore.getState().setCodeEditorTheme('monokai');
    expect(usePreferencesStore.getState().codeEditorTheme).toBe('monokai');
  });

  it('updates the last project path', () => {
    usePreferencesStore.getState().setLastProjectPath('/tmp/project.ntp');
    expect(usePreferencesStore.getState().lastProjectPath).toBe('/tmp/project.ntp');
  });

  it('persists to localStorage', () => {
    // Zustand persist middleware writes to localStorage on state change
    usePreferencesStore.getState().setTheme('dark');
    const stored = localStorage.getItem('noveltea-preferences');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed.state.theme).toBe('dark');
  });
});
