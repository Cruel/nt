import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties, type RefObject } from 'react';
import {
  WorkbenchEditorLocationProvider,
  type WorkbenchEditorLocation,
} from './workbench-editor-location';
import type { ResolvedWorkbenchEditorPolicies, WorkbenchEditorRegistration } from './editor-registry';
import { captureWorkbenchTabState, restoreWorkbenchTabState, useWorkbenchTabStateStore } from './workbench-tab-state';
import { consumeWorkbenchRevealTarget, invokeWorkbenchTargetHandler, type PendingWorkbenchRevealTarget } from './workbench-navigation';
import type { WorkbenchTab } from './workbench-types';

interface WorkbenchEditorPaneProps {
  tab: WorkbenchTab;
  registration: WorkbenchEditorRegistration;
  policies: ResolvedWorkbenchEditorPolicies;
  location: WorkbenchEditorLocation;
  restoreMode?: 'when-active' | 'initial-mount';
  className?: string;
  style?: CSSProperties;
  elementRef?: RefObject<HTMLDivElement | null>;
  onFocusCapture?: () => void;
  onPointerDownCapture?: () => void;
}

export function WorkbenchEditorPane({
  tab,
  registration,
  policies,
  location,
  restoreMode = 'when-active',
  className,
  style,
  elementRef,
  onFocusCapture,
  onPointerDownCapture,
}: WorkbenchEditorPaneProps) {
  const EditorComponent = registration.component;
  const paneRef = useRef<HTMLDivElement | null>(null);
  const restoredOnMountRef = useRef(false);
  const isVisible = location.isVisible;
  const setPaneElement = useCallback((element: HTMLDivElement | null) => {
    paneRef.current = element;
    if (elementRef) elementRef.current = element;
  }, [elementRef]);

  useEffect(() => {
    if (restoreMode === 'initial-mount') {
      if (restoredOnMountRef.current) return;
      restoredOnMountRef.current = true;
      restoreWorkbenchTabState(tab.id);
      return;
    }
    if (location.isActiveInGroup) restoreWorkbenchTabState(tab.id);
  }, [location.isActiveInGroup, restoreMode, tab.id]);

  useLayoutEffect(() => () => {
    if (policies.mountPolicy !== 'active-only') return;
    if (useWorkbenchTabStateStore.getState().tabStatesById[tab.id]) return;
    captureWorkbenchTabState(tab.id);
  }, [policies.mountPolicy, tab.id]);

  useEffect(() => {
    if (!isVisible) return;
    const pending = consumeWorkbenchRevealTarget(tab);
    if (!pending) return;
    revealWorkbenchTarget(paneRef.current, pending);
  }, [isVisible, tab]);

  return (
    <WorkbenchEditorLocationProvider location={location}>
      <div
        ref={setPaneElement}
        aria-hidden={isVisible ? undefined : true}
        className={`${isVisible ? 'h-full min-h-0' : 'pointer-events-none invisible h-full min-h-0'}${className ? ` ${className}` : ''}`}
        data-hidden={isVisible ? undefined : true}
        data-workbench-editor-pane={tab.id}
        data-workbench-group-id={location.groupId || undefined}
        inert={isVisible ? undefined : true}
        onFocusCapture={onFocusCapture}
        onPointerDownCapture={onPointerDownCapture}
        style={style}
      >
        <EditorComponent tab={tab} />
      </div>
    </WorkbenchEditorLocationProvider>
  );
}

function revealWorkbenchTarget(root: HTMLElement | null, target: PendingWorkbenchRevealTarget) {
  if (!root) return;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const tabId = root.dataset.workbenchEditorPane;
      if (tabId && invokeWorkbenchTargetHandler(tabId, target)) return;
      revealWorkbenchAnchor(root, target, 8);
    });
  });
}

function revealWorkbenchAnchor(root: HTMLElement, target: PendingWorkbenchRevealTarget, attemptsRemaining: number) {
  window.requestAnimationFrame(() => {
    const escapedTargetId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(target.id) : target.id.replaceAll('"', '\\"');
    const anchor = root.querySelector<HTMLElement>(`[data-workbench-anchor="${escapedTargetId}"]`);
    if (!anchor) {
      if (attemptsRemaining > 0) revealWorkbenchAnchor(root, target, attemptsRemaining - 1);
      return;
    }
    anchor.scrollIntoView({
      behavior: 'smooth',
      block: target.block ?? 'nearest',
      inline: target.inline ?? 'nearest',
    });
    if (target.focus) anchor.focus({ preventScroll: true });
    if (!target.flash) return;
    anchor.dataset.workbenchAnchorFlash = String(target.requestId);
    window.setTimeout(() => {
      if (anchor.dataset.workbenchAnchorFlash === String(target.requestId)) {
        delete anchor.dataset.workbenchAnchorFlash;
      }
    }, 1200);
  });
}
