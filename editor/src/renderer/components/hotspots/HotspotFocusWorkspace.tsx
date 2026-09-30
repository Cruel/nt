import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HotspotImageStage } from '@/components/image-stage/HotspotImageStage';
import {
  fitImageStageZoom,
  type StageRect,
  type StageSize,
} from '@/components/image-stage/image-stage-transforms';
import { Button } from '@/components/ui/button';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useHotspotFocusStore } from './hotspot-focus-store';
import type { EditableHotspot } from './hotspot-types';
import {
  resolveHotspotFocusTransitionFrames,
  type HotspotFocusTransitionFrames,
  type HotspotFocusRoomPresentation,
} from './hotspot-focus-transition';

interface RoomFocusPresentation extends HotspotFocusRoomPresentation {
  displayedViewportScreenRect: StageRect;
}

interface Props {
  tabId: string;
  projectAssets: Record<string, { data: unknown }>;
  roomPresentation?: RoomFocusPresentation | null;
  createHotspot: (
    id: string,
    inputOrder: number,
    bounds: { x: number; y: number; width: number; height: number },
  ) => EditableHotspot;
  onDone?: (selectedHotspotId: string | null) => void;
}

export function HotspotFocusWorkspace({
  tabId,
  projectAssets,
  roomPresentation = null,
  createHotspot,
  onDone,
}: Props) {
  const { t } = useTranslation('workspace');
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const session = useHotspotFocusStore((state) => state.sessionsByTabId[tabId]);
  const setSelection = useHotspotFocusStore((state) => state.setSelection);
  const setTool = useHotspotFocusStore((state) => state.setTool);
  const setCamera = useHotspotFocusStore((state) => state.setCamera);
  const initializeCamera = useHotspotFocusStore((state) => state.initializeCamera);
  const add = useHotspotFocusStore((state) => state.add);
  const setBounds = useHotspotFocusStore((state) => state.setBounds);
  const remove = useHotspotFocusStore((state) => state.delete);
  const undo = useHotspotFocusStore((state) => state.undo);
  const redo = useHotspotFocusStore((state) => state.redo);
  const commit = useHotspotFocusStore((state) => state.commit);
  const discard = useHotspotFocusStore((state) => state.discard);
  const [viewport, setViewport] = useState<StageSize>({ width: 0, height: 0 });
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [transitionPhase, setTransitionPhase] = useState<'room' | 'native' | 'focused' | null>(
    null,
  );
  const [exiting, setExiting] = useState(false);
  const [entryTransitionFrames, setEntryTransitionFrames] =
    useState<HotspotFocusTransitionFrames | null>(null);
  const [exitTransitionFrames, setExitTransitionFrames] =
    useState<HotspotFocusTransitionFrames | null>(null);
  const entrySnapshotRef = useRef(false);
  const entryAnimationStartedRef = useRef(false);
  const entryTransitionCleanupRef = useRef<(() => void) | null>(null);
  const transitionContainerRef = useRef<HTMLDivElement | null>(null);

  const assetData = useMemo(() => {
    if (!session?.assetId) return null;
    return parseAssetData(projectAssets[session.assetId]?.data);
  }, [projectAssets, session?.assetId]);
  const imageSize = useMemo(
    () =>
      assetData?.kind === 'image' && assetData.imageMetadata
        ? { width: assetData.imageMetadata.width, height: assetData.imageMetadata.height }
        : null,
    [assetData],
  );
  const displayedRoomViewport = useMemo(() => {
    const containerBounds = transitionContainerRef.current?.getBoundingClientRect();
    if (!roomPresentation || !containerBounds || viewport.width <= 0 || viewport.height <= 0)
      return null;
    return {
      x: roomPresentation.displayedViewportScreenRect.x - containerBounds.left,
      y: roomPresentation.displayedViewportScreenRect.y - containerBounds.top,
      width: roomPresentation.displayedViewportScreenRect.width,
      height: roomPresentation.displayedViewportScreenRect.height,
    };
  }, [roomPresentation, viewport]);
  const currentTransitionFrames = useMemo(
    () =>
      session?.cameraInitialized &&
      roomPresentation &&
      displayedRoomViewport &&
      imageSize &&
      viewport.width > 0 &&
      viewport.height > 0
        ? resolveHotspotFocusTransitionFrames({
            roomPresentation,
            displayedRoomViewport,
            focusViewport: viewport,
            imageSize,
            focusCamera: session.camera,
          })
        : null,
    [
      displayedRoomViewport,
      imageSize,
      roomPresentation,
      session?.camera,
      session?.cameraInitialized,
      viewport,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    setImageUrl(null);
    if (!projectSessionId || !session?.assetId || assetData?.kind !== 'image') return undefined;
    void window.noveltea
      .resolveProjectOriginalAssetUrl(projectSessionId, session.assetId)
      .then((result) => {
        if (!cancelled) setImageUrl(result.ok ? result.url : null);
      })
      .catch(() => {
        if (!cancelled) setImageUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [assetData?.kind, assetData?.source.path, projectSessionId, session?.assetId]);

  useEffect(() => {
    if (
      !session ||
      session.cameraInitialized ||
      !imageSize ||
      viewport.width <= 0 ||
      viewport.height <= 0
    )
      return;
    initializeCamera(tabId, {
      zoom: fitImageStageZoom(viewport, imageSize, 'native'),
      pan: { x: 0, y: 0 },
    });
  }, [imageSize, initializeCamera, session, tabId, viewport]);

  useEffect(() => {
    if (entrySnapshotRef.current || !currentTransitionFrames || !imageUrl) return;
    entrySnapshotRef.current = true;
    setEntryTransitionFrames(currentTransitionFrames);
  }, [currentTransitionFrames, imageUrl]);

  useEffect(() => {
    if (entryAnimationStartedRef.current || !entryTransitionFrames || !imageUrl) return;
    entryAnimationStartedRef.current = true;
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return;
    setTransitionPhase('room');
    const frame = window.requestAnimationFrame(() => setTransitionPhase('native'));
    const focusedTimer = window.setTimeout(() => setTransitionPhase('focused'), 90);
    const doneTimer = window.setTimeout(() => setTransitionPhase(null), 180);
    const cleanup = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(focusedTimer);
      window.clearTimeout(doneTimer);
    };
    entryTransitionCleanupRef.current = cleanup;
    return () => {
      if (entryTransitionCleanupRef.current === cleanup) entryTransitionCleanupRef.current = null;
      cleanup();
    };
  }, [entryTransitionFrames, imageUrl]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const undoShortcut = key === 'z' && !event.shiftKey;
      const redoShortcut = key === 'y' || (key === 'z' && event.shiftKey);
      if (!undoShortcut && !redoShortcut) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-terminal-panel]')) return;
      const workbench = useWorkbenchStore.getState();
      const activeTabId = workbench.groupsById[workbench.activeGroupId]?.activeTabId;
      if (activeTabId !== tabId || !useHotspotFocusStore.getState().sessionsByTabId[tabId]) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      const focus = useHotspotFocusStore.getState();
      if (undoShortcut) focus.undo(tabId);
      else focus.redo(tabId);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [tabId]);

  if (!session) return null;
  const hotspots = session.history.present;
  const canDraw = session.mode === 'rectangles';
  const animateExit = (action: () => boolean) => {
    if (exiting) return;
    entryTransitionCleanupRef.current?.();
    entryTransitionCleanupRef.current = null;
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const frames = currentTransitionFrames;
    if (!frames || !imageUrl || reducedMotion) {
      action();
      return;
    }
    setExitTransitionFrames(frames);
    setExiting(true);
    setTransitionPhase('focused');
    window.requestAnimationFrame(() => setTransitionPhase('native'));
    window.setTimeout(() => setTransitionPhase('room'), 90);
    window.setTimeout(() => {
      if (action()) return;
      setExiting(false);
      setExitTransitionFrames(null);
      setTransitionPhase(null);
    }, 180);
  };
  const transitionFrames = exiting ? exitTransitionFrames : entryTransitionFrames;
  const transitionFrame = transitionPhase ? transitionFrames?.[transitionPhase] : null;
  const nextId = () => {
    const ids = new Set(hotspots.map((item) => item.id));
    for (let index = 1; ; index += 1) {
      const id = index === 1 ? 'hotspot' : `hotspot-${index}`;
      if (!ids.has(id)) return id;
    }
  };
  const nextInputOrder = () =>
    Math.min(
      2147483647,
      hotspots.reduce((maximum, item) => Math.max(maximum, item.inputOrder), -1) + 1,
    );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-hotspot-focus="" tabIndex={-1}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="mr-auto min-w-0">
          <div className="truncate text-sm font-medium">{t('hotspots.focus.title')}</div>
          <div className="truncate text-xs text-muted-foreground">
            {canDraw ? t('hotspots.focus.rectangleHelp') : t('hotspots.focus.alphaHelp')}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant={session.tool === 'select' ? 'default' : 'outline'}
          aria-pressed={session.tool === 'select'}
          onClick={() => setTool(tabId, 'select')}
        >
          {t('hotspots.focus.select')}
        </Button>
        {canDraw ? (
          <Button
            type="button"
            size="sm"
            variant={session.tool === 'draw-rect' ? 'default' : 'outline'}
            aria-pressed={session.tool === 'draw-rect'}
            onClick={() => setTool(tabId, 'draw-rect')}
          >
            {t('hotspots.focus.rectangle')}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={session.tool === 'pan' ? 'default' : 'outline'}
          aria-pressed={session.tool === 'pan'}
          onClick={() => setTool(tabId, 'pan')}
        >
          {t('hotspots.focus.pan')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!imageSize || viewport.width <= 0 || viewport.height <= 0}
          onClick={() =>
            imageSize &&
            setCamera(tabId, {
              zoom: fitImageStageZoom(viewport, imageSize, 'native'),
              pan: { x: 0, y: 0 },
            })
          }
        >
          {t('hotspots.focus.fit')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setCamera(tabId, { zoom: 1, pan: { x: 0, y: 0 } })}
        >
          {t('hotspots.focus.native')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={session.history.past.length === 0}
          onClick={() => undo(tabId)}
        >
          {t('hotspots.focus.undo')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={session.history.future.length === 0}
          onClick={() => redo(tabId)}
        >
          {t('hotspots.focus.redo')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={exiting}
          onClick={() => animateExit(() => discard(tabId))}
        >
          {t('hotspots.focus.cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={exiting}
          onClick={() => {
            const selectedHotspotId = session.selectedHotspotId;
            animateExit(() => {
              const committed = commit(tabId);
              if (committed) onDone?.(selectedHotspotId);
              return committed;
            });
          }}
        >
          {t('hotspots.focus.done')}
        </Button>
      </div>
      {!imageSize ? (
        <div className="p-4 text-sm text-destructive">{t('hotspots.invalidImage')}</div>
      ) : (
        <div ref={transitionContainerRef} className="relative min-h-0 flex-1 overflow-hidden">
          <HotspotImageStage
            className={`h-full min-h-0 transition-opacity duration-75 ${transitionPhase ? 'opacity-0' : 'opacity-100'}`}
            imageUrl={imageUrl}
            imageSize={imageSize}
            zoomBasis="native"
            hotspots={hotspots.flatMap((item) =>
              item.shape
                ? [
                    {
                      id: item.id,
                      label: item.label,
                      inputOrder: item.inputOrder,
                      bounds: item.shape.bounds,
                    },
                  ]
                : [],
            )}
            selectedHotspotId={session.selectedHotspotId}
            tool={session.tool}
            camera={session.camera}
            alphaVisualization={session.mode === 'sprite-alpha'}
            onViewportChange={setViewport}
            onSelectionChange={(selectedHotspotId) => setSelection(tabId, selectedHotspotId)}
            onCameraChange={(camera) => setCamera(tabId, camera)}
            onCreate={(bounds) => {
              if (!canDraw) return;
              add(tabId, createHotspot(nextId(), nextInputOrder(), bounds));
            }}
            onCancelCreate={() => setTool(tabId, 'select')}
            onCommitBounds={(id, bounds) => setBounds(tabId, id, bounds)}
            onDelete={(id) => remove(tabId, id)}
          />
          {transitionFrame && imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              className="pointer-events-none absolute max-w-none transition-[left,top,width,height,transform] duration-[90ms] ease-out"
              style={{
                left: transitionFrame.rect.x,
                top: transitionFrame.rect.y,
                width: transitionFrame.rect.width,
                height: transitionFrame.rect.height,
                transform: `rotate(${transitionFrame.rotationDegrees}deg)`,
                transformOrigin: 'center',
              }}
              data-testid={`hotspot-focus-transition-${transitionPhase}`}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
