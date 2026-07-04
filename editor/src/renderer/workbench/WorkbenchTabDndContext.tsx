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

export interface WorkbenchTabDockDropData {
  kind: 'workbench-tab-dock-group';
  groupId: string;
}

interface WorkbenchTabDropIndicator {
  groupId: string;
  index: number;
  x: number;
  top: number;
  height: number;
}

interface WorkbenchTabDockIndicator {
  groupId: string;
  edge: 'left' | 'right' | 'top' | 'bottom';
  left: number;
  top: number;
  width: number;
  height: number;
}

interface WorkbenchTabGroupDropIndicator {
  groupId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

type WorkbenchTabDropData = WorkbenchTabDragData | WorkbenchTabGroupDropData | WorkbenchTabDockDropData;
type WorkbenchTabDragEvent = DragMoveEvent | DragOverEvent | DragEndEvent;

export function workbenchTabDndId(tabId: string): string {
  return `workbench-tab:${tabId}`;
}

export function workbenchTabGroupDndId(groupId: string): string {
  return `workbench-tab-group:${groupId}`;
}

export function workbenchTabDockDndId(groupId: string): string {
  return `workbench-tab-dock-group:${groupId}`;
}

function isWorkbenchTabDragData(data: unknown): data is WorkbenchTabDragData {
  return typeof data === 'object' && data !== null && (data as WorkbenchTabDropData).kind === 'workbench-tab';
}

function isWorkbenchTabGroupDropData(data: unknown): data is WorkbenchTabGroupDropData {
  return typeof data === 'object' && data !== null && (data as WorkbenchTabDropData).kind === 'workbench-tab-group';
}

function isWorkbenchTabDockDropData(data: unknown): data is WorkbenchTabDockDropData {
  return typeof data === 'object' && data !== null && (data as WorkbenchTabDropData).kind === 'workbench-tab-dock-group';
}

const workbenchTabCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  const collisions = pointerCollisions.length > 0 ? pointerCollisions : rectIntersection(args);
  const tabCollisions = collisions.filter((collision) => String(collision.id).startsWith('workbench-tab:'));
  if (tabCollisions.length > 0) return tabCollisions;
  const groupCollisions = collisions.filter((collision) => String(collision.id).startsWith('workbench-tab-group:'));
  if (groupCollisions.length > 0) return groupCollisions;
  const dockCollisions = collisions.filter((collision) => String(collision.id).startsWith('workbench-tab-dock-group:'));
  if (dockCollisions.length > 0) return dockCollisions;
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

function groupElement(groupId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(`[data-workbench-group-id="${selectorValue(groupId)}"]`);
}

function groupBodyRect(groupId: string): { left: number; right: number; top: number; bottom: number; width: number; height: number } | null {
  const element = groupElement(groupId);
  if (!element) return null;
  const groupRect = element.getBoundingClientRect();
  const stripRect = tabStripElement(groupId)?.getBoundingClientRect();
  const top = stripRect ? stripRect.bottom : groupRect.top;
  const rect = {
    left: groupRect.left,
    right: groupRect.right,
    top,
    bottom: groupRect.bottom,
    width: groupRect.width,
    height: Math.max(0, groupRect.bottom - top),
  };
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

function activeCenter(event: WorkbenchTabDragEvent): { x: number; y: number } | null {
  const rect = event.active.rect.current.translated ?? event.active.rect.current.initial;
  return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
}

function dragPointerPosition(event: WorkbenchTabDragEvent): { x: number; y: number } | null {
  const activatorEvent = event.activatorEvent;
  if ('clientX' in activatorEvent && 'clientY' in activatorEvent) {
    const clientX = activatorEvent.clientX;
    const clientY = activatorEvent.clientY;
    if (typeof clientX === 'number' && typeof clientY === 'number') {
      return { x: clientX + event.delta.x, y: clientY + event.delta.y };
    }
  }
  return activeCenter(event);
}

function appendIndicatorX(groupId: string, workbench: WorkbenchState, fallbackRect: { left: number }): number {
  const strip = tabStripElement(groupId);
  const group = workbench.groupsById[groupId];
  const lastTabId = group?.tabIds.at(-1) ?? null;
  const lastTab = lastTabId ? tabElement(lastTabId) : null;
  if (lastTab && strip?.contains(lastTab)) return lastTab.getBoundingClientRect().right;
  return strip?.getBoundingClientRect().left ?? fallbackRect.left;
}

function groupIdFromOverData(data: unknown): string | null {
  if (isWorkbenchTabDragData(data) || isWorkbenchTabGroupDropData(data) || isWorkbenchTabDockDropData(data)) {
    return data.groupId;
  }
  return null;
}

function dockTargetFromEvent(
  event: WorkbenchTabDragEvent,
  workbench: WorkbenchState,
): { groupId: string; edge: WorkbenchTabDockIndicator['edge']; indicator: WorkbenchTabDockIndicator } | null {
  const overData = event.over?.data.current;
  const groupId = groupIdFromOverData(overData);
  if (!groupId || !workbench.groupsById[groupId]) return null;
  const allowVerticalDock = isWorkbenchTabDockDropData(overData);
  const pointer = dragPointerPosition(event);
  if (!pointer) return null;
  const stripRect = tabStripElement(groupId)?.getBoundingClientRect();
  if (stripRect && pointer.y >= stripRect.top && pointer.y <= stripRect.bottom) return null;

  const rect = groupBodyRect(groupId);
  if (!rect) return null;
  const horizontalThreshold = rect.width * 0.25;
  const verticalThreshold = rect.height * 0.25;
  const distances = [
    { edge: 'left' as const, distance: Math.abs(pointer.x - rect.left), active: pointer.x <= rect.left + horizontalThreshold },
    { edge: 'right' as const, distance: Math.abs(rect.right - pointer.x), active: pointer.x >= rect.right - horizontalThreshold },
    { edge: 'top' as const, distance: Math.abs(pointer.y - rect.top), active: allowVerticalDock && pointer.y <= rect.top + verticalThreshold },
    { edge: 'bottom' as const, distance: Math.abs(rect.bottom - pointer.y), active: allowVerticalDock && pointer.y >= rect.bottom - verticalThreshold },
  ].filter((candidate) => candidate.active);
  const nearest = distances.sort((a, b) => a.distance - b.distance)[0];
  if (!nearest) return null;

  const previewWidth = nearest.edge === 'left' || nearest.edge === 'right' ? rect.width * 0.5 : rect.width;
  const previewHeight = nearest.edge === 'top' || nearest.edge === 'bottom' ? rect.height * 0.5 : rect.height;
  const left = nearest.edge === 'right' ? rect.right - previewWidth : rect.left;
  const top = nearest.edge === 'bottom' ? rect.bottom - previewHeight : rect.top;
  return {
    groupId,
    edge: nearest.edge,
    indicator: {
      groupId,
      edge: nearest.edge,
      left,
      top,
      width: previewWidth,
      height: previewHeight,
    },
  };
}

function dropTargetFromEvent(
  event: WorkbenchTabDragEvent,
  activeData: WorkbenchTabDragData,
  workbench: WorkbenchState,
): { groupId: string; index: number; indicator: WorkbenchTabDropIndicator | null; groupIndicator: WorkbenchTabGroupDropIndicator | null } | null {
  const over = event.over;
  const overData = over?.data.current;
  if (!over || !overData) return null;

  if (isWorkbenchTabDragData(overData)) {
    const targetGroup = workbench.groupsById[overData.groupId];
    if (!targetGroup) return null;
    const overIndex = targetGroup.tabIds.indexOf(overData.tabId);
    if (overIndex < 0) return null;

    const x = dragPointerPosition(event)?.x ?? over.rect.left + over.rect.width / 2;
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
      groupIndicator: null,
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
      groupIndicator: null,
    };
  }

  if (isWorkbenchTabDockDropData(overData)) {
    const targetGroup = workbench.groupsById[overData.groupId];
    const rect = groupBodyRect(overData.groupId);
    if (!targetGroup || !rect) return null;
    return {
      groupId: overData.groupId,
      index: targetGroup.tabIds.length,
      indicator: null,
      groupIndicator: {
        groupId: overData.groupId,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
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

function WorkbenchTabDockPreview({ indicator }: { indicator: WorkbenchTabDockIndicator }) {
  return (
    <div
      className="pointer-events-none fixed z-[999] rounded border border-primary/70 bg-primary/15 ring-1 ring-primary/30"
      style={{
        left: indicator.left,
        top: indicator.top,
        width: indicator.width,
        height: indicator.height,
      }}
    />
  );
}

function WorkbenchTabGroupDropPreview({ indicator }: { indicator: WorkbenchTabGroupDropIndicator }) {
  return (
    <div
      className="pointer-events-none fixed z-[999] rounded border border-primary/70 bg-primary/15 ring-1 ring-primary/30"
      style={{
        left: indicator.left,
        top: indicator.top,
        width: indicator.width,
        height: indicator.height,
      }}
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

function sameDockIndicator(a: WorkbenchTabDockIndicator | null, b: WorkbenchTabDockIndicator | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.groupId === b.groupId
    && a.edge === b.edge
    && Math.abs(a.left - b.left) < 0.5
    && Math.abs(a.top - b.top) < 0.5
    && Math.abs(a.width - b.width) < 0.5
    && Math.abs(a.height - b.height) < 0.5;
}

function sameGroupDropIndicator(a: WorkbenchTabGroupDropIndicator | null, b: WorkbenchTabGroupDropIndicator | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.groupId === b.groupId
    && Math.abs(a.left - b.left) < 0.5
    && Math.abs(a.top - b.top) < 0.5
    && Math.abs(a.width - b.width) < 0.5
    && Math.abs(a.height - b.height) < 0.5;
}

export function WorkbenchTabDndContext({ children }: { children: ReactNode }) {
  const [activeDrag, setActiveDrag] = useState<WorkbenchTabDragData | null>(null);
  const [dropIndicator, setDropIndicator] = useState<WorkbenchTabDropIndicator | null>(null);
  const [groupDropIndicator, setGroupDropIndicator] = useState<WorkbenchTabGroupDropIndicator | null>(null);
  const [dockIndicator, setDockIndicator] = useState<WorkbenchTabDockIndicator | null>(null);
  const dockTabToGroupEdge = useWorkbenchStore((state) => state.dockTabToGroupEdge);
  const moveTab = useWorkbenchStore((state) => state.moveTab);
  const moveTabWithinGroup = useWorkbenchStore((state) => state.moveTabWithinGroup);
  const activeTab = useWorkbenchStore((state) => activeDrag ? state.tabsById[activeDrag.tabId] ?? null : null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function updateDropIndicator(event: WorkbenchTabDragEvent) {
    const activeData = event.active.data.current;
    if (!isWorkbenchTabDragData(activeData)) {
      setDropIndicator(null);
      setGroupDropIndicator(null);
      setDockIndicator(null);
      return;
    }
    const workbench = useWorkbenchStore.getState();
    const dockTarget = dockTargetFromEvent(event, workbench);
    if (dockTarget) {
      setDropIndicator(null);
      setGroupDropIndicator(null);
      setDockIndicator((current) => (sameDockIndicator(current, dockTarget.indicator) ? current : dockTarget.indicator));
      return;
    }
    setDockIndicator(null);
    const target = dropTargetFromEvent(event, activeData, workbench);
    setDropIndicator((current) => (sameIndicator(current, target?.indicator ?? null) ? current : target?.indicator ?? null));
    setGroupDropIndicator((current) => (sameGroupDropIndicator(current, target?.groupIndicator ?? null) ? current : target?.groupIndicator ?? null));
  }

  function clearDragState() {
    setActiveDrag(null);
    setDropIndicator(null);
    setGroupDropIndicator(null);
    setDockIndicator(null);
  }

  function handleDragStart(event: DragStartEvent) {
    const activeData = event.active.data.current;
    if (isWorkbenchTabDragData(activeData)) setActiveDrag(activeData);
  }

  function handleDragEnd(event: DragEndEvent) {
    const activeData = event.active.data.current;
    const workbench = useWorkbenchStore.getState();
    const dockTarget = isWorkbenchTabDragData(activeData) ? dockTargetFromEvent(event, workbench) : null;
    const target = isWorkbenchTabDragData(activeData) && !dockTarget ? dropTargetFromEvent(event, activeData, workbench) : null;
    clearDragState();
    if (!isWorkbenchTabDragData(activeData)) return;

    const sourceGroup = workbench.groupsById[activeData.groupId];
    if (!sourceGroup || !sourceGroup.tabIds.includes(activeData.tabId)) return;

    if (dockTarget) {
      dockTabToGroupEdge({
        tabId: activeData.tabId,
        fromGroupId: activeData.groupId,
        targetGroupId: dockTarget.groupId,
        edge: dockTarget.edge,
      });
      return;
    }

    if (!target) return;

    const targetGroup = workbench.groupsById[target.groupId];
    if (!targetGroup) return;

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
      {dockIndicator ? <WorkbenchTabDockPreview indicator={dockIndicator} /> : null}
      {groupDropIndicator ? <WorkbenchTabGroupDropPreview indicator={groupDropIndicator} /> : null}
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
