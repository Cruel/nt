import type { RoomData } from './authoring-rooms';

export const roomPresentationPlaneValues = [
  'world-background',
  'world-content',
  'world-overlay',
] as const;

export type RoomPresentationPlane = (typeof roomPresentationPlaneValues)[number];

export type RoomPresentationOrderTarget =
  | { kind: 'cast'; id: string }
  | { kind: 'prop'; id: string }
  | { kind: 'interactable'; id: string }
  | { kind: 'environment'; id: string }
  | { kind: 'overlay'; id: string }
  | { kind: 'placement-layout'; id: string };

export type RoomPresentationReorderAction = 'forward' | 'backward' | 'front' | 'back';

export interface RoomPresentationOrderEntry {
  target: RoomPresentationOrderTarget;
  plane: RoomPresentationPlane;
  order: number;
  stableKey: string;
}

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const SPARSE_ORDER_STEP = 1024;

function targetKey(target: RoomPresentationOrderTarget): string {
  return `${target.kind}:${target.id}`;
}

export function roomPresentationOrderEntries(room: RoomData): RoomPresentationOrderEntry[] {
  return [
    ...room.cast.map((entry) => ({
      target: { kind: 'cast' as const, id: entry.id },
      plane: 'world-content' as const,
      order: entry.order,
      stableKey: `cast:${entry.id}`,
    })),
    ...room.props.map((entry) => ({
      target: { kind: 'prop' as const, id: entry.id },
      plane: 'world-content' as const,
      order: entry.order,
      stableKey: `prop:${entry.id}`,
    })),
    ...room.interactables.map((entry) => ({
      target: { kind: 'interactable' as const, id: entry.id },
      plane: 'world-content' as const,
      order: entry.order,
      stableKey: `interactable:${entry.id}`,
    })),
    ...room.environments.map((entry) => ({
      target: { kind: 'environment' as const, id: entry.id },
      plane: entry.plane,
      order: entry.order,
      stableKey: `environment:${entry.id}`,
    })),
    ...room.overlays.map((entry) => ({
      target: { kind: 'overlay' as const, id: entry.id },
      plane: 'world-overlay' as const,
      order: entry.order,
      stableKey: `overlay:${entry.id}`,
    })),
    ...room.placements.flatMap((entry) =>
      entry.presentation.layout
        ? [
            {
              target: { kind: 'placement-layout' as const, id: entry.id },
              plane: 'world-overlay' as const,
              order: entry.presentation.layoutOrder,
              stableKey: `placement-layout:${entry.id}`,
            },
          ]
        : [],
    ),
  ];
}

export function roomPresentationPlaneForTarget(
  room: RoomData,
  target: RoomPresentationOrderTarget,
): RoomPresentationPlane | null {
  return (
    roomPresentationOrderEntries(room).find(
      (entry) => targetKey(entry.target) === targetKey(target),
    )?.plane ?? null
  );
}

function orderedPlaneEntries(room: RoomData, plane: RoomPresentationPlane) {
  return roomPresentationOrderEntries(room)
    .filter((entry) => entry.plane === plane)
    .sort(
      (left, right) => left.order - right.order || left.stableKey.localeCompare(right.stableKey),
    );
}

function replaceOrder(
  room: RoomData,
  target: RoomPresentationOrderTarget,
  order: number,
): RoomData {
  switch (target.kind) {
    case 'cast':
      return {
        ...room,
        cast: room.cast.map((entry) => (entry.id === target.id ? { ...entry, order } : entry)),
      };
    case 'prop':
      return {
        ...room,
        props: room.props.map((entry) => (entry.id === target.id ? { ...entry, order } : entry)),
      };
    case 'interactable':
      return {
        ...room,
        interactables: room.interactables.map((entry) =>
          entry.id === target.id ? { ...entry, order } : entry,
        ),
      };
    case 'environment':
      return {
        ...room,
        environments: room.environments.map((entry) =>
          entry.id === target.id ? { ...entry, order } : entry,
        ),
      };
    case 'overlay':
      return {
        ...room,
        overlays: room.overlays.map((entry) =>
          entry.id === target.id ? { ...entry, order } : entry,
        ),
      };
    case 'placement-layout':
      return {
        ...room,
        placements: room.placements.map((entry) =>
          entry.id === target.id && entry.presentation.layout
            ? {
                ...entry,
                presentation: { ...entry.presentation, layoutOrder: order },
              }
            : entry,
        ),
      };
  }
}

