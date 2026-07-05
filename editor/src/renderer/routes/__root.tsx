import { useEffect } from 'react';
import { Outlet, createRootRoute } from '@tanstack/react-router';
import { AppShell } from '@/components/app-shell';
import { editorI18n, resolveEditorLanguage } from '@/i18n';
import { usePreferencesStore } from '@/stores/preferences-store';

function RootLayout() {
  const theme = usePreferencesStore((s) => s.theme);
  const language = usePreferencesStore((s) => s.language);

  useEffect(() => {
    const root = document.documentElement;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    function apply() {
      root.classList.remove('light', 'dark');
      if (theme === 'system') {
        root.classList.add(mediaQuery.matches ? 'dark' : 'light');
      } else {
        root.classList.add(theme);
      }
    }

    apply();
    mediaQuery.addEventListener('change', apply);
    return () => mediaQuery.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    let mounted = true;
    void window.noveltea.getAppInfo().then((info) => {
      if (!mounted) return;
      const effectiveLanguage = resolveEditorLanguage(language, info.preferredSystemLanguages);
      if (editorI18n.language !== effectiveLanguage) void editorI18n.changeLanguage(effectiveLanguage);
      document.documentElement.lang = effectiveLanguage === 'pseudo' ? 'en-US' : effectiveLanguage;
    });
    return () => {
      mounted = false;
    };
  }, [language]);

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
