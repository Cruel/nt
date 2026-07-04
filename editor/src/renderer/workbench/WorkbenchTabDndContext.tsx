import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { editorIconClassNameForTab, editorIconForType } from './editor-registry';
import { useWorkbenchStore } from './workbench-store';
import type { WorkbenchState, WorkbenchTab } from './workbench-types';

export interface WorkbenchTabDragData {
  kind: 'workbench-tab';
  tabId: string;
  groupId: string;
}

export interface WorkbenchTabGroupDropData {
  kind: 'workbench-tab-group';
  groupId: string;
}

interface WorkbenchTabDropIndicator {
  groupId: string;
  index: number;
  x: number;
  top: number;
  height: number;
}

type WorkbenchTabDropData = WorkbenchTabDragData | WorkbenchTabGroupDropData;
type WorkbenchTabDragEvent = DragMoveEvent | DragOverEvent | DragEndEvent;

export function workbenchTabDndId(tabId: string): string {
  return `workbench-tab:${tabId}`;
}

export function workbenchTabGroupDndId(groupId: string): string {
  return `workbench-tab-group:${groupId}`;
}

function isWorkbenchTabDragData(data: unknown): data is WorkbenchTabDragData {
  return typeof data === 'object' && data !== null && (data as WorkbenchTabDropData).kind === 'workbench-tab';
}

function isWorkbenchTabGroupDropData(data: unknown): data is WorkbenchTabGroupDropData {
  return typeof data === 'object' && data !== null && (data as WorkbenchTabDropData).kind === 'workbench-tab-group';
}

const workbenchTabCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  const collisions = pointerCollisions.length > 0 ? pointerCollisions : rectIntersection(args);
  const tabCollisions = collisions.filter((collision) => String(collision.id).startsWith('workbench-tab:'));
  if (tabCollisions.length > 0) return tabCollisions;
  const groupCollisions = collisions.filter((collision) => String(collision.id).startsWith('workbench-tab-group:'));
  if (groupCollisions.length > 0) return groupCollisions;
  return closestCenter(args);
};

function selectorValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function tabElement(tabId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(`[data-workbench-tab-id="${selectorValue(tabId)}"]`);
}

function tabStripElement(groupId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(`[data-workbench-tab-strip-id="${selectorValue(groupId)}"]`);
}

function activeCenterX(event: WorkbenchTabDragEvent): number | null {
  const rect = event.active.rect.current.translated ?? event.active.rect.current.initial;
  return rect ? rect.left + rect.width / 2 : null;
}

function appendIndicatorX(groupId: string, workbench: WorkbenchState, fallbackRect: { left: number }): number {
  const strip = tabStripElement(groupId);
  const group = workbench.groupsById[groupId];
  const lastTabId = group?.tabIds.at(-1) ?? null;
  const lastTab = lastTabId ? tabElement(lastTabId) : null;
  if (lastTab && strip?.contains(lastTab)) return lastTab.getBoundingClientRect().right;
  return strip?.getBoundingClientRect().left ?? fallbackRect.left;
}

function dropTargetFromEvent(
  event: WorkbenchTabDragEvent,
  activeData: WorkbenchTabDragData,
  workbench: WorkbenchState,
): { groupId: string; index: number; indicator: WorkbenchTabDropIndicator } | null {
  const over = event.over;
  const overData = over?.data.current;
  if (!over || !overData) return null;

  if (isWorkbenchTabDragData(overData)) {
    const targetGroup = workbench.groupsById[overData.groupId];
    if (!targetGroup) return null;
    const overIndex = targetGroup.tabIds.indexOf(overData.tabId);
    if (overIndex < 0) return null;

    const x = activeCenterX(event) ?? over.rect.left + over.rect.width / 2;
    const dropAfter = x > over.rect.left + over.rect.width / 2;
    const index = overIndex + (dropAfter ? 1 : 0);
    return {
      groupId: overData.groupId,
      index,
      indicator: {
        groupId: overData.groupId,
        index,
        x: dropAfter ? over.rect.right : over.rect.left,
        top: over.rect.top,
        height: over.rect.height,
      },
    };
  }

  if (isWorkbenchTabGroupDropData(overData)) {
    const targetGroup = workbench.groupsById[overData.groupId];
    if (!targetGroup) return null;
    const x = appendIndicatorX(overData.groupId, workbench, over.rect);
    return {
      groupId: overData.groupId,
      index: targetGroup.tabIds.length,
      indicator: {
        groupId: overData.groupId,
        index: targetGroup.tabIds.length,
        x,
        top: over.rect.top,
        height: over.rect.height,
      },
    };
  }

  return null;
}

