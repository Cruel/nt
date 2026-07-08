import type { OpenWorkbenchTabOptions, WorkbenchTab } from './workbench-types';
import { useWorkbenchStore } from './workbench-store';

export interface WorkbenchRevealTarget {
  id: string;
  block?: ScrollLogicalPosition;
  inline?: ScrollLogicalPosition;
  flash?: boolean;
  focus?: boolean;
  payload?: unknown;
}

export interface WorkbenchNavigationRequest {
  tab: WorkbenchTab;
  target?: WorkbenchRevealTarget;
  options?: OpenWorkbenchTabOptions;
}

export type PendingWorkbenchRevealTarget = WorkbenchRevealTarget & {
  requestId: number;
};

export type WorkbenchTargetHandler = (target: PendingWorkbenchRevealTarget) => boolean | void;

let nextRequestId = 1;
const pendingTargetsByResourceKey = new Map<string, PendingWorkbenchRevealTarget>();
const targetHandlersByTabId = new Map<string, Map<string, WorkbenchTargetHandler>>();

export function workbenchResourceKey(tab: WorkbenchTab): string | null {
  if (!tab.resource) return null;
  return `${tab.editorType}:${tab.resource.stableId}`;
}

export function enqueueWorkbenchRevealTarget(tab: WorkbenchTab, target: WorkbenchRevealTarget): PendingWorkbenchRevealTarget | null {
  const key = workbenchResourceKey(tab);
  if (!key) return null;
  const pending = { ...target, requestId: nextRequestId };
  nextRequestId += 1;
  pendingTargetsByResourceKey.set(key, pending);
  return pending;
}

export function consumeWorkbenchRevealTarget(tab: WorkbenchTab): PendingWorkbenchRevealTarget | null {
  const key = workbenchResourceKey(tab);
  if (!key) return null;
  const pending = pendingTargetsByResourceKey.get(key) ?? null;
  if (pending) pendingTargetsByResourceKey.delete(key);
  return pending;
}

export function peekWorkbenchRevealTarget(tab: WorkbenchTab): PendingWorkbenchRevealTarget | null {
  const key = workbenchResourceKey(tab);
  if (!key) return null;
  return pendingTargetsByResourceKey.get(key) ?? null;
}

export function clearWorkbenchRevealTargets() {
  pendingTargetsByResourceKey.clear();
}

export function registerWorkbenchTargetHandler(tabId: string, targetId: string, handler: WorkbenchTargetHandler): () => void {
  const handlers = targetHandlersByTabId.get(tabId) ?? new Map<string, WorkbenchTargetHandler>();
  handlers.set(targetId, handler);
  targetHandlersByTabId.set(tabId, handlers);
  return () => {
    const current = targetHandlersByTabId.get(tabId);
    if (!current || current.get(targetId) !== handler) return;
    current.delete(targetId);
    if (current.size === 0) targetHandlersByTabId.delete(tabId);
  };
}

export function invokeWorkbenchTargetHandler(tabId: string, target: PendingWorkbenchRevealTarget): boolean {
  const handler = targetHandlersByTabId.get(tabId)?.get(target.id);
  return handler ? handler(target) === true : false;
}

export function navigateToWorkbenchTarget(request: WorkbenchNavigationRequest) {
  if (request.target) enqueueWorkbenchRevealTarget(request.tab, request.target);
  useWorkbenchStore.getState().openTab(request.tab, request.options);
}
