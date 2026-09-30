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

export const ROOM_PRESENTATION_ORDER_MIN = -2_147_483_648;
export const ROOM_PRESENTATION_ORDER_MAX = 2_147_483_647;
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

export function orderedRoomPresentationPlaneEntries(room: RoomData, plane: RoomPresentationPlane) {
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
  if ((count - 1) * SPARSE_ORDER_STEP <= ROOM_PRESENTATION_ORDER_MAX)
    return Array.from({ length: count }, (_, index) => index * SPARSE_ORDER_STEP);

  const minimum = BigInt(ROOM_PRESENTATION_ORDER_MIN);
  const range = BigInt(ROOM_PRESENTATION_ORDER_MAX) - minimum;
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
  const entries = orderedRoomPresentationPlaneEntries(room, plane);
  if (entries.length === 0) {
    const orders = deterministicSparseOrders(count);
    return { room, orders };
  }
  const last = entries.at(-1)!;
  const requiredSpace = SPARSE_ORDER_STEP * count;
  if (
    requiredSpace <= ROOM_PRESENTATION_ORDER_MAX &&
    last.order <= ROOM_PRESENTATION_ORDER_MAX - requiredSpace
  ) {
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
  const entries = orderedRoomPresentationPlaneEntries(room, plane);
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
  const sparseOrder = orderBetween(previous?.order, next?.order);

  if (sparseOrder !== null) return replaceOrder(room, target, sparseOrder);
  return applyOrders(room, entries, deterministicSparseOrders(entries.length));
}

export function setRoomPresentationOrder(
  room: RoomData,
  target: RoomPresentationOrderTarget,
  requestedOrder: number,
): RoomData | null {
  if (
    !Number.isInteger(requestedOrder) ||
    requestedOrder < ROOM_PRESENTATION_ORDER_MIN ||
    requestedOrder > ROOM_PRESENTATION_ORDER_MAX
  )
    return null;
  const plane = roomPresentationPlaneForTarget(room, target);
  if (!plane) return null;
  const entries = orderedRoomPresentationPlaneEntries(room, plane);
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
  const destinationIndex = insertionIndex < 0 ? entries.length : insertionIndex;
  entries.splice(destinationIndex, 0, current);
  const previous = entries[destinationIndex - 1];
  const next = entries[destinationIndex + 1];
  const sparseOrder = orderBetween(previous?.order, next?.order);
  if (sparseOrder !== null) return replaceOrder(room, target, sparseOrder);
  return applyOrders(room, entries, deterministicSparseOrders(entries.length));
}

function orderBetween(previous: number | undefined, next: number | undefined): number | null {
  if (previous === undefined && next === undefined) return 0;
  if (previous === undefined) {
    const preferred = next! - SPARSE_ORDER_STEP;
    if (preferred >= ROOM_PRESENTATION_ORDER_MIN) return preferred;
    return next! > ROOM_PRESENTATION_ORDER_MIN ? next! - 1 : null;
  }
  if (next === undefined) {
    const preferred = previous + SPARSE_ORDER_STEP;
    if (preferred <= ROOM_PRESENTATION_ORDER_MAX) return preferred;
    return previous < ROOM_PRESENTATION_ORDER_MAX ? previous + 1 : null;
  }
  if (next - previous <= 1) return null;
  return previous + Math.floor((next - previous) / 2);
}

function allocateRunOrders(
  count: number,
  previous: number | undefined,
  next: number | undefined,
): number[] | null {
  if (count === 0) return [];
  if (previous === undefined && next === undefined) return deterministicSparseOrders(count);
  if (previous === undefined) {
    const first = next! - SPARSE_ORDER_STEP * count;
    if (first >= ROOM_PRESENTATION_ORDER_MIN)
      return Array.from({ length: count }, (_, index) => first + SPARSE_ORDER_STEP * index);
  }
  if (next === undefined) {
    const last = previous! + SPARSE_ORDER_STEP * count;
    if (last <= ROOM_PRESENTATION_ORDER_MAX)
      return Array.from(
        { length: count },
        (_, index) => previous! + SPARSE_ORDER_STEP * (index + 1),
      );
  }
  const lower = BigInt(previous ?? ROOM_PRESENTATION_ORDER_MIN - 1);
  const upper = BigInt(next ?? ROOM_PRESENTATION_ORDER_MAX + 1);
  const available = upper - lower - 1n;
  if (available < BigInt(count)) return null;
  const span = upper - lower;
  return Array.from({ length: count }, (_, index) =>
    Number(lower + (span * BigInt(index + 1)) / BigInt(count + 1)),
  );
}

function applySelectionOrder(
  room: RoomData,
  entries: readonly RoomPresentationOrderEntry[],
  selectedKeys: ReadonlySet<string>,
): RoomData {
  const assignments = new Map<string, number>();
  let index = 0;
  while (index < entries.length) {
    if (!selectedKeys.has(targetKey(entries[index]!.target))) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < entries.length && selectedKeys.has(targetKey(entries[index]!.target)))
      index += 1;
    const orders = allocateRunOrders(
      index - start,
      entries[start - 1]?.order,
      entries[index]?.order,
    );
    if (!orders) return applyOrders(room, entries, deterministicSparseOrders(entries.length));
    for (let offset = 0; offset < orders.length; offset += 1)
      assignments.set(targetKey(entries[start + offset]!.target), orders[offset]!);
  }
  return entries.reduce((current, entry) => {
    const order = assignments.get(targetKey(entry.target));
    return order === undefined || order === entry.order
      ? current
      : replaceOrder(current, entry.target, order);
  }, room);
}

