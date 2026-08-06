import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { ImageNormalizedRect } from '../../../shared/project-schema/authoring-hotspots';
import {
  clampImageStageCamera,
  imageRectToStage,
  imageStageRect,
  imageUvToStage,
  moveNormalizedRect,
  normalizedRectFromPoints,
  resizeNormalizedRect,
  stageToImageUv,
  type ImageStageCamera,
  type ResizeHandle,
  type StagePoint,
  type StageSize,
} from './image-stage-transforms';
import type { HotspotTool } from './hotspot-view-state';

interface HotspotStageItemBase {
  id: string;
  label: string;
  inputOrder?: number;
}

export type HotspotStageGeometry =
  | { kind: 'rect'; bounds: ImageNormalizedRect }
  | { kind: 'polygon'; vertices: readonly StagePoint[] };

export type HotspotStageItem = HotspotStageItemBase &
  (
    | { bounds: ImageNormalizedRect; geometry?: never }
    | { bounds?: never; geometry: HotspotStageGeometry }
  );

export const HOTSPOT_STAGE_GEOMETRY_CAPABILITIES = {
  display: ['rect', 'polygon'],
  edit: ['rect'],
} as const;

export interface HotspotImageStageProps {
  imageUrl?: string | null;
  imageSize: StageSize;
  hotspots: readonly HotspotStageItem[];
  selectedHotspotId: string | null;
  tool: HotspotTool;
  camera: ImageStageCamera;
  alphaVisualization?: boolean;
  alphaCoverage?: ImageData | null;
  visibleImageGuide?: ImageNormalizedRect | null;
  placedObjectLayer?: ReactNode;
  className?: string;
  onSelectionChange: (id: string | null) => void;
  onCameraChange: (camera: ImageStageCamera) => void;
  onCreate: (bounds: ImageNormalizedRect) => void;
  onCancelCreate?: () => void;
  onCommitBounds: (id: string, bounds: ImageNormalizedRect) => void;
  onDelete: (id: string) => void;
}

type Gesture =
  | { kind: 'draw'; start: StagePoint; current: StagePoint }
  | {
      kind: 'move';
      id: string;
      start: StagePoint;
      initial: ImageNormalizedRect;
      draft: ImageNormalizedRect;
    }
  | {
      kind: 'resize';
      id: string;
      handle: ResizeHandle;
      start: StagePoint;
      initial: ImageNormalizedRect;
      draft: ImageNormalizedRect;
    }
  | {
      kind: 'pan';
      start: StagePoint;
      initial: StagePoint;
      draft: StagePoint;
      moved: boolean;
    };

const handles: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const handlePosition: Record<ResizeHandle, { left: string; top: string }> = {
  nw: { left: '0%', top: '0%' },
  n: { left: '50%', top: '0%' },
  ne: { left: '100%', top: '0%' },
  e: { left: '100%', top: '50%' },
  se: { left: '100%', top: '100%' },
  s: { left: '50%', top: '100%' },
  sw: { left: '0%', top: '100%' },
  w: { left: '0%', top: '50%' },
};
const handleCursor: Record<ResizeHandle, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
};
const resizeHandleVisualSize = 8;
const resizeHandleHitSize = 20;
const minimumPanDistancePixels = 3;

function pointInElement(element: HTMLElement | null, clientX: number, clientY: number): StagePoint {
  const rect = element?.getBoundingClientRect();
  return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
}

