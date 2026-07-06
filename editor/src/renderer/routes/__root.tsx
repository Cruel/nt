import { useEffect } from 'react';
import { Outlet, createRootRoute } from '@tanstack/react-router';
import { AppShell } from '@/components/app-shell';
import { editorI18n, resolveEditorLanguage } from '@/i18n';
import { useProjectStore } from '@/project/project-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';

function RootLayout() {
  const theme = usePreferencesStore((s) => s.theme);
  const language = usePreferencesStore((s) => s.language);
  const project = useProjectStore((state) => state.document);
  const activeGroupId = useWorkbenchStore((state) => state.activeGroupId);
  const activeTabId = useWorkbenchStore((state) => state.groupsById[activeGroupId]?.activeTabId ?? null);
  const activeTabTitle = useWorkbenchStore((state) => activeTabId ? state.tabsById[activeTabId]?.title ?? null : null);

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

  useEffect(() => {
    const projectName = project?.project.name.trim();
    const parts = [activeTabTitle, projectName, 'NovelTea'].filter((part): part is string => Boolean(part));
    document.title = parts.join(' - ');
  }, [activeTabTitle, project]);

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
