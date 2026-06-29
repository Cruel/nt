export type WorkbenchSplitDirection = 'horizontal' | 'vertical';

export type WorkbenchResourceKind = 'record' | 'preview' | 'tool' | 'raw';

export interface WorkbenchResource {
  kind: WorkbenchResourceKind;
  stableId: string;
  collection?: string;
  entityId?: string;
  testId?: string;
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
  sizes?: number[];
}

export type WorkbenchLayoutNode = WorkbenchLayoutGroupNode | WorkbenchLayoutSplitNode;

export interface ClosedWorkbenchTab {
  tab: WorkbenchTab;
  closedFromGroupId: string;
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
}

export interface MoveWorkbenchTabOptions {
  tabId: string;
  fromGroupId: string;
  toGroupId: string;
  toIndex?: number;
  activate?: boolean;
}
