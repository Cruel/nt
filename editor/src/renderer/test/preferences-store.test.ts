import { describe, it, expect, beforeEach } from 'vitest';
import { usePreferencesStore } from '@/stores/preferences-store';

describe('preferences-store', () => {
  beforeEach(() => {
    usePreferencesStore.setState({
      theme: 'system',
      density: 'compact',
      showInspectorByDefault: true,
    });
  });

  it('has default values', () => {
    const state = usePreferencesStore.getState();
    expect(state.theme).toBe('system');
    expect(state.density).toBe('compact');
    expect(state.showInspectorByDefault).toBe(true);
  });

  it('updates theme', () => {
    usePreferencesStore.getState().setTheme('dark');
    expect(usePreferencesStore.getState().theme).toBe('dark');
  });

  it('updates density', () => {
    usePreferencesStore.getState().setDensity('comfortable');
    expect(usePreferencesStore.getState().density).toBe('comfortable');
  });

  it('toggles inspector default', () => {
    usePreferencesStore.getState().setShowInspectorByDefault(false);
    expect(usePreferencesStore.getState().showInspectorByDefault).toBe(false);
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
