import { Group, Panel, Separator } from 'react-resizable-panels';
import { DirtyCloseDialog } from './DirtyCloseDialog';
import { WorkbenchGroup } from './WorkbenchGroup';
import { useWorkbenchStore } from './workbench-store';
import type { WorkbenchLayoutNode } from './workbench-types';

function ResizeHandle({ orientation }: { orientation: 'horizontal' | 'vertical' }) {
  return (
    <Separator
      className={`${orientation === 'horizontal' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'} bg-border transition-colors hover:bg-primary/40 data-[resize-handle-active]:bg-primary/50`}
    />
  );
}

function WorkbenchLayoutRenderer({ node }: { node: WorkbenchLayoutNode }) {
  const groupsById = useWorkbenchStore((state) => state.groupsById);
  const tabsById = useWorkbenchStore((state) => state.tabsById);

  if (node.kind === 'group') {
    const group = groupsById[node.groupId];
    if (!group) return null;
    const tabs = group.tabIds.map((tabId) => tabsById[tabId]).filter((tab): tab is NonNullable<typeof tab> => Boolean(tab));
    return <WorkbenchGroup group={group} tabs={tabs} />;
  }

  const children = node.children.flatMap((child, index) => {
    const key = child.kind === 'group' ? child.groupId : child.id;
    const panel = (
      <Panel key={`panel:${key}`} defaultSize={`${node.sizes?.[index] ?? 100 / node.children.length}%`} minSize="180px">
        <WorkbenchLayoutRenderer node={child} />
      </Panel>
    );
    if (index === 0) return [panel];
    return [<ResizeHandle key={`resize:${key}`} orientation={node.direction} />, panel];
  });

  return (
    <Group orientation={node.direction} className="h-full w-full">
      {children}
    </Group>
  );
}

export function Workbench() {
  const layout = useWorkbenchStore((state) => state.layout);
  return (
    <div className="h-full min-h-0 overflow-hidden bg-background">
      <WorkbenchLayoutRenderer node={layout} />
      <DirtyCloseDialog />
    </div>
  );
}
