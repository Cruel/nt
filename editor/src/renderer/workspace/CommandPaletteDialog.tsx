import { useMemo } from 'react';
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
import { dispatchWorkspaceToolbarCommand } from '@/workspace/workspace-toolbar-events';
import { SearchSelectorDialog } from './SearchSelectorDialog';
import { buildCommandPaletteItems, type CommandPaletteItem } from './command-palette-search';

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
  const items = useMemo(() => buildCommandPaletteItems(project, t), [project, t]);

  function choose(item: CommandPaletteItem) {
    const tab = tabForItem(item);
    if (tab) {
      onOpenTab(tab);
      onOpenChange(false);
      return;
    }
    if (
      item.kind === 'action' &&
      (item.action === 'new-project' || item.action === 'open-project')
    ) {
      dispatchWorkspaceToolbarCommand(item.action);
      onOpenChange(false);
      return;
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
