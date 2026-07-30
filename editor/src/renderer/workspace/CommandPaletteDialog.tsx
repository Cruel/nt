import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import type { AssetNode } from '@/stores/workspace-store';
import {
  buildAssetsEditorTab,
  buildComfyUiWorkflowsTab,
  buildDefaultRecordTab,
  buildProjectSettingsTab,
  buildSettingsTab,
  buildTestsEditorTab,
  buildVariablesEditorTab,
} from '@/workbench/editor-registry';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import {
  tabSupportsPreviewVisibility,
  toggleTabPreview,
} from '@/workbench/preview-visibility-command';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { dispatchWorkspaceToolbarCommand } from '@/workspace/workspace-toolbar-events';
import { enqueueWorkbenchRevealTarget } from '@/workbench/workbench-navigation';
import {
  selectEditorPreferencesAreDefaults,
  usePreferencesStore,
} from '@/stores/preferences-store';
import { SearchSelectorDialog } from './SearchSelectorDialog';
import {
  buildCommandPaletteItems,
  buildTogglePreviewCommandItem,
  type CommandPaletteItem,
} from './command-palette-search';

function nodeForRecord(item: CommandPaletteItem): AssetNode | null {
  if (!item.collection || !item.entityId) return null;
  return {
    id: `${item.collection}:${item.entityId}`,
    label: item.title,
    type:
      item.collection === 'variables'
        ? 'variable'
        : item.collection === 'assets'
          ? 'asset'
          : item.collection === 'shaders'
            ? 'shader'
            : item.collection === 'materials'
              ? 'material'
              : item.collection === 'layouts'
                ? 'layout'
                : item.collection === 'characters'
                  ? 'character'
                  : 'folder',
    collection: item.collection,
    entityId: item.entityId,
  };
}

function tabForItem(item: CommandPaletteItem): WorkbenchTab | null {
  if (item.kind === 'record') {
    const node = nodeForRecord(item);
    return node ? buildDefaultRecordTab(node) : null;
  }
  if (item.action === 'settings') return buildSettingsTab();
  if (item.action === 'reset-settings') return buildSettingsTab();
  if (item.action === 'comfyui-workflows') return buildComfyUiWorkflowsTab();
  if (item.action === 'project-settings') return buildProjectSettingsTab();
  if (item.action === 'assets') return buildAssetsEditorTab();
  if (item.action === 'variables') return buildVariablesEditorTab();
  if (item.action === 'tests') return buildTestsEditorTab();
  return null;
}

export function CommandPaletteDialog({
  open,
  project,
  onOpenChange,
  onOpenTab,
}: {
  open: boolean;
  project: AuthoringProject | null;
  onOpenChange: (open: boolean) => void;
  onOpenTab: (tab: WorkbenchTab) => void;
}) {
  const { t } = useTranslation('workspace');
  const activeGroupId = useWorkbenchStore((state) => state.activeGroupId);
  const preferencesAtDefaults = usePreferencesStore(selectEditorPreferencesAreDefaults);
  const [nativeFrameAtDefault, setNativeFrameAtDefault] = useState<boolean | null>(null);
  const activeGroup = useWorkbenchStore((state) => state.groupsById[activeGroupId]);
  const activeTab = useWorkbenchStore((state) =>
    activeGroup?.activeTabId ? state.tabsById[activeGroup.activeTabId] : undefined,
  );
  const items = useMemo(() => {
    const next = buildCommandPaletteItems(project, t);
    const resetSettings = next.find((item) => item.action === 'reset-settings');
    if (resetSettings) {
      resetSettings.disabled = preferencesAtDefaults && nativeFrameAtDefault === true;
    }
    if (tabSupportsPreviewVisibility(activeTab)) next.push(buildTogglePreviewCommandItem(t));
    return next;
  }, [activeTab, nativeFrameAtDefault, preferencesAtDefaults, project, t]);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    void window.noveltea
      .getAppInfo()
      .then((info) => {
        if (!mounted) return;
        setNativeFrameAtDefault(info.nativeFrame === (info.platform === 'linux'));
      })
      .catch(() => {
        if (mounted) setNativeFrameAtDefault(null);
      });
    return () => {
      mounted = false;
    };
  }, [open]);

  function choose(item: CommandPaletteItem) {
    const tab = tabForItem(item);
    if (tab) {
      if (item.action === 'reset-settings') {
        enqueueWorkbenchRevealTarget(tab, { id: 'settings.reset' });
      }
      onOpenTab(tab);
      onOpenChange(false);
      return;
    }
    if (
      item.kind === 'action' &&
      (item.action === 'new-project' ||
        item.action === 'open-project' ||
        item.action === 'save-all')
    ) {
      dispatchWorkspaceToolbarCommand(item.action);
      onOpenChange(false);
      return;
    }
    if (item.kind === 'action' && item.action === 'toggle-preview' && activeTab) {
      toggleTabPreview(activeTab);
      onOpenChange(false);
    }
  }

  return (
    <SearchSelectorDialog
      open={open}
      title={t('commandPalette.title')}
      placeholder={t('commandPalette.placeholder')}
      emptyMessage={t('commandPalette.empty')}
      items={items}
      onSelect={choose}
      onOpenChange={onOpenChange}
    />
  );
}
