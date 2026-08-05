import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { ImageNormalizedRect } from '../../../shared/project-schema/authoring-hotspots';
import {
  imageRectToStage,
  imageStageRect,
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

export interface HotspotStageItem {
  id: string;
  label: string;
  bounds: ImageNormalizedRect;
}

export interface HotspotImageStageProps {
  imageUrl?: string | null;
  imageSize: StageSize;
  hotspots: readonly HotspotStageItem[];
  selectedHotspotId: string | null;
  tool: HotspotTool;
  camera: ImageStageCamera;
  alphaVisualization?: boolean;
  alphaCoverage?: ImageData | null;
  placedObjectLayer?: ReactNode;
  className?: string;
  onSelectionChange(id: string | null): void;
  onCameraChange(camera: ImageStageCamera): void;
  onCreate(bounds: ImageNormalizedRect): void;
  onCommitBounds(id: string, bounds: ImageNormalizedRect): void;
  onDelete(id: string): void;
}

type Gesture =
  | { kind: 'draw'; pointerId: number; start: StagePoint; current: StagePoint }
  | {
      kind: 'move';
      pointerId: number;
      id: string;
      start: StagePoint;
      initial: ImageNormalizedRect;
      draft: ImageNormalizedRect;
    }
  | {
      kind: 'resize';
      pointerId: number;
      id: string;
      handle: ResizeHandle;
      start: StagePoint;
      initial: ImageNormalizedRect;
      draft: ImageNormalizedRect;
    }
  | { kind: 'pan'; pointerId: number; start: StagePoint; initial: StagePoint; draft: StagePoint };

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

export function HotspotImageStage(props: HotspotImageStageProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<StageSize>({ width: 0, height: 0 });
  const [gesture, setGesture] = useState<Gesture | null>(null);
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const cameraPan = gesture?.kind === 'pan' ? gesture.draft : props.camera.pan;
  const imageRect = imageStageRect(viewport, props.imageSize, {
    zoom: props.camera.zoom,
    pan: cameraPan,
  });
  const point = (event: ReactPointerEvent): StagePoint => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };
  const uvPoint = (event: ReactPointerEvent) => stageToImageUv(point(event), imageRect);
  const capture = (event: ReactPointerEvent) =>
    event.currentTarget.setPointerCapture?.(event.pointerId);

  const startBackgroundGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const start = point(event);
    if (props.tool === 'draw-rect') {
      capture(event);
      setGesture({
        kind: 'draw',
        pointerId: event.pointerId,
        start: uvPoint(event),
        current: uvPoint(event),
      });
      return;
    }
    if (props.tool === 'pan' || event.shiftKey) {
      capture(event);
      setGesture({
        kind: 'pan',
        pointerId: event.pointerId,
        start,
        initial: props.camera.pan,
        draft: props.camera.pan,
      });
      return;
    }
    props.onSelectionChange(null);
  };

  const updateGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === 'draw') {
      setGesture({ ...gesture, current: uvPoint(event) });
      return;
    }
    const current = point(event);
    if (gesture.kind === 'pan') {
      setGesture({
        ...gesture,
        draft: {
          x: gesture.initial.x + current.x - gesture.start.x,
          y: gesture.initial.y + current.y - gesture.start.y,
        },
      });
      return;
    }
    const startUv = stageToImageUv(gesture.start, imageRect);
    const currentUv = stageToImageUv(current, imageRect);
    const delta = { x: currentUv.x - startUv.x, y: currentUv.y - startUv.y };
    const draft =
      gesture.kind === 'move'
        ? moveNormalizedRect(gesture.initial, delta)
        : resizeNormalizedRect(gesture.initial, gesture.handle, delta, {
            x: Math.min(1, 4 / Math.max(1, imageRect.width)),
            y: Math.min(1, 4 / Math.max(1, imageRect.height)),
          });
    setGesture({ ...gesture, draft });
  };

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === 'draw') {
      const bounds = normalizedRectFromPoints(gesture.start, gesture.current);
      if (bounds.width * imageRect.width >= 4 && bounds.height * imageRect.height >= 4)
        props.onCreate(bounds);
    } else if (gesture.kind === 'pan') {
      props.onCameraChange({ ...props.camera, pan: gesture.draft });
    } else if (
      gesture.draft.x !== gesture.initial.x ||
      gesture.draft.y !== gesture.initial.y ||
      gesture.draft.width !== gesture.initial.width ||
      gesture.draft.height !== gesture.initial.height
    ) {
      props.onCommitBounds(gesture.id, gesture.draft);
    }
    setGesture(null);
  };

  const wheel = (event: React.WheelEvent) => {
    event.preventDefault();
    const nextZoom = Math.min(
      16,
      Math.max(0.1, props.camera.zoom * Math.exp(-event.deltaY * 0.001)),
    );
    props.onCameraChange({ ...props.camera, zoom: nextZoom });
  };

  const draftBounds = (item: HotspotStageItem) =>
    gesture && (gesture.kind === 'move' || gesture.kind === 'resize') && gesture.id === item.id
      ? gesture.draft
      : item.bounds;

  return (
    <div className={`flex min-h-0 ${props.className ?? ''}`} data-hotspot-image-stage="">
      <div
        ref={rootRef}
        className="relative min-h-64 flex-1 touch-none overflow-hidden rounded border bg-muted/30 outline-none"
        tabIndex={0}
        onPointerDown={startBackgroundGesture}
        onPointerMove={updateGesture}
        onPointerUp={finishGesture}
        onPointerCancel={() => setGesture(null)}
        onWheel={wheel}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && gesture) {
            event.preventDefault();
            setGesture(null);
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
        <svg className="absolute inset-0 size-full overflow-visible" data-geometry-layer="">
          {props.hotspots.map((item) => {
            const bounds = draftBounds(item);
            const rect = imageRectToStage(bounds, imageRect);
            const selected = item.id === props.selectedHotspotId;
            return (
              <g
                key={item.id}
                role="button"
                aria-label={item.label}
                data-hotspot-id={item.id}
                data-selected={selected ? 'true' : 'false'}
                onPointerDown={(event) => {
                  if (props.tool !== 'select' || event.button !== 0) return;
                  event.stopPropagation();
                  props.onSelectionChange(item.id);
                  capture(event);
                  setGesture({
                    kind: 'move',
                    pointerId: event.pointerId,
                    id: item.id,
                    start: point(event),
                    initial: item.bounds,
                    draft: item.bounds,
                  });
                }}
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
                {selected
                  ? handles.map((handle) => (
                      <rect
                        key={handle}
                        data-resize-handle={handle}
                        x={
                          rect.x +
                          (Number.parseFloat(handlePosition[handle].left) / 100) * rect.width -
                          4
                        }
                        y={
                          rect.y +
                          (Number.parseFloat(handlePosition[handle].top) / 100) * rect.height -
                          4
                        }
                        width={8}
                        height={8}
                        className="fill-background stroke-foreground"
                        onPointerDown={(event) => {
                          if (props.tool !== 'select' || event.button !== 0) return;
                          event.stopPropagation();
                          capture(event);
                          setGesture({
                            kind: 'resize',
                            pointerId: event.pointerId,
                            id: item.id,
                            handle,
                            start: point(event),
                            initial: item.bounds,
                            draft: item.bounds,
                          });
                        }}
                      />
                    ))
                  : null}
              </g>
            );
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
              className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-muted"
              data-selected={item.id === props.selectedHotspotId ? 'true' : 'false'}
              onClick={() => props.onSelectionChange(item.id)}
            >
              {item.label}
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
