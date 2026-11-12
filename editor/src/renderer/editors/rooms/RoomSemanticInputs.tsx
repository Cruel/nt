import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { parseProjectNumberText } from '@/commands/project-number-input';
import { buildJsonPointer } from '@/project/json-pointer';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { selectPendingInput, usePendingInputStore } from '@/workbench/pending-input-store';
import { isValidEntityId } from '../../../shared/project-schema/authoring-common';

/** Synthetic, stable-ID path for *raw pending UI text*, never a native patch
 * pointer. The actual native field is the surrounding collection array. */
function pendingItemPath(
  roomId: string,
  field: 'views' | 'anchors' | 'exits',
  id: string,
  property: string,
) {
  return buildJsonPointer([
    'rooms',
    roomId,
    'data',
    ...(field === 'views' ? ['presentationSpace', 'views'] : [field]),
    '@' + id,
    property,
  ]);
}

/** A rename preserves unfinished raw numbers under the new semantic ID;
 * deleting the item explicitly discards its pending raw inputs. */
export function relocatePendingItem(
  roomId: string,
  collection: 'views' | 'anchors' | 'exits',
  fromId: string,
  toId: string | null,
) {
  const owner = recordSaveUnitId('rooms', roomId);
  const prefix = pendingItemPath(roomId, collection, fromId, '');
  const entries = usePendingInputStore.getState().entriesBySaveUnitId[owner] ?? {};
  for (const [path, pending] of Object.entries(entries)) {
    if (!path.startsWith(prefix)) continue;
    usePendingInputStore.getState().clearPendingInput(owner, path);
    if (toId !== null) {
      const nextPrefix = pendingItemPath(roomId, collection, toId, '');
      usePendingInputStore
        .getState()
        .setPendingInput(owner, nextPrefix + path.slice(prefix.length), pending);
    }
  }
}

export function RoomCollectionNumber({
  roomId,
  collection,
  itemId,
  property,
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  roomId: string;
  collection: 'views' | 'anchors' | 'exits';
  itemId: string;
  property: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const owner = recordSaveUnitId('rooms', roomId);
  const path = pendingItemPath(roomId, collection, itemId, property);
  const pending = usePendingInputStore((state) => selectPendingInput(state, owner, path));
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Input
      aria-label={label}
      aria-invalid={Boolean(pending)}
      type="text"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={editing ?? pending?.value ?? String(value)}
      onChange={(event) => {
        const raw = event.currentTarget.value;
        setEditing(raw);
        const parsed = parseProjectNumberText(raw, { mode: 'decimal', min, max });
        if (parsed !== undefined) {
          usePendingInputStore.getState().clearPendingInput(owner, path);
          if (!Object.is(parsed, value)) onChange(parsed);
        } else {
          usePendingInputStore.getState().setPendingInput(owner, path, {
            value: raw,
            diagnosticCode: 'editor.pending-input.number.invalid',
          });
        }
      }}
      onBlur={() => setEditing(null)}
    />
  );
}

export function RoomCollectionIdInput({
  roomId,
  collection,
  itemId,
  allIds,
  label,
  onCommit,
}: {
  roomId: string;
  collection: 'views' | 'anchors' | 'exits';
  itemId: string;
  allIds: readonly string[];
  label: string;
  onCommit: (next: string) => void;
}) {
  const owner = recordSaveUnitId('rooms', roomId);
  const path = pendingItemPath(roomId, collection, itemId, 'id');
  const pending = usePendingInputStore((state) => selectPendingInput(state, owner, path));
  const [editing, setEditing] = useState<string | null>(null);
  const commit = (next: string) => {
    if (!isValidEntityId(next) || (next !== itemId && allIds.includes(next))) {
      usePendingInputStore.getState().setPendingInput(owner, path, {
        value: next,
        diagnosticCode: 'editor.pending-input.id.invalid',
      });
      return;
    }
    usePendingInputStore.getState().clearPendingInput(owner, path);
    if (next !== itemId) onCommit(next);
    setEditing(null);
  };
  return (
    <Input
      aria-label={label}
      aria-invalid={Boolean(pending)}
      value={editing ?? pending?.value ?? itemId}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setEditing(next);
        // A structural rename is committed on blur, not per character. Raw
        // text is persisted immediately so Save cannot skip an in-progress ID.
        usePendingInputStore.getState().setPendingInput(owner, path, {
          value: next,
          diagnosticCode: 'editor.pending-input.id.invalid',
        });
      }}
      onBlur={(event) => {
        commit(event.currentTarget.value);
        setEditing(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}