export function HotspotImageStage(props: HotspotImageStageProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [viewport, setViewport] = useState<StageSize>({ width: 0, height: 0 });
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const setGesture = (next: Gesture | null) => {
    gestureRef.current = next;
    setGestureState(next);
  };
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const restoredCamera = clampImageStageCamera(viewport, props.imageSize, props.camera);
  useEffect(() => {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    if (
      restoredCamera.zoom !== props.camera.zoom ||
      restoredCamera.pan.x !== props.camera.pan.x ||
      restoredCamera.pan.y !== props.camera.pan.y
    )
      props.onCameraChange(restoredCamera);
  }, [props, restoredCamera, viewport]);
  const cameraPan =
    gesture?.kind === 'pan'
      ? clampImageStageCamera(viewport, props.imageSize, {
          zoom: restoredCamera.zoom,
          pan: gesture.draft,
        }).pan
      : restoredCamera.pan;
  const imageRect = imageStageRect(viewport, props.imageSize, {
    zoom: restoredCamera.zoom,
    pan: cameraPan,
  });
  const stageStateRef = useRef({
    viewport,
    imageSize: props.imageSize,
    restoredCamera,
    imageRect,
    onSelectionChange: props.onSelectionChange,
    onCameraChange: props.onCameraChange,
    onCreate: props.onCreate,
    onCommitBounds: props.onCommitBounds,
  });
  stageStateRef.current = {
    viewport,
    imageSize: props.imageSize,
    restoredCamera,
    imageRect,
    onSelectionChange: props.onSelectionChange,
    onCameraChange: props.onCameraChange,
    onCreate: props.onCreate,
    onCommitBounds: props.onCommitBounds,
  };

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const active = gestureRef.current;
      if (!active) return;
      event.preventDefault();
      const state = stageStateRef.current;
      const current = pointInElement(rootRef.current, event.clientX, event.clientY);
      if (active.kind === 'draw') {
        setGesture({ ...active, current: stageToImageUv(current, state.imageRect) });
        return;
      }
      if (active.kind === 'pan') {
        const delta = { x: current.x - active.start.x, y: current.y - active.start.y };
        const next = clampImageStageCamera(state.viewport, state.imageSize, {
          zoom: state.restoredCamera.zoom,
          pan: {
            x: active.initial.x + delta.x,
            y: active.initial.y + delta.y,
          },
        });
        setGesture({
          ...active,
          draft: next.pan,
          moved: active.moved || Math.hypot(delta.x, delta.y) >= minimumPanDistancePixels,
        });
        return;
      }
      const startUv = stageToImageUv(active.start, state.imageRect);
      const currentUv = stageToImageUv(current, state.imageRect);
      const delta = { x: currentUv.x - startUv.x, y: currentUv.y - startUv.y };
      const draft =
        active.kind === 'move'
          ? moveNormalizedRect(active.initial, delta)
          : resizeNormalizedRect(active.initial, active.handle, delta, {
              x: Math.min(1, 4 / Math.max(1, state.imageRect.width)),
              y: Math.min(1, 4 / Math.max(1, state.imageRect.height)),
            });
      setGesture({ ...active, draft });
    };
    const finish = (event: MouseEvent) => {
      const active = gestureRef.current;
      if (!active) return;
      event.preventDefault();
      const state = stageStateRef.current;
      if (active.kind === 'draw') {
        const bounds = normalizedRectFromPoints(active.start, active.current);
        if (
          bounds.width * state.imageRect.width >= 4 &&
          bounds.height * state.imageRect.height >= 4
        )
          state.onCreate(bounds);
      } else if (active.kind === 'pan') {
        if (active.moved)
          state.onCameraChange({ zoom: state.restoredCamera.zoom, pan: active.draft });
        else state.onSelectionChange(null);
      } else if (
        active.draft.x !== active.initial.x ||
        active.draft.y !== active.initial.y ||
        active.draft.width !== active.initial.width ||
        active.draft.height !== active.initial.height
      ) {
        state.onCommitBounds(active.id, active.draft);
      }
      setGesture(null);
    };
    const cancel = () => setGesture(null);
    window.addEventListener('mousemove', move, { passive: false });
    window.addEventListener('mouseup', finish, { passive: false });
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', finish);
      window.removeEventListener('blur', cancel);
    };
  }, []);

  const startBackgroundGesture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    const start = pointInElement(rootRef.current, event.clientX, event.clientY);
    if (props.tool === 'draw-rect') {
      setGesture({
        kind: 'draw',
        start: stageToImageUv(start, imageRect),
        current: stageToImageUv(start, imageRect),
      });
      return;
    }
    setGesture({
      kind: 'pan',
      start,
      initial: restoredCamera.pan,
      draft: restoredCamera.pan,
      moved: false,
    });
  };

  const wheelStateRef = useRef({
    zoom: props.camera.zoom,
    imageSize: props.imageSize,
    pan: restoredCamera.pan,
    viewport,
    onCameraChange: (camera: ImageStageCamera) => props.onCameraChange(camera),
  });
  wheelStateRef.current = {
    zoom: props.camera.zoom,
    imageSize: props.imageSize,
    pan: restoredCamera.pan,
    viewport,
    onCameraChange: (camera: ImageStageCamera) => props.onCameraChange(camera),
  };

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const state = wheelStateRef.current;
      const nextZoom = Math.min(16, Math.max(0.1, state.zoom * Math.exp(-event.deltaY * 0.001)));
      state.onCameraChange(
        clampImageStageCamera(state.viewport, state.imageSize, {
          zoom: nextZoom,
          pan: state.pan,
        }),
      );
    };

    // React's delegated wheel listener may be passive in Chromium. The stage owns
    // the gesture, so install an explicitly non-passive listener at its boundary.
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  const geometry = (item: HotspotStageItem): HotspotStageGeometry =>
    item.geometry ?? { kind: 'rect', bounds: item.bounds };
  const draftBounds = (item: HotspotStageItem, itemGeometry: HotspotStageGeometry) =>
    gesture && (gesture.kind === 'move' || gesture.kind === 'resize') && gesture.id === item.id
      ? gesture.draft
      : itemGeometry.kind === 'rect'
        ? itemGeometry.bounds
        : null;

  return (
    <div className={`flex min-h-0 ${props.className ?? ''}`} data-hotspot-image-stage="">
      <div
        ref={rootRef}
        className={`relative min-h-64 flex-1 touch-none overflow-hidden rounded border bg-muted/30 outline-none ${
          props.tool === 'draw-rect'
            ? 'cursor-crosshair'
            : gesture?.kind === 'pan'
              ? 'cursor-grabbing'
              : 'cursor-grab'
        }`}
        tabIndex={0}
        onMouseDown={startBackgroundGesture}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && (gesture || props.tool === 'draw-rect')) {
            event.preventDefault();
            setGesture(null);
            if (props.tool === 'draw-rect') props.onCancelCreate?.();
            return;
          }
          if ((event.key === 'Delete' || event.key === 'Backspace') && props.selectedHotspotId) {
            event.preventDefault();
            props.onDelete(props.selectedHotspotId);
          }
        }}
      >
        <div
          className="absolute overflow-hidden bg-black/10"
          data-image-layer=""
          style={{
            left: imageRect.x,
            top: imageRect.y,
            width: imageRect.width,
            height: imageRect.height,
          }}
        >
          {props.imageUrl ? (
            <img
              className="h-full w-full select-none object-fill"
              draggable={false}
              src={props.imageUrl}
            />
          ) : null}
          {props.alphaVisualization ? <AlphaCoverageCanvas coverage={props.alphaCoverage} /> : null}
        </div>
        <div className="pointer-events-none absolute inset-0" data-placed-object-layer="">
          {props.placedObjectLayer}
        </div>
        <svg
          className="pointer-events-none absolute inset-0 z-10 size-full overflow-visible"
          data-geometry-layer=""
        >
          {props.visibleImageGuide
            ? (() => {
                const guide = imageRectToStage(props.visibleImageGuide, imageRect);
                return (
                  <rect
                    x={guide.x}
                    y={guide.y}
                    width={guide.width}
                    height={guide.height}
                    className="fill-transparent stroke-foreground/70"
                    data-runtime-visible-area-guide=""
                    strokeWidth={2}
                    strokeDasharray="8 5"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })()
            : null}
          {props.hotspots.map((item) => {
            const itemGeometry = geometry(item);
            const selected = item.id === props.selectedHotspotId;
            const selectOnly = (event: ReactMouseEvent<SVGGElement>) => {
              if (props.tool === 'draw-rect' || event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              props.onSelectionChange(item.id);
            };
            if (itemGeometry.kind === 'polygon') {
              const points = itemGeometry.vertices
                .map((vertex) => imageUvToStage(vertex, imageRect))
                .map((vertex) => `${vertex.x},${vertex.y}`)
                .join(' ');
              return (
                <g
                  key={item.id}
                  role="button"
                  aria-label={item.label}
                  className="pointer-events-auto"
                  data-hotspot-id={item.id}
                  data-hotspot-geometry="polygon"
                  data-selected={selected ? 'true' : 'false'}
                  onMouseDown={selectOnly}
                >
                  <polygon
                    points={points}
                    className="fill-primary/15 stroke-primary"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                  {itemGeometry.vertices.map((vertex, index) => {
                    const stage = imageUvToStage(vertex, imageRect);
                    return (
                      <circle
                        key={index}
                        cx={stage.x}
                        cy={stage.y}
                        r={2}
                        className="pointer-events-none fill-primary"
                      />
                    );
                  })}
                </g>
              );
            }
            const bounds = draftBounds(item, itemGeometry) ?? itemGeometry.bounds;
            const rect = imageRectToStage(bounds, imageRect);
            const beginMove = (event: ReactMouseEvent<SVGGElement>) => {
              if (props.tool === 'draw-rect' || event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              props.onSelectionChange(item.id);
              setGesture({
                kind: 'move',
                id: item.id,
                start: pointInElement(rootRef.current, event.clientX, event.clientY),
                initial: bounds,
                draft: bounds,
              });
            };
            return (
              <g
                key={item.id}
                role="button"
                aria-label={item.label}
                className="pointer-events-auto"
                data-hotspot-id={item.id}
                data-hotspot-geometry="rect"
                data-selected={selected ? 'true' : 'false'}
                onMouseDown={beginMove}
              >
                <rect
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  className="fill-primary/15 stroke-primary"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={rect.x + 4}
                  y={rect.y + 12}
                  className="pointer-events-none fill-foreground text-[10px]"
                >
                  {item.label}
                </text>
              </g>
            );
          })}
        </svg>
        <svg
          className="pointer-events-none absolute inset-0 z-20 size-full overflow-visible"
          data-handles-feedback-layer=""
        >
          {props.hotspots.map((item) => {
            if (item.id !== props.selectedHotspotId) return null;
            const itemGeometry = geometry(item);
            const bounds = draftBounds(item, itemGeometry);
            if (!bounds) return null;
            const rect = imageRectToStage(bounds, imageRect);
            return handles.map((handle) => {
              const centerX =
                rect.x + (Number.parseFloat(handlePosition[handle].left) / 100) * rect.width;
              const centerY =
                rect.y + (Number.parseFloat(handlePosition[handle].top) / 100) * rect.height;
              return (
                <g key={`${item.id}-${handle}`}>
                  <rect
                    data-resize-handle={handle}
                    x={centerX - resizeHandleHitSize / 2}
                    y={centerY - resizeHandleHitSize / 2}
                    width={resizeHandleHitSize}
                    height={resizeHandleHitSize}
                    fill="transparent"
                    style={{ cursor: handleCursor[handle], pointerEvents: 'all' }}
                    onMouseDown={(event) => {
                      if (props.tool === 'draw-rect' || event.button !== 0) return;
                      event.preventDefault();
                      event.stopPropagation();
                      setGesture({
                        kind: 'resize',
                        id: item.id,
                        handle,
                        start: pointInElement(rootRef.current, event.clientX, event.clientY),
                        initial: bounds,
                        draft: bounds,
                      });
                    }}
                  />
                  <rect
                    data-resize-handle-visual={handle}
                    x={centerX - resizeHandleVisualSize / 2}
                    y={centerY - resizeHandleVisualSize / 2}
                    width={resizeHandleVisualSize}
                    height={resizeHandleVisualSize}
                    className="pointer-events-none fill-background stroke-foreground"
                  />
                </g>
              );
            });
          })}
          {gesture?.kind === 'draw'
            ? (() => {
                const rect = imageRectToStage(
                  normalizedRectFromPoints(gesture.start, gesture.current),
                  imageRect,
                );
                return (
                  <rect
                    className="pointer-events-none fill-primary/10 stroke-primary"
                    data-hotspot-draft="draw"
                    x={rect.x}
                    y={rect.y}
                    width={rect.width}
                    height={rect.height}
                    strokeWidth={2}
                    strokeDasharray="6 4"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })()
            : null}
        </svg>
      </div>
      <div className="w-48 shrink-0 overflow-auto border-l p-2" aria-label="Hotspots">
        {props.hotspots.length === 0 ? (
          <p className="text-xs text-muted-foreground">No hotspots.</p>
        ) : (
          props.hotspots.map((item) => (
            <button
              key={item.id}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
              data-selected={item.id === props.selectedHotspotId ? 'true' : 'false'}
              onClick={() => props.onSelectionChange(item.id)}
            >
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.inputOrder === undefined ? null : (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  Order {item.inputOrder}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function AlphaCoverageCanvas({ coverage }: { coverage?: ImageData | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !coverage) return;
    canvas.width = coverage.width;
    canvas.height = coverage.height;
    canvas.getContext('2d')?.putImageData(coverage, 0, 0);
  }, [coverage]);
  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 size-full opacity-50"
      data-alpha-visualization=""
    />
  );
}

export const ImageHotspotEditor = HotspotImageStage;
