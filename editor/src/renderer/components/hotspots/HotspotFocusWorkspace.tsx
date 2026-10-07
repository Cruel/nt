import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { HotspotImageStage } from '@/components/image-stage/HotspotImageStage';
import {
  fitImageStageZoom,
  type StageRect,
  type StageSize,
} from '@/components/image-stage/image-stage-transforms';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { animationDataSchema } from '../../../shared/project-schema/authoring-animations';
import {
  advanceAnimationTime,
  animationDuration,
  animationFrameAt,
  animationFrameTime,
  type MotionPolicy,
} from '../../../shared/animation-timeline';
import { sampleHotspotMotionTrack } from '../../../shared/project-schema/authoring-hotspots';
import { parseInteractableData } from '../../../shared/project-schema/authoring-interactables';
import { resolveGameplayInstanceRecord } from '../../../shared/project-schema/authoring-archetypes';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { isTextEntryKeyboardTarget } from '@/components/image-stage/keyboard-target';
import { useHotspotFocusStore } from './hotspot-focus-store';
import type { EditableHotspot } from './hotspot-types';
import type { FocusTransitionImagePresentation } from '@/components/focus-transition/focus-transition-presentation';

export interface HotspotFocusWorkspaceHandle {
  getImagePresentation: () => FocusTransitionImagePresentation | null;
}

interface Props {
  tabId: string;
  projectAssets: Record<string, { data: unknown }>;
  createHotspot: (
    id: string,
    inputOrder: number,
    bounds: { x: number; y: number; width: number; height: number },
  ) => EditableHotspot;
  onDone?: (selectedHotspotId: string | null) => void;
  onImagePresentationChange?: (presentation: FocusTransitionImagePresentation | null) => void;
  onImageUrlChange?: (imageUrl: string | null) => void;
  onRequestClose?: (action: () => boolean) => void;
}

