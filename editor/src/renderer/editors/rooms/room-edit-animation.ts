import type { CharacterIdleData } from '../../../shared/project-schema/authoring-characters';
import type { RoomEditProjectedRect, RoomEditSize } from './room-edit-projection';
import { applyRoomEditNavigation, type RoomEditNavigation } from './room-edit-navigation';

export type RoomEditClockDomain = CharacterIdleData['clock'];

export interface RoomEditOccurrenceEpoch {
  clock: RoomEditClockDomain;
  startedAtSeconds: number;
}

export function occurrenceElapsedSeconds(
  epochs: Map<string, RoomEditOccurrenceEpoch>,
  key: string,
  clock: RoomEditClockDomain,
  nowSeconds: number,
) {
  const existing = epochs.get(key);
  if (!existing || existing.clock !== clock || nowSeconds < existing.startedAtSeconds) {
    epochs.set(key, { clock, startedAtSeconds: nowSeconds });
    return 0;
  }
  return nowSeconds - existing.startedAtSeconds;
}

export function retainOccurrenceEpochs(
  epochs: Map<string, RoomEditOccurrenceEpoch>,
  activeKeys: ReadonlySet<string>,
) {
  for (const key of epochs.keys()) if (!activeKeys.has(key)) epochs.delete(key);
}

export function applyCharacterIdleProjection(
  projected: RoomEditProjectedRect,
  idle: CharacterIdleData | null,
  elapsedSeconds: number,
  viewport: RoomEditSize,
): RoomEditProjectedRect {
  if (!idle) return projected;
  const periodSeconds = idle.periodMs / 1000;
  const wave = periodSeconds > 0 ? Math.sin((elapsedSeconds / periodSeconds) * Math.PI * 2) : 0;
  const amount = idle.amplitude * wave;
  const rect = { ...projected.rect };
  switch (idle.kind) {
    case 'bob':
      rect.y -= amount * viewport.height;
      break;
    case 'sway':
      rect.x += amount * viewport.width;
      break;
    case 'pulse': {
      const scale = Math.max(0, 1 + amount);
      const width = rect.width * scale;
      const height = rect.height * scale;
      rect.x += (rect.width - width) * 0.5;
      rect.y += (rect.height - height) * 0.5;
      rect.width = width;
      rect.height = height;
      break;
    }
  }
  return { ...projected, rect };
}

export function applyCharacterIdleDisplayProjection(
  canonicalProjected: RoomEditProjectedRect,
  idle: CharacterIdleData | null,
  elapsedSeconds: number,
  viewport: RoomEditSize,
  navigation: RoomEditNavigation,
) {
  return applyRoomEditNavigation(
    applyCharacterIdleProjection(canonicalProjected, idle, elapsedSeconds, viewport),
    viewport,
    navigation,
  );
}
