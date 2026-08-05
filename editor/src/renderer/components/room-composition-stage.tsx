import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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
  items: readonly RoomCompositionItem[];
  selectedId: string | null;
  onSelectionChange(id: string | null): void;
  onCommitBounds(id: string, bounds: RoomNormalizedRect): void;
}

type Gesture = {
  id: string;
  kind: 'move' | 'resize';
  pointerId: number;
  startX: number;
  startY: number;
  initial: RoomNormalizedRect;
  draft: RoomNormalizedRect;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function RoomCompositionStage(props: RoomCompositionStageProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const boundsFor = (item: RoomCompositionItem) =>
    gesture?.id === item.id ? gesture.draft : item.bounds;
  const point = (event: ReactPointerEvent) => {
    const rect = rootRef.current?.getBoundingClientRect();
    return rect
      ? { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
      : { x: 0, y: 0 };
  };
  const begin = (event: ReactPointerEvent, item: RoomCompositionItem, kind: Gesture['kind']) => {
    event.stopPropagation();
    props.onSelectionChange(item.id);
    const current = point(event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
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
  const move = (event: ReactPointerEvent) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const current = point(event);
    const dx = current.x - gesture.startX;
    const dy = current.y - gesture.startY;
    const draft =
      gesture.kind === 'move'
        ? {
            ...gesture.initial,
            x: clamp(gesture.initial.x + dx, 0, 1 - gesture.initial.width),
            y: clamp(gesture.initial.y + dy, 0, 1 - gesture.initial.height),
          }
        : {
            ...gesture.initial,
            width: clamp(gesture.initial.width + dx, 0.01, 1 - gesture.initial.x),
            height: clamp(gesture.initial.height + dy, 0.01, 1 - gesture.initial.y),
          };
    setGesture({ ...gesture, draft });
  };
  const finish = (event: ReactPointerEvent) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    props.onCommitBounds(gesture.id, gesture.draft);
    setGesture(null);
  };
  const objectFit =
    props.backgroundFit === 'stretch'
      ? 'fill'
      : props.backgroundFit === 'center'
        ? 'none'
        : props.backgroundFit;
  return (
    <div
      ref={rootRef}
      className="relative aspect-video min-h-64 overflow-hidden rounded-lg border bg-muted/30"
      style={{ backgroundColor: props.fallbackColor ?? undefined }}
      onPointerDown={() => props.onSelectionChange(null)}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={() => setGesture(null)}
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
                className="absolute -bottom-1.5 -right-1.5 size-3 cursor-se-resize rounded-sm border bg-background"
                onPointerDown={(event) => begin(event, item, 'resize')}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
