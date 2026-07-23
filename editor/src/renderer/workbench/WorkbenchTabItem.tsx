import { useDraggable, useDroppable } from '@dnd-kit/core';
import { X } from 'lucide-react';
import { editorIconClassNameForTab, editorIconForType } from './editor-registry';
import { workbenchTabDndId } from './WorkbenchTabDndContext';
import type { WorkbenchTab } from './workbench-types';

interface WorkbenchTabItemProps {
  groupId: string;
  tab: WorkbenchTab;
  active: boolean;
  dirty: boolean;
  index: number;
  onActivate: () => void;
  onRequestClose: () => void;
}

export function WorkbenchTabItem({
  groupId,
  tab,
  active,
  dirty,
  index,
  onActivate,
  onRequestClose,
}: WorkbenchTabItemProps) {
  const Icon = editorIconForType(tab.editorType);
  const activeChrome =
    index === 0
      ? 'inset -1px 0 0 hsl(var(--border)), inset 0 1px 0 rgba(255,255,255,0.6)'
      : 'inset 1px 0 0 hsl(var(--border)), inset -1px 0 0 hsl(var(--border)), inset 0 1px 0 rgba(255,255,255,0.6)';
  const dndId = workbenchTabDndId(tab.id);
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableNodeRef,
    isDragging,
  } = useDraggable({
    id: dndId,
    data: { kind: 'workbench-tab', tabId: tab.id, groupId },
  });
  const { setNodeRef: setDroppableNodeRef } = useDroppable({
    id: dndId,
    data: { kind: 'workbench-tab', tabId: tab.id, groupId },
  });

  function setNodeRef(element: HTMLElement | null) {
    setDraggableNodeRef(element);
    setDroppableNodeRef(element);
  }

  return (
    <div
      ref={setNodeRef}
      data-workbench-tab-id={tab.id}
      className={`group/tab flex min-w-28 max-w-52 items-center gap-1 px-1.5 text-xs ${
        active
          ? 'border-b border-transparent bg-background text-foreground'
          : 'border-b border-r bg-background text-muted-foreground hover:bg-accent/60'
      } ${isDragging ? 'opacity-60' : ''}`}
      style={active ? { boxShadow: activeChrome } : undefined}
    >
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 touch-none items-center gap-1 self-stretch text-left"
        onClick={onActivate}
        {...attributes}
        {...listeners}
      >
        <Icon className={`h-3.5 w-3.5 shrink-0 ${editorIconClassNameForTab(tab)}`} />
        <span className="truncate">
          {dirty ? '● ' : ''}
          {tab.title}
        </span>
      </button>
      <button
        type="button"
        className={`ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center self-center rounded leading-none opacity-0 hover:bg-muted hover:opacity-100 focus-visible:opacity-100 ${
          active ? 'opacity-70' : 'group-hover/tab:opacity-60'
        }`}
        aria-label={`Close ${tab.title}`}
        onClick={onRequestClose}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
