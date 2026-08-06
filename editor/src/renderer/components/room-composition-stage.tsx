import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { RoomNormalizedRect } from '../../shared/project-schema/authoring-rooms';

export interface RoomCompositionItem {
  id: string;
  label: string;
  bounds: RoomNormalizedRect;
  occupants: readonly string[];
}

export interface RoomCompositionStageProps {
  backgroundUrl: string | null;
  backgroundFit: 'cover' | 'contain' | 'stretch' | 'center';
  fallbackColor: string | null;
  referenceResolution: { width: number; height: number };
  items: readonly RoomCompositionItem[];
  selectedId: string | null;
  placementDraftLabel?: string | null;
  onSelectionChange: (id: string | null) => void;
  onCommitBounds: (id: string, bounds: RoomNormalizedRect) => void;
  onCommitPlacement?: (bounds: RoomNormalizedRect) => void;
  onCancelPlacement?: () => void;
}

type Gesture = {
  id: string | null;
  kind: 'move' | 'resize' | 'place';
  pointerId: number;
  startX: number;
  startY: number;
  initial: RoomNormalizedRect;
  draft: RoomNormalizedRect;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const defaultPlacementSize = { width: 0.2, height: 0.2 } as const;
const minimumPlacementDragPixels = 4;

function defaultPlacementAt(x: number, y: number): RoomNormalizedRect {
  return {
    x: clamp(x - defaultPlacementSize.width / 2, 0, 1 - defaultPlacementSize.width),
    y: clamp(y - defaultPlacementSize.height / 2, 0, 1 - defaultPlacementSize.height),
    ...defaultPlacementSize,
  };
}

export function RoomCompositionStage(props: RoomCompositionStageProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const callbacksRef = useRef({
    onCommitBounds: props.onCommitBounds,
    onCommitPlacement: props.onCommitPlacement,
  });
  callbacksRef.current = {
    onCommitBounds: props.onCommitBounds,
    onCommitPlacement: props.onCommitPlacement,
  };
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const setGesture = (next: Gesture | null) => {
    gestureRef.current = next;
    setGestureState(next);
  };
  const boundsFor = (item: RoomCompositionItem) =>
    gesture?.id === item.id ? gesture.draft : item.bounds;
  const point = (clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    return rect
      ? {
          x: clamp((clientX - rect.left) / rect.width, 0, 1),
          y: clamp((clientY - rect.top) / rect.height, 0, 1),
        }
      : { x: 0, y: 0 };
  };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = gestureRef.current;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      const current = point(event.clientX, event.clientY);
      const dx = current.x - active.startX;
      const dy = current.y - active.startY;
      const draft =
        active.kind === 'move'
          ? {
              ...active.initial,
              x: clamp(active.initial.x + dx, 0, 1 - active.initial.width),
              y: clamp(active.initial.y + dy, 0, 1 - active.initial.height),
            }
          : active.kind === 'resize'
            ? {
                ...active.initial,
                width: clamp(active.initial.width + dx, 0.01, 1 - active.initial.x),
                height: clamp(active.initial.height + dy, 0.01, 1 - active.initial.y),
              }
            : {
                x: Math.min(active.startX, current.x),
                y: Math.min(active.startY, current.y),
                width: Math.abs(current.x - active.startX),
                height: Math.abs(current.y - active.startY),
              };
      setGesture({ ...active, draft });
    };
    const finish = (event: PointerEvent) => {
      const active = gestureRef.current;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      if (active.kind === 'place') {
        const rect = rootRef.current?.getBoundingClientRect();
        const draggedFarEnough = rect
          ? Math.abs(active.draft.width * rect.width) >= minimumPlacementDragPixels &&
            Math.abs(active.draft.height * rect.height) >= minimumPlacementDragPixels
          : false;
        callbacksRef.current.onCommitPlacement?.(draggedFarEnough ? active.draft : active.initial);
      } else if (active.id) callbacksRef.current.onCommitBounds(active.id, active.draft);
      setGesture(null);
    };
    const cancel = (event: PointerEvent) => {
      if (gestureRef.current?.pointerId !== event.pointerId) return;
      setGesture(null);
    };
    const cancelOnBlur = () => setGesture(null);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish, { passive: false });
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancelOnBlur);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancelOnBlur);
    };
  }, []);
  const begin = (event: ReactPointerEvent, item: RoomCompositionItem, kind: Gesture['kind']) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    props.onSelectionChange(item.id);
    const current = point(event.clientX, event.clientY);
    setGesture({
      id: item.id,
      kind,
      pointerId: event.pointerId,
      startX: current.x,
      startY: current.y,
      initial: item.bounds,
      draft: item.bounds,
    });
  };
  const beginPlacement = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!props.placementDraftLabel || !props.onCommitPlacement) {
      props.onSelectionChange(null);
      return;
    }
    event.preventDefault();
    const current = point(event.clientX, event.clientY);
    setGesture({
      id: null,
      kind: 'place',
      pointerId: event.pointerId,
      startX: current.x,
      startY: current.y,
      initial: defaultPlacementAt(current.x, current.y),
      draft: defaultPlacementAt(current.x, current.y),
    });
  };
  const objectFit =
    props.backgroundFit === 'stretch'
      ? 'fill'
      : props.backgroundFit === 'center'
        ? 'scale-down'
        : props.backgroundFit;
  return (
    <div
      ref={rootRef}
      className={`relative w-full touch-none select-none overflow-hidden rounded-lg border bg-muted/30 ${props.placementDraftLabel ? 'cursor-crosshair' : ''}`}
      style={{
        aspectRatio: `${props.referenceResolution.width} / ${props.referenceResolution.height}`,
        backgroundColor: props.fallbackColor ?? undefined,
      }}
      tabIndex={0}
      onPointerDown={beginPlacement}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        setGesture(null);
        props.onCancelPlacement?.();
      }}
      data-testid="room-composition-stage"
    >
      {props.backgroundUrl ? (
        <img
          src={props.backgroundUrl}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 size-full select-none"
          style={{ objectFit, objectPosition: 'center' }}
        />
      ) : null}
      {props.items.map((item) => {
        const bounds = boundsFor(item);
        const selected = item.id === props.selectedId;
        return (
          <div
            key={item.id}
            className={`absolute cursor-move border-2 bg-background/25 shadow-sm ${selected ? 'border-primary' : 'border-foreground/60'}`}
            style={{
              left: `${bounds.x * 100}%`,
              top: `${bounds.y * 100}%`,
              width: `${bounds.width * 100}%`,
              height: `${bounds.height * 100}%`,
            }}
            onPointerDown={(event) => begin(event, item, 'move')}
            data-testid={`room-placement-${item.id}`}
          >
            <div className="pointer-events-none truncate bg-background/80 px-1 py-0.5 text-[10px] font-medium">
              {item.label}
              {item.occupants.length ? ` · ${item.occupants.join(', ')}` : ''}
            </div>
            {selected ? (
              <button
                type="button"
                aria-label={`Resize ${item.label}`}
                className="absolute -bottom-2 -right-2 size-4 cursor-se-resize rounded-sm border bg-background"
                onPointerDown={(event) => begin(event, item, 'resize')}
              />
            ) : null}
          </div>
        );
      })}
      {gesture?.kind === 'place' ? (
        <div
          className="pointer-events-none absolute border-2 border-dashed border-primary bg-primary/10"
          style={{
            left: `${gesture.draft.x * 100}%`,
            top: `${gesture.draft.y * 100}%`,
            width: `${gesture.draft.width * 100}%`,
            height: `${gesture.draft.height * 100}%`,
          }}
          data-testid="room-placement-draft"
        >
          <div className="truncate bg-background/80 px-1 py-0.5 text-[10px] font-medium">
            {props.placementDraftLabel}
          </div>
        </div>
      ) : null}
    </div>
  );
}