export function reorderRoomPresentationSelection(
  room: RoomData,
  targets: readonly RoomPresentationOrderTarget[],
  action: RoomPresentationReorderAction,
): RoomData | null {
  if (targets.length === 0) return null;
  const selectedKeys = new Set(targets.map(targetKey));
  if (selectedKeys.size !== targets.length) return null;
  const entriesByKey = new Map(
    roomPresentationOrderEntries(room).map((entry) => [targetKey(entry.target), entry]),
  );
  const selectedEntries = targets.map((target) => entriesByKey.get(targetKey(target)));
  if (selectedEntries.some((entry) => !entry)) return null;
  const plane = selectedEntries[0]!.plane;
  if (selectedEntries.some((entry) => entry!.plane !== plane)) return null;

  const entries = orderedRoomPresentationPlaneEntries(room, plane);
  const originalKeys = entries.map((entry) => targetKey(entry.target));
  if (action === 'front' || action === 'back') {
    const selected = entries.filter((entry) => selectedKeys.has(targetKey(entry.target)));
    const unselected = entries.filter((entry) => !selectedKeys.has(targetKey(entry.target)));
    entries.splice(
      0,
      entries.length,
      ...(action === 'front' ? [...unselected, ...selected] : [...selected, ...unselected]),
    );
  } else if (action === 'forward') {
    for (let index = entries.length - 2; index >= 0; index -= 1) {
      if (
        selectedKeys.has(targetKey(entries[index]!.target)) &&
        !selectedKeys.has(targetKey(entries[index + 1]!.target))
      )
        [entries[index], entries[index + 1]] = [entries[index + 1]!, entries[index]!];
    }
  } else {
    for (let index = 1; index < entries.length; index += 1) {
      if (
        selectedKeys.has(targetKey(entries[index]!.target)) &&
        !selectedKeys.has(targetKey(entries[index - 1]!.target))
      )
        [entries[index - 1], entries[index]] = [entries[index]!, entries[index - 1]!];
    }
  }
  if (entries.every((entry, index) => targetKey(entry.target) === originalKeys[index])) return room;
  return applySelectionOrder(room, entries, selectedKeys);
}