export const HotspotFocusWorkspace = forwardRef<HotspotFocusWorkspaceHandle, Props>(
  function HotspotFocusWorkspace(
    {
      tabId,
      projectAssets,
      createHotspot,
      onDone,
      onImagePresentationChange,
      onImageUrlChange,
      onRequestClose,
    },
    ref,
  ) {
    const { t } = useTranslation('workspace');
    const projectSessionId = useProjectStore((state) => state.projectSessionId);
    const project = useProjectStore((state) => state.document);
    const session = useHotspotFocusStore((state) => state.sessionsByTabId[tabId]);
    const setSelection = useHotspotFocusStore((state) => state.setSelection);
    const setTool = useHotspotFocusStore((state) => state.setTool);
    const setCamera = useHotspotFocusStore((state) => state.setCamera);
    const initializeCamera = useHotspotFocusStore((state) => state.initializeCamera);
    const setSnapToPixels = useHotspotFocusStore((state) => state.setSnapToPixels);
    const add = useHotspotFocusStore((state) => state.add);
    const setBounds = useHotspotFocusStore((state) => state.setBounds);
    const setMotionKeyframe = useHotspotFocusStore((state) => state.setMotionKeyframe);
    const remove = useHotspotFocusStore((state) => state.delete);
    const undo = useHotspotFocusStore((state) => state.undo);
    const redo = useHotspotFocusStore((state) => state.redo);
    const commit = useHotspotFocusStore((state) => state.commit);
    const discard = useHotspotFocusStore((state) => state.discard);
    const activeFocusTab = useWorkbenchStore(
      (state) => state.groupsById[state.activeGroupId]?.activeTabId === tabId,
    );
    const [viewport, setViewport] = useState<StageSize>({ width: 0, height: 0 });
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [alphaCoverage, setAlphaCoverage] = useState<ImageData | null>(null);
    const [imageRect, setImageRect] = useState<StageRect | null>(null);
    const [motionTimeMs, setMotionTimeMs] = useState(0);
    const [motionPlaying, setMotionPlaying] = useState(false);
    const [selectedMotionId, setSelectedMotionId] = useState<string | null>(null);
    const [motionInterpolation, setMotionInterpolation] = useState<'hold' | 'linear'>('hold');
    const workspaceRef = useRef<HTMLDivElement | null>(null);

    const animation = useMemo(() => {
      if (!session || session.ownerKind !== 'interactable' || !isAuthoringProject(project))
        return null;
      const record = project.interactables[session.ownerId];
      const interactable = record
        ? parseInteractableData(
            resolveGameplayInstanceRecord(project, 'interactable', record)?.data,
          )
        : null;
      const visual = interactable?.presentation.visual;
      if (visual?.kind !== 'animation') return null;
      const parsed = animationDataSchema.safeParse(
        project.animations[visual.animation.$ref.id]?.data,
      );
      if (!parsed.success) return null;
      return {
        animationId: visual.animation.$ref.id,
        data: parsed.data,
        initialMotionId: visual.motionId ?? parsed.data.defaultMotionId,
      };
    }, [project, session]);
    const motion = useMemo(() => {
      if (!animation) return null;
      const selected = animation.data.motions.find(
        (candidate) => candidate.id === (selectedMotionId ?? animation.initialMotionId),
      );
      return selected ? { animation: animation.data, motion: selected } : null;
    }, [animation, selectedMotionId]);
    const motionDurationMs = motion ? animationDuration(motion.motion) : 0;
    const spriteMotion = motion?.motion.kind === 'sprite-sequence' ? motion.motion : null;
    const motionFrameIndex = spriteMotion ? animationFrameAt(spriteMotion, motionTimeMs) : 0;
    const displayAssetId =
      (motion?.motion.kind === 'video'
        ? motion.motion.video.$ref.id
        : spriteMotion?.frames[motionFrameIndex]?.image.$ref.id) ??
      session?.assetId ??
      null;

    const assetData = useMemo(() => {
      if (!displayAssetId) return null;
      return parseAssetData(projectAssets[displayAssetId]?.data);
    }, [displayAssetId, projectAssets]);
    const imageSize = useMemo(
      () =>
        motion
          ? { width: motion.animation.canvas.width, height: motion.animation.canvas.height }
          : assetData?.kind === 'image' && assetData.imageMetadata
            ? { width: assetData.imageMetadata.width, height: assetData.imageMetadata.height }
            : null,
      [assetData, motion],
    );

    useEffect(() => {
      setSelectedMotionId(null);
      setMotionTimeMs(0);
      setMotionPlaying(false);
    }, [animation?.animationId, animation?.initialMotionId, session?.ownerId]);

    useEffect(() => {
      setMotionTimeMs(0);
      setMotionPlaying(false);
    }, [motion?.motion.id]);

    useEffect(() => {
      if (!motionPlaying || !motion || motionDurationMs <= 0) return undefined;
      const policy: MotionPolicy = {
        repeat: 'loop',
        rate: 1,
        clock: 'unscaled-presentation',
        initialMarker: null,
      };
      let frame = 0;
      let previous = performance.now();
      const tick = (now: number) => {
        const delta = Math.max(0, now - previous);
        previous = now;
        setMotionTimeMs((current) => advanceAnimationTime(motion.motion, policy, current, delta));
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }, [motion, motionDurationMs, motionPlaying]);

    useEffect(() => {
      let cancelled = false;
      setImageUrl(null);
      if (!projectSessionId || !displayAssetId || assetData?.kind !== 'image') return undefined;
      void window.noveltea
        .resolveProjectOriginalAssetUrl(projectSessionId, displayAssetId)
        .then((result) => {
          if (!cancelled) setImageUrl(result.ok ? result.url : null);
        })
        .catch(() => {
          if (!cancelled) setImageUrl(null);
        });
      return () => {
        cancelled = true;
      };
    }, [assetData?.kind, assetData?.source.path, displayAssetId, projectSessionId]);

    useEffect(() => onImageUrlChange?.(imageUrl), [imageUrl, onImageUrlChange]);

    useEffect(() => {
      let cancelled = false;
      setAlphaCoverage(null);
      if (session?.mode !== 'visual-alpha' || !imageUrl || !imageSize) return undefined;
      const image = new Image();
      image.onload = () => {
        if (cancelled) return;
        const canvas = document.createElement('canvas');
        canvas.width = imageSize.width;
        canvas.height = imageSize.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        context.drawImage(image, 0, 0, imageSize.width, imageSize.height);
        const source = context.getImageData(0, 0, imageSize.width, imageSize.height);
        const coverage = context.createImageData(imageSize.width, imageSize.height);
        for (let index = 0; index < source.data.length; index += 4) {
          const alpha = source.data[index + 3] ?? 0;
          coverage.data[index] = 255;
          coverage.data[index + 1] = 255;
          coverage.data[index + 2] = 255;
          coverage.data[index + 3] = alpha;
        }
        if (!cancelled) setAlphaCoverage(coverage);
      };
      image.onerror = () => {
        if (!cancelled) setAlphaCoverage(null);
      };
      image.src = imageUrl;
      return () => {
        cancelled = true;
      };
    }, [imageSize, imageUrl, session?.mode]);

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

    const getImagePresentation = useCallback((): FocusTransitionImagePresentation | null => {
      if (!imageUrl || !imageSize) return null;
      const imageLayer = workspaceRef.current?.querySelector<HTMLElement>('[data-image-layer]');
      if (!imageLayer) return null;
      const bounds = imageLayer.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      return {
        rect: {
          x: bounds.left,
          y: bounds.top,
          width: bounds.width,
          height: bounds.height,
        },
        rotationDegrees: 0,
      };
    }, [imageSize, imageUrl]);

    useImperativeHandle(ref, () => ({ getImagePresentation }), [getImagePresentation]);

    useLayoutEffect(() => {
      if (!onImagePresentationChange) return;
      const stageViewport = workspaceRef.current?.querySelector<HTMLElement>(
        '[data-hotspot-image-stage] > div[tabindex]',
      );
      if (!stageViewport || !imageUrl || !imageSize || !imageRect) {
        onImagePresentationChange(null);
        return;
      }
      const bounds = stageViewport.getBoundingClientRect();
      onImagePresentationChange({
        rect: {
          x: bounds.left + imageRect.x,
          y: bounds.top + imageRect.y,
          width: imageRect.width,
          height: imageRect.height,
        },
        rotationDegrees: 0,
      });
    }, [imageRect, imageSize, imageUrl, onImagePresentationChange]);

    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        const undoShortcut = key === 'z' && !event.shiftKey;
        const redoShortcut = key === 'y' || (key === 'z' && event.shiftKey);
        if (!undoShortcut && !redoShortcut) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('[data-terminal-panel]')) return;
        if (isTextEntryKeyboardTarget(event.target)) return;
        const workbench = useWorkbenchStore.getState();
        const activeTabId = workbench.groupsById[workbench.activeGroupId]?.activeTabId;
        if (activeTabId !== tabId || !useHotspotFocusStore.getState().sessionsByTabId[tabId])
          return;

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
    const sampledHotspots = hotspots.flatMap((item) => {
      if (!item.shape) return [{ id: item.id, label: item.label, inputOrder: item.inputOrder }];
      const bounds = motion
        ? sampleHotspotMotionTrack(
            item.shape.bounds,
            item.shape.motionTracks,
            motion.motion.id,
            motionTimeMs,
          )
        : item.shape.bounds;
      return bounds
        ? [{ id: item.id, label: item.label, inputOrder: item.inputOrder, bounds }]
        : [];
    });
    const requestClose = (action: () => boolean) => {
      if (onRequestClose) onRequestClose(action);
      else action();
    };
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
      <div
        ref={workspaceRef}
        className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background"
        data-hotspot-focus=""
        tabIndex={-1}
      >
        <div
          className="relative z-20 flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2"
          data-testid="hotspot-focus-toolbar"
        >
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
          {motion && canDraw ? (
            <div className="flex basis-full items-center gap-2 border-t pt-2 text-xs">
              <Select
                items={motion.animation.motions.map((candidate) => ({
                  value: candidate.id,
                  label: candidate.id,
                }))}
                value={motion.motion.id}
                onValueChange={(value) => {
                  if (value) setSelectedMotionId(value);
                }}
              >
                <SelectTrigger className="w-36" aria-label={t('hotspots.focus.motion')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {motion.animation.motions.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setMotionPlaying((value) => !value)}
              >
                {motionPlaying ? t('hotspots.focus.pause') : t('hotspots.focus.play')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!spriteMotion || motionFrameIndex === 0}
                onClick={() =>
                  spriteMotion &&
                  setMotionTimeMs(animationFrameTime(spriteMotion, motionFrameIndex - 1))
                }
              >
                {t('hotspots.focus.previousFrame')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!spriteMotion || motionFrameIndex >= spriteMotion.frames.length - 1}
                onClick={() =>
                  spriteMotion &&
                  setMotionTimeMs(animationFrameTime(spriteMotion, motionFrameIndex + 1))
                }
              >
                {t('hotspots.focus.nextFrame')}
              </Button>
              <input
                className="min-w-24 flex-1"
                type="range"
                min={0}
                max={motionDurationMs}
                step={1}
                value={Math.min(motionTimeMs, motionDurationMs)}
                aria-label={t('hotspots.focus.timeline')}
                onChange={(event) => {
                  setMotionPlaying(false);
                  setMotionTimeMs(Number(event.currentTarget.value));
                }}
              />
              <span className="tabular-nums">
                {Math.round(motionTimeMs)} / {motionDurationMs} ms
              </span>
              <Button
                type="button"
                size="sm"
                variant={motionInterpolation === 'hold' ? 'default' : 'outline'}
                onClick={() => setMotionInterpolation('hold')}
              >
                {t('hotspots.focus.hold')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={motionInterpolation === 'linear' ? 'default' : 'outline'}
                onClick={() => setMotionInterpolation('linear')}
              >
                {t('hotspots.focus.linear')}
              </Button>
              {session.selectedHotspotId ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const selected = hotspots.find(
                        (item) => item.id === session.selectedHotspotId,
                      );
                      if (!selected?.shape) return;
                      const bounds =
                        sampleHotspotMotionTrack(
                          selected.shape.bounds,
                          selected.shape.motionTracks,
                          motion.motion.id,
                          motionTimeMs,
                        ) ?? selected.shape.bounds;
                      setMotionKeyframe(
                        tabId,
                        selected.id,
                        motion.motion.id,
                        Math.round(motionTimeMs),
                        bounds,
                        true,
                        motionInterpolation,
                      );
                    }}
                  >
                    {t('hotspots.focus.keyGeometry')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const selected = hotspots.find(
                        (item) => item.id === session.selectedHotspotId,
                      );
                      if (!selected?.shape) return;
                      const bounds =
                        sampleHotspotMotionTrack(
                          selected.shape.bounds,
                          selected.shape.motionTracks,
                          motion.motion.id,
                          motionTimeMs,
                        ) ?? selected.shape.bounds;
                      setMotionKeyframe(
                        tabId,
                        selected.id,
                        motion.motion.id,
                        Math.round(motionTimeMs),
                        bounds,
                        false,
                        motionInterpolation,
                      );
                    }}
                  >
                    {t('hotspots.focus.inactive')}
                  </Button>
                </>
              ) : null}
              <div className="flex gap-1">
                {[
                  { id: 'start', timeMs: 0 },
                  ...motion.motion.markers,
                  { id: 'end', timeMs: motionDurationMs },
                ].map((marker) => (
                  <Button
                    key={marker.id}
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setMotionTimeMs(marker.timeMs)}
                  >
                    {marker.id}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
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
          {canDraw ? (
            <Button
              type="button"
              size="sm"
              variant={session.snapToPixels ? 'default' : 'outline'}
              aria-pressed={session.snapToPixels}
              title={t('hotspots.focus.pixelSnapHelp')}
              onClick={() => setSnapToPixels(tabId, !session.snapToPixels)}
            >
              {t('hotspots.focus.pixelSnap')}
            </Button>
          ) : null}
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
            onClick={() => requestClose(() => discard(tabId))}
          >
            {t('hotspots.focus.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              const selectedHotspotId = session.selectedHotspotId;
              requestClose(() => {
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
          <div className="relative z-10 min-h-0 flex-1 overflow-visible">
            <HotspotImageStage
              className="h-full min-h-0"
              imageUrl={imageUrl}
              imageSize={imageSize}
              zoomBasis="native"
              hotspots={sampledHotspots}
              selectedHotspotId={session.selectedHotspotId}
              tool={session.tool}
              camera={session.camera}
              alphaVisualization={session.mode === 'visual-alpha'}
              alphaCoverage={alphaCoverage}
              snapToImagePixels={session.snapToPixels}
              onViewportChange={setViewport}
              onImageRectChange={setImageRect}
              onSelectionChange={(selectedHotspotId) => setSelection(tabId, selectedHotspotId)}
              onCameraChange={(camera) => setCamera(tabId, camera)}
              onCreate={(bounds) => {
                if (!canDraw) return;
                add(tabId, createHotspot(nextId(), nextInputOrder(), bounds));
              }}
              onCancelCreate={() => setTool(tabId, 'select')}
              onCommitBounds={(id, bounds) => {
                if (motion)
                  setMotionKeyframe(
                    tabId,
                    id,
                    motion.motion.id,
                    Math.round(motionTimeMs),
                    bounds,
                    true,
                    motionInterpolation,
                  );
                else setBounds(tabId, id, bounds);
              }}
              onDelete={(id) => remove(tabId, id)}
              captureWindowKeyboard={activeFocusTab}
              keyboardDeleteEnabled={canDraw}
              deferSpatialLayersUntilImageReady
            />
          </div>
        )}
      </div>
    );
  },
);
