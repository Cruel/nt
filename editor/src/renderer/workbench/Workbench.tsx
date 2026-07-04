import { Group, Panel, Separator } from 'react-resizable-panels';
import { DirtyCloseDialog } from './DirtyCloseDialog';
import { WorkbenchGroup } from './WorkbenchGroup';
import { WorkbenchTabDndContext } from './WorkbenchTabDndContext';
import { useWorkbenchStore } from './workbench-store';
import { workbenchLayoutChildKey } from './workbench-model';
import type { WorkbenchLayoutNode } from './workbench-types';

const pendingSplitSizesByChild = new Map<string, Record<string, number>>();

function currentSplitSizesByChild(node: Extract<WorkbenchLayoutNode, { kind: 'split' }>) {
  const fallback = 100 / node.children.length;
  return Object.fromEntries(node.children.map((child) => {
    const key = workbenchLayoutChildKey(child);
    return [key, node.sizesByChild?.[key] ?? fallback];
  }));
}

function ResizeHandle({ orientation }: { orientation: 'horizontal' | 'vertical' }) {
  return (
    <Separator
      className={`${orientation === 'horizontal' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'} bg-border transition-colors hover:bg-primary/40 data-[resize-handle-active]:bg-primary/50`}
    />
  );
}

function WorkbenchLayoutRenderer({ node, path = 'root' }: { node: WorkbenchLayoutNode; path?: string }) {
  const groupsById = useWorkbenchStore((state) => state.groupsById);
  const tabsById = useWorkbenchStore((state) => state.tabsById);
  const setSplitSizesByChild = useWorkbenchStore((state) => state.setSplitSizesByChild);

  if (node.kind === 'group') {
    const group = groupsById[node.groupId];
    if (!group) return null;
    const tabs = group.tabIds.map((tabId) => tabsById[tabId]).filter((tab): tab is NonNullable<typeof tab> => Boolean(tab));
    return <WorkbenchGroup group={group} tabs={tabs} />;
  }

  const children = node.children.flatMap((child, index) => {
    const key = workbenchLayoutChildKey(child);
    const childPath = `${path}/${index}:${key}`;
    const panelId = `workbench-panel:${childPath}`;
    const panel = (
      <Panel
        id={panelId}
        key={`panel:${childPath}`}
        defaultSize={`${node.sizesByChild?.[key] ?? 100 / node.children.length}%`}
        minSize="180px"
        onResize={(panelSize) => {
          if (!Number.isFinite(panelSize.asPercentage) || panelSize.asPercentage <= 0) return;
          const pending = pendingSplitSizesByChild.get(node.id) ?? currentSplitSizesByChild(node);
          pending[key] = panelSize.asPercentage;
          pendingSplitSizesByChild.set(node.id, pending);
        }}
      >
        <WorkbenchLayoutRenderer node={child} path={childPath} />
      </Panel>
    );
    if (index === 0) return [panel];
    return [<ResizeHandle key={`resize:${childPath}`} orientation={node.direction} />, panel];
  });

  return (
    <Group
      id={`workbench-split:${path}:${node.id}`}
      orientation={node.direction}
      className="h-full w-full"
      onLayoutChanged={(_layout, meta) => {
        if (!meta.isUserInteraction) return;
        const pending = pendingSplitSizesByChild.get(node.id);
        pendingSplitSizesByChild.delete(node.id);
        if (!pending) return;
        const childKeys = node.children.map(workbenchLayoutChildKey);
        if (childKeys.every((childKey) => typeof pending[childKey] === 'number' && Number.isFinite(pending[childKey]))) {
          setSplitSizesByChild(node.id, pending);
        }
      }}
    >
      {children}
    </Group>
  );
}

export function Workbench() {
  const layout = useWorkbenchStore((state) => state.layout);
  return (
    <div className="h-full min-h-0 overflow-hidden bg-background">
      <WorkbenchTabDndContext>
        <WorkbenchLayoutRenderer node={layout} />
      </WorkbenchTabDndContext>
      <DirtyCloseDialog />
    </div>
  );
}