function deterministicSparseOrders(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  if ((count - 1) * SPARSE_ORDER_STEP <= INT32_MAX)
    return Array.from({ length: count }, (_, index) => index * SPARSE_ORDER_STEP);

  const minimum = BigInt(INT32_MIN);
  const range = BigInt(INT32_MAX) - minimum;
  const step = range / BigInt(count - 1);
  return Array.from({ length: count }, (_, index) => Number(minimum + step * BigInt(index)));
}

function applyOrders(
  room: RoomData,
  entries: readonly RoomPresentationOrderEntry[],
  orders: readonly number[],
) {
  return entries.reduce(
    (current, entry, index) => replaceOrder(current, entry.target, orders[index]!),
    room,
  );
}

export function allocateRoomPresentationOrder(
  room: RoomData,
  plane: RoomPresentationPlane,
): { room: RoomData; order: number } {
  const allocated = allocateRoomPresentationOrders(room, plane, 1);
  return { room: allocated.room, order: allocated.orders[0]! };
}

export function allocateRoomPresentationOrders(
  room: RoomData,
  plane: RoomPresentationPlane,
  count: number,
): { room: RoomData; orders: number[] } {
  if (!Number.isSafeInteger(count) || count <= 0) return { room, orders: [] };
  const entries = orderedPlaneEntries(room, plane);
  if (entries.length === 0) {
    const orders = deterministicSparseOrders(count);
    return { room, orders };
  }
  const last = entries.at(-1)!;
  const requiredSpace = SPARSE_ORDER_STEP * count;
  if (requiredSpace <= INT32_MAX && last.order <= INT32_MAX - requiredSpace) {
    return {
      room,
      orders: Array.from(
        { length: count },
        (_, index) => last.order + SPARSE_ORDER_STEP * (index + 1),
      ),
    };
  }

  const orders = deterministicSparseOrders(entries.length + count);
  return {
    room: applyOrders(room, entries, orders.slice(0, entries.length)),
    orders: orders.slice(entries.length),
  };
}

export function reorderRoomPresentation(
  room: RoomData,
  target: RoomPresentationOrderTarget,
  action: RoomPresentationReorderAction,
): RoomData | null {
  const plane = roomPresentationPlaneForTarget(room, target);
  if (!plane) return null;
  const entries = orderedPlaneEntries(room, plane);
  const currentIndex = entries.findIndex((entry) => targetKey(entry.target) === targetKey(target));
  if (currentIndex < 0) return null;
  const destinationIndex =
    action === 'front'
      ? entries.length - 1
      : action === 'back'
        ? 0
        : action === 'forward'
          ? Math.min(entries.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex - 1);
  if (destinationIndex === currentIndex) return room;

  const [moved] = entries.splice(currentIndex, 1);
  entries.splice(destinationIndex, 0, moved!);
  const previous = entries[destinationIndex - 1];
  const next = entries[destinationIndex + 1];
  let sparseOrder: number | null = null;
  if (!previous && next && next.order >= INT32_MIN + SPARSE_ORDER_STEP)
    sparseOrder = next.order - SPARSE_ORDER_STEP;
  else if (previous && !next && previous.order <= INT32_MAX - SPARSE_ORDER_STEP)
    sparseOrder = previous.order + SPARSE_ORDER_STEP;
  else if (previous && next && next.order - previous.order > 1)
    sparseOrder = previous.order + Math.floor((next.order - previous.order) / 2);

  if (sparseOrder !== null) return replaceOrder(room, target, sparseOrder);
  return applyOrders(room, entries, deterministicSparseOrders(entries.length));
}

export function setRoomPresentationOrder(
  room: RoomData,
  target: RoomPresentationOrderTarget,
  requestedOrder: number,
): RoomData | null {
  if (!Number.isSafeInteger(requestedOrder)) return null;
  const plane = roomPresentationPlaneForTarget(room, target);
  if (!plane) return null;
  const entries = orderedPlaneEntries(room, plane);
  const currentIndex = entries.findIndex((entry) => targetKey(entry.target) === targetKey(target));
  if (currentIndex < 0) return null;
  const current = entries[currentIndex]!;
  if (current.order === requestedOrder) return room;

  const occupied = entries.some(
    (entry, index) => index !== currentIndex && entry.order === requestedOrder,
  );
  if (!occupied) return replaceOrder(room, target, requestedOrder);

  entries.splice(currentIndex, 1);
  const insertionIndex = entries.findIndex((entry) => entry.order >= requestedOrder);
  entries.splice(insertionIndex < 0 ? entries.length : insertionIndex, 0, current);
  return applyOrders(room, entries, deterministicSparseOrders(entries.length));
}