function WorkbenchTabDragPreview({ tab }: { tab: WorkbenchTab }) {
  const Icon = editorIconForType(tab.editorType);
  return (
    <div className="pointer-events-none flex h-8 min-w-28 max-w-52 items-center gap-1 rounded-t border bg-background px-1.5 text-xs text-foreground opacity-50 shadow-lg ring-1 ring-primary/30">
      <Icon className={`h-3.5 w-3.5 shrink-0 ${editorIconClassNameForTab(tab)}`} />
      <span className="truncate">{tab.title}</span>
    </div>
  );
}

function WorkbenchTabDropLine({ indicator }: { indicator: WorkbenchTabDropIndicator }) {
  return (
    <div
      className="pointer-events-none fixed z-[1000] w-0.5 bg-primary"
      style={{ left: indicator.x - 1, top: indicator.top + 4, height: Math.max(10, indicator.height - 8) }}
    />
  );
}

function sameIndicator(a: WorkbenchTabDropIndicator | null, b: WorkbenchTabDropIndicator | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.groupId === b.groupId
    && a.index === b.index
    && Math.abs(a.x - b.x) < 0.5
    && Math.abs(a.top - b.top) < 0.5
    && Math.abs(a.height - b.height) < 0.5;
}

export function WorkbenchTabDndContext({ children }: { children: ReactNode }) {
  const [activeDrag, setActiveDrag] = useState<WorkbenchTabDragData | null>(null);
  const [dropIndicator, setDropIndicator] = useState<WorkbenchTabDropIndicator | null>(null);
  const moveTab = useWorkbenchStore((state) => state.moveTab);
  const moveTabWithinGroup = useWorkbenchStore((state) => state.moveTabWithinGroup);
  const activeTab = useWorkbenchStore((state) => activeDrag ? state.tabsById[activeDrag.tabId] ?? null : null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function updateDropIndicator(event: WorkbenchTabDragEvent) {
    const activeData = event.active.data.current;
    if (!isWorkbenchTabDragData(activeData)) {
      setDropIndicator(null);
      return;
    }
    const target = dropTargetFromEvent(event, activeData, useWorkbenchStore.getState());
    setDropIndicator((current) => (sameIndicator(current, target?.indicator ?? null) ? current : target?.indicator ?? null));
  }

  function clearDragState() {
    setActiveDrag(null);
    setDropIndicator(null);
  }

  function handleDragStart(event: DragStartEvent) {
    const activeData = event.active.data.current;
    if (isWorkbenchTabDragData(activeData)) setActiveDrag(activeData);
  }

  function handleDragEnd(event: DragEndEvent) {
    const activeData = event.active.data.current;
    const workbench = useWorkbenchStore.getState();
    const target = isWorkbenchTabDragData(activeData) ? dropTargetFromEvent(event, activeData, workbench) : null;
    clearDragState();
    if (!isWorkbenchTabDragData(activeData) || !target) return;

    const sourceGroup = workbench.groupsById[activeData.groupId];
    const targetGroup = workbench.groupsById[target.groupId];
    if (!sourceGroup || !targetGroup || !sourceGroup.tabIds.includes(activeData.tabId)) return;

    if (target.groupId === activeData.groupId) {
      const sourceIndex = sourceGroup.tabIds.indexOf(activeData.tabId);
      const toIndex = target.index > sourceIndex ? target.index - 1 : target.index;
      if (toIndex === sourceIndex) return;
      moveTabWithinGroup(target.groupId, activeData.tabId, toIndex);
      return;
    }

    moveTab({
      tabId: activeData.tabId,
      fromGroupId: activeData.groupId,
      toGroupId: target.groupId,
      toIndex: Math.max(0, Math.min(target.index, targetGroup.tabIds.length)),
    });
  }

  const overlay = (
    <>
      <DragOverlay dropAnimation={null}>
        {activeTab ? <WorkbenchTabDragPreview tab={activeTab} /> : null}
      </DragOverlay>
      {dropIndicator ? <WorkbenchTabDropLine indicator={dropIndicator} /> : null}
    </>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={workbenchTabCollisionDetection}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragMove={updateDropIndicator}
      onDragOver={updateDropIndicator}
      onDragCancel={clearDragState}
      onDragEnd={handleDragEnd}
    >
      {children}
      {typeof document === 'undefined' ? overlay : createPortal(overlay, document.body)}
    </DndContext>
  );
}
