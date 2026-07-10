import { resolveWorkbenchEditor, type WorkbenchEditorRegistry } from './editor-registry';
import type { WorkbenchState, WorkbenchTab } from './workbench-types';

export function selectWorkbenchTabGroupId(
  state: Pick<WorkbenchState, 'groupsById'>,
  tabId: string,
): string | null {
  for (const group of Object.values(state.groupsById)) {
    if (group.tabIds.includes(tabId)) return group.id;
  }
  return null;
}

export function selectOpenPersistentWorkbenchTabs(
  state: Pick<WorkbenchState, 'tabsById'>,
  registry: WorkbenchEditorRegistry,
): WorkbenchTab[] {
  return Object.values(state.tabsById).filter((tab) => (
    resolveWorkbenchEditor(registry, tab).policies.mountPolicy === 'keep-mounted-while-open'
  ));
}
