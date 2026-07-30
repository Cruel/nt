import type { WorkbenchTab } from './workbench-types';
import {
  applyWorkbenchTabState,
  captureWorkbenchTabState,
  setWorkbenchTabState,
  type WorkbenchTabStatePayload,
} from './workbench-tab-state';

interface PreviewTabStateContract {
  schema: string;
  schemaVersion: number;
}

const previewTabStateContracts: Record<string, PreviewTabStateContract> = {
  'room-detail': {
    schema: 'noveltea.editor.tab-state.room',
    schemaVersion: 2,
  },
  'layout-detail': {
    schema: 'noveltea.editor.tab-state.layout',
    schemaVersion: 2,
  },
};

function readPreviewCollapsed(state: WorkbenchTabStatePayload | undefined): boolean | null {
  if (
    !state ||
    typeof state.payload !== 'object' ||
    state.payload === null ||
    Array.isArray(state.payload)
  )
    return null;
  const value = (state.payload as Record<string, unknown>).previewCollapsed;
  return typeof value === 'boolean' ? value : null;
}

export function tabSupportsPreviewVisibility(tab: WorkbenchTab | null | undefined): boolean {
  return !!tab && previewTabStateContracts[tab.editorType] !== undefined;
}

export function isTabPreviewVisible(tab: WorkbenchTab | null | undefined): boolean {
  if (!tabSupportsPreviewVisibility(tab)) return false;
  return readPreviewCollapsed(captureWorkbenchTabState(tab!.id)) !== true;
}

export function isPreviewVisibleFromState(
  tab: WorkbenchTab | null | undefined,
  state: WorkbenchTabStatePayload | undefined,
): boolean {
  return tabSupportsPreviewVisibility(tab) && readPreviewCollapsed(state) !== true;
}

export function setTabPreviewVisible(tab: WorkbenchTab, visible: boolean): boolean {
  const contract = previewTabStateContracts[tab.editorType];
  if (!contract) return false;
  const current = captureWorkbenchTabState(tab.id);
  if (
    !current ||
    current.schema !== contract.schema ||
    current.schemaVersion !== contract.schemaVersion ||
    typeof current.payload !== 'object' ||
    current.payload === null ||
    Array.isArray(current.payload)
  )
    return false;

  applyWorkbenchTabState(tab.id, {
    ...current,
    payload: {
      ...(current.payload as Record<string, unknown>),
      previewCollapsed: !visible,
    },
  });
  return true;
}

export function recordTabPreviewVisible(tab: WorkbenchTab, visible: boolean): boolean {
  const contract = previewTabStateContracts[tab.editorType];
  if (!contract) return false;
  const current = captureWorkbenchTabState(tab.id);
  if (
    !current ||
    current.schema !== contract.schema ||
    current.schemaVersion !== contract.schemaVersion ||
    typeof current.payload !== 'object' ||
    current.payload === null ||
    Array.isArray(current.payload)
  )
    return false;
  setWorkbenchTabState(tab.id, {
    ...current,
    payload: {
      ...(current.payload as Record<string, unknown>),
      previewCollapsed: !visible,
    },
  });
  return true;
}

export function toggleTabPreview(tab: WorkbenchTab): boolean {
  return setTabPreviewVisible(tab, !isTabPreviewVisible(tab));
}
