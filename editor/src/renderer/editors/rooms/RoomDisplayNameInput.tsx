import { useCallback, useEffect, useRef, useState } from 'react';
import { useCommandStore } from '@/commands/command-store';
import { Input } from '@/components/ui/input';
import { useProjectStore } from '@/project/project-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { isAuthoringProjectView } from '../../../shared/project-schema/authoring-project-view';
import { resolveGameplayInstanceRecord } from '../../../shared/project-schema/authoring-archetypes';
import { defaultRoomData, parseRoomData } from '../../../shared/project-schema/authoring-rooms';
import { restoredDraftPayload, useEditorDraftDirty } from '@/workbench/draft-dirty-store';

const draftSchema = 'noveltea.editor.draft.room-display-name';

/**
 * A native Project acknowledgment must not be on the keystroke-to-paint path.
 * Keep an editor-owned recoverable draft and coalesce typing into a bounded
 * number of native mutations. Save, Save All, and Close explicitly await apply.
 */
export function RoomDisplayNameInput({
  roomId,
  tabId,
  value,
}: {
  roomId: string;
  tabId: string;
  value: string;
}) {
  const draftKey = `${tabId}:room-display-name`;
  const [draft, setDraft] = useState<string | null>(
    () => restoredDraftPayload<string>(draftKey, draftSchema) ?? null,
  );
  const draftRef = useRef(draft);
  const pendingRef = useRef<Promise<boolean> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateDraft = useCallback((next: string | null) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const applyDraft = useCallback((): Promise<boolean> => {
    if (pendingRef.current) return pendingRef.current;
    const pending = (async () => {
      while (draftRef.current !== null) {
        const next = draftRef.current;
        const project = useProjectStore.getState().document;
        if (!isAuthoringProjectView(project) || !project.rooms[roomId]) {
          setError('The Room is no longer available.');
          return false;
        }
        const record = project.rooms[roomId]!;
        const effective = resolveGameplayInstanceRecord(project, 'room', record) ?? record;
        const data = parseRoomData(effective.data) ?? defaultRoomData(record.label ?? roomId);
        if (data.displayName !== next) {
          // Archetyped Rooms require the normal override planner; an ordinary
          // Room can patch just one field instead of serializing its full data.
          const request = record.archetype
            ? {
                type: 'room.replaceData',
                payload: { roomId, data: { ...data, displayName: next } },
              }
            : {
                type: 'project.replaceAtPath',
                payload: {
                  path: `/rooms/${roomId.replace(/~/gu, '~0').replace(/\//gu, '~1')}/data/displayName`,
                  value: next,
                },
              };
          const result = await useCommandStore.getState().executeCommandAsync({
            ...request,
            label: 'Update room name',
            originSaveUnitId: recordSaveUnitId('rooms', roomId),
            persistencePolicy: 'manual-save',
          });
          if (!result.ok) {
            setError(
              result.diagnostics[0]?.message ?? 'The Room display name could not be updated.',
            );
            return false;
          }
        }
        setError(null);
        // More typing may have arrived during native acknowledgment. Never
        // clear or replace that newer text with the older confirmed value.
        if (draftRef.current === next) updateDraft(null);
      }
      return true;
    })();
    pendingRef.current = pending;
    void pending.finally(() => {
      if (pendingRef.current === pending) pendingRef.current = null;
    });
    return pending;
  }, [roomId, updateDraft]);

  useEditorDraftDirty(tabId, draft !== null, {
    key: draftKey,
    label: 'Room display name',
    schema: draftSchema,
    payload: draft ?? undefined,
    apply: applyDraft,
    discard: () => {
      updateDraft(null);
      setError(null);
      return true;
    },
    preserveOnUnmount: true,
  });

  useEffect(() => {
    if (draft === null) return undefined;
    const timeout = setTimeout(() => void applyDraft(), 150);
    return () => clearTimeout(timeout);
  }, [applyDraft, draft]);

  return (
    <>
      <Input
        aria-label="Room display name"
        aria-invalid={error !== null}
        value={draft ?? value}
        onChange={(event) => {
          setError(null);
          updateDraft(event.currentTarget.value);
        }}
        onBlur={() => void applyDraft()}
      />
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </>
  );
}
