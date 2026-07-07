import type { SerializedEditorTabState } from '../../shared/project-schema/editor-project-state';

export type WorkbenchSplitDirection = 'horizontal' | 'vertical';

export type WorkbenchDockEdge = 'left' | 'right' | 'top' | 'bottom';

export type WorkbenchResourceKind = 'record' | 'preview' | 'tool' | 'project' | 'raw';

export interface WorkbenchResource {
  kind: WorkbenchResourceKind;
  stableId: string;
  collection?: string;
  entityId?: string;
  testId?: string;
  explorerNodeId?: string;
  generationMode?: 'generate' | 'edit';
  sourceProjectRelativePath?: string;
}

export interface WorkbenchTab {
  id: string;
  title: string;
  editorType: string;
  resource?: WorkbenchResource;
  dirty?: boolean;
  pinned?: boolean;
  preview?: boolean;
}

export interface WorkbenchGroup {
  id: string;
  tabIds: string[];
  activeTabId: string | null;
  activationHistory?: string[];
}

export interface WorkbenchLayoutGroupNode {
  kind: 'group';
  groupId: string;
}

export interface WorkbenchLayoutSplitNode {
  kind: 'split';
  id: string;
  direction: WorkbenchSplitDirection;
  children: WorkbenchLayoutNode[];
  sizesByChild?: Record<string, number>;
}

export type WorkbenchLayoutNode = WorkbenchLayoutGroupNode | WorkbenchLayoutSplitNode;

export interface ClosedWorkbenchTab {
  tab: WorkbenchTab;
  closedFromGroupId: string;
  tabState?: SerializedEditorTabState;
}

export interface WorkbenchState {
  layout: WorkbenchLayoutNode;
  groupsById: Record<string, WorkbenchGroup>;
  tabsById: Record<string, WorkbenchTab>;
  activeGroupId: string;
  recentlyClosedTabs: ClosedWorkbenchTab[];
}

export type WorkbenchIdFactory = (prefix: string) => string;

export interface OpenWorkbenchTabOptions {
  groupId?: string;
  activate?: boolean;
  duplicate?: boolean;
}

export interface SplitWorkbenchGroupOptions {
  direction: WorkbenchSplitDirection;
  sourceGroupId: string;
  tabId?: string;
  moveTab?: boolean;
  placement?: 'before' | 'after';
}

export interface MoveWorkbenchTabOptions {
  tabId: string;
  fromGroupId: string;
  toGroupId: string;
  toIndex?: number;
  activate?: boolean;
}

export interface DockWorkbenchTabOptions {
  tabId: string;
  fromGroupId: string;
  targetGroupId: string;
  edge: WorkbenchDockEdge;
}
