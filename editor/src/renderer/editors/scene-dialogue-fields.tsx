import {
  useRef,
  useState,
  type ComponentProps,
  type ChangeEvent,
  type CompositionEvent,
} from 'react';
import { Input } from '@/components/ui/input';
import { projectEdits } from '@/commands/project-editing';
import { parseProjectNumberText } from '@/commands/project-number-input';
import { useNativeFieldDraftStore } from '@/commands/native-field-drafts';
import { ProjectFieldError, useProjectField } from '@/commands/use-project-field';
import { buildJsonPointer, getJsonAtPointer } from '@/project/json-pointer';
import { jsonValuesEqual, type JsonValue } from '@/project/json-value';
import { useProjectStore } from '@/project/project-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { selectPendingInput, usePendingInputStore } from '@/workbench/pending-input-store';
import { withPendingInputCommit } from '@/workbench/pending-input-store';
import type { SceneData } from '../../shared/project-schema/authoring-scenes';
import type { DialogueData } from '../../shared/project-schema/authoring-dialogues';
import { isValidEntityId } from '../../shared/project-schema/authoring-common';

type RecordCollection = 'scenes' | 'dialogues';
type RecordData = SceneData | DialogueData;

/** A semantic item has no positional JSON Pointer. Preserve incomplete raw
 * numbers in recovery under an @ID presentation path; only parsed values are
 * passed to the surrounding stable-ID collection's native field intent. */
export function SemanticNumberInput({
  collection,
  recordId,
  pathParts,
  value,
  mode = 'decimal',
  onChange,
  onBlur,
  ...props
}: Omit<ComponentProps<typeof Input>, 'type' | 'value'> & {
  collection: RecordCollection;
  recordId: string;
  pathParts: readonly string[];
  value: number | '';
  mode?: 'decimal' | 'integer';
}) {
  const saveUnitId = recordSaveUnitId(collection, recordId);
  const path = buildJsonPointer([collection, recordId, 'data', ...pathParts]);
  const pending = usePendingInputStore((state) => selectPendingInput(state, saveUnitId, path));
  const [editing, setEditing] = useState<{ path: string; text: string } | null>(null);
  const composing = useRef(false);
  const raw = editing?.path === path ? editing.text : (pending?.value ?? String(value));
  const update = (
    text: string,
    event: ChangeEvent<HTMLInputElement> | CompositionEvent<HTMLInputElement>,
  ) => {
    setEditing({ path, text });
    const parsed = composing.current
      ? undefined
      : parseProjectNumberText(text, {
          mode,
          min: props.min === undefined ? undefined : Number(props.min),
          max: props.max === undefined ? undefined : Number(props.max),
        });
    if (parsed === undefined) {
      usePendingInputStore.getState().setPendingInput(saveUnitId, path, {
        value: text,
        diagnosticCode: 'editor.pending-input.number.invalid',
      });
    } else {
      usePendingInputStore.getState().clearPendingInput(saveUnitId, path);
      if (parsed !== value) onChange?.(event as ChangeEvent<HTMLInputElement>);
    }
  };
  return (
    <Input
      {...props}
      type="text"
      inputMode={mode === 'integer' ? 'numeric' : 'decimal'}
      aria-invalid={Boolean(pending || props['aria-invalid'])}
      value={raw}
      onChange={(event) => update(event.currentTarget.value, event)}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        update(event.currentTarget.value, event);
      }}
      onBlur={(event) => {
        setEditing(null);
        onBlur?.(event);
        const field = buildJsonPointer([collection, recordId, 'data', pathParts[0]!]);
        projectEdits.endFieldSession(field);
        void projectEdits.flushField(field);
      }}
    />
  );
}

/** Semantic identity changes are not keypress mutations. Keep a recoverable
 * raw rename until a complete ID has been atomically accepted by native. */
export function SemanticIdInput({
  collection,
  recordId,
  pathParts,
  value,
  onCommit,
  'aria-label': ariaLabel,
}: {
  collection: RecordCollection;
  recordId: string;
  pathParts: readonly string[];
  value: string;
  onCommit: (next: string) => boolean | Promise<boolean>;
  'aria-label'?: string;
}) {
  const owner = recordSaveUnitId(collection, recordId);
  const path = buildJsonPointer([collection, recordId, 'data', ...pathParts]);
  const pending = usePendingInputStore((state) => selectPendingInput(state, owner, path));
  const [editing, setEditing] = useState<{ path: string; text: string } | null>(null);
  const [committing, setCommitting] = useState(false);
  const skipBlur = useRef(false);
  const raw = editing?.path === path ? editing.text : (pending?.value ?? value);
  const commit = async () => {
    if (committing || raw === value) {
      if (raw === value) {
        usePendingInputStore.getState().clearPendingInput(owner, path);
        setEditing(null);
      }
      return;
    }
    if (!isValidEntityId(raw)) return;
    setCommitting(true);
    // A completed ID authorizes only this exact raw input at command admission.
    // Leave it recoverable and Save-blocking until native acknowledges the rename.
    let accepted = false;
    try {
      accepted = await withPendingInputCommit(owner, path, raw, () => onCommit(raw));
    } catch {
      accepted = false;
    } finally {
      setCommitting(false);
      if (accepted) {
        usePendingInputStore.getState().clearPendingInput(owner, path);
        setEditing(null);
      } else {
        usePendingInputStore.getState().setPendingInput(owner, path, {
          value: raw,
          diagnosticCode: 'editor.pending-input.id.invalid',
        });
      }
    }
  };
  return (
    <Input
      aria-label={ariaLabel}
      aria-invalid={Boolean(pending)}
      value={raw}
      onChange={(event) => {
        const text = event.currentTarget.value;
        setEditing({ path, text });
        usePendingInputStore.getState().setPendingInput(owner, path, {
          value: text,
          diagnosticCode: 'editor.pending-input.id.invalid',
        });
      }}
      onBlur={() => {
        if (skipBlur.current) skipBlur.current = false;
        else void commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape' && !committing) {
          skipBlur.current = true;
          usePendingInputStore.getState().clearPendingInput(owner, path);
          setEditing(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
type RecordSlice<T> = {
  value: T;
  fieldKey: string;
  change: (next: JsonValue) => void;
  error: string | null;
  conflict: boolean;
  flush: () => Promise<boolean>;
  useCurrent: () => Promise<boolean>;
  keepMine: () => Promise<boolean>;
};

function FieldAlerts<T extends RecordData>({ fields }: { fields: SliceMap<T> }) {
  return (
    <>
      {Object.entries(fields).map(([key, controller]) =>
        controller?.error ? (
          <div key={key} className="px-4 pt-2" data-field-error={key}>
            <ProjectFieldError field={controller} />
          </div>
        ) : null,
      )}
    </>
  );
}

/** All of these paths identify an entire stable field or collection, never an
 * array offset. Views of the same record therefore subscribe to one draft. */
function useRecordSlice<T>(
  collection: RecordCollection,
  recordId: string | undefined,
  tabId: string,
  field: string,
  value: T,
): RecordSlice<T> {
  const controller = useProjectField({
    tabId,
    saveUnitId: recordSaveUnitId(collection, recordId ?? ''),
    path: buildJsonPointer([collection, recordId ?? '', 'data', field]),
    value: value as JsonValue,
    label: `Edit ${collection === 'scenes' ? 'Scene' : 'Dialogue'} ${field}`,
  });
  return { ...controller, value: controller.value as T };
}

function json(value: unknown): JsonValue {
  // Optional schema fields are omitted, not converted to null.
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function semanticIds(value: unknown[]): string[] | null {
  const key = value.find((entry) => entry !== null && typeof entry === 'object');
  const property = key && typeof key === 'object' && 'inputId' in key ? 'inputId' : 'id';
  return value.every(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>)[property] === 'string',
  )
    ? value.map((entry) => (entry as Record<string, string>)[property]!)
    : null;
}

/** Identity, ordering and graph-shape changes stay atomic. Ordinary edits to
 * separate semantic IDs can be projected into the latest collection draft. */
export function isStableRecordEdit(
  before: unknown,
  after: unknown,
  depth = 0,
  parentKey = '',
): boolean {
  if (before === after) return true;
  if (Array.isArray(before) && Array.isArray(after)) {
    const ids = semanticIds(before);
    const nextIds = semanticIds(after);
    if (
      before.length !== after.length ||
      !ids ||
      !nextIds ||
      ids.some((id, index) => id !== nextIds[index])
    ) {
      // Reordering a stable-ID list is semantic even when its shape survives.
      if (
        ids &&
        nextIds &&
        ids.length === nextIds.length &&
        ids.some((id, index) => id !== nextIds[index])
      )
        return false;
      // A root collection, block/segment identity, or graph membership is a
      // semantic transaction. Embedded cue markup, input bindings and scalar
      // dependency lists may be staged as part of their stable parent field.
      return depth > 0 && !['segments', 'branches', 'options', 'children'].includes(parentKey);
    }
    return before.every((item, index) => isStableRecordEdit(item, after[index], depth + 1));
  }
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    if (Array.isArray(before) || Array.isArray(after)) return false;
    const old = before as Record<string, unknown>;
    const next = after as Record<string, unknown>;
    if ((old.type !== next.type || old.id !== next.id) && ('type' in old || 'id' in old))
      return false;
    return [...new Set([...Object.keys(old), ...Object.keys(next)])].every((key) =>
      isStableRecordEdit(old[key], next[key], depth + 1, key),
    );
  }
  return !Array.isArray(before) && !Array.isArray(after);
}

/** Reapply only the event-time changed members/keys to the latest staged field.
 * Reordering another item in a separate view cannot redirect an index edit. */
export function mergeStableRecordEdit(before: unknown, after: unknown, latest: unknown): unknown {
  if (before === after || jsonValuesEqual(before as JsonValue, after as JsonValue)) return latest;
  if (Array.isArray(before) && Array.isArray(after)) {
    if (!Array.isArray(latest)) throw new Error('The collection was removed while editing.');
    const ids = semanticIds(before);
    const nextIds = semanticIds(after);
    if (!ids || !nextIds) {
      // An unkeyed list has no stable member identity for a safe rebase.
      if (!jsonValuesEqual(before as JsonValue, latest as JsonValue))
        throw new Error('An unkeyed nested collection changed during editing.');
      return after;
    }
    const previous = new Map(ids.map((id, index) => [id, index]));
    const latestIds = semanticIds(latest);
    if (!latestIds) throw new Error('The collection identity changed during editing.');
    const nextById = new Map(nextIds.map((id, index) => [id, after[index]]));
    const result = latest.flatMap((item, index) => {
      const id = latestIds[index]!;
      if (previous.has(id) && !nextById.has(id)) return [];
      if (!previous.has(id)) return [item];
      return [mergeStableRecordEdit(before[previous.get(id)!], nextById.get(id), item)];
    });
    for (const [index, id] of nextIds.entries()) {
      if (previous.has(id)) {
        if (!latestIds.includes(id))
          throw new Error(`Collection item '${id}' was removed during editing.`);
        continue;
      }
      if (latestIds.includes(id)) throw new Error(`Collection item '${id}' already exists.`);
      const following = nextIds
        .slice(index + 1)
        .find((candidate) => result.some((item) => semanticIds([item])?.[0] === candidate));
      const position = following
        ? result.findIndex((item) => semanticIds([item])?.[0] === following)
        : result.length;
      result.splice(position, 0, after[index]);
    }
    return result;
  }
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    if (!latest || typeof latest !== 'object' || Array.isArray(latest))
      throw new Error('The edited object was replaced.');
    const result = { ...(latest as Record<string, unknown>) };
    for (const key of new Set([
      ...Object.keys(before as object),
      ...Object.keys(after as object),
    ])) {
      const oldValue = (before as Record<string, unknown>)[key];
      const newValue = (after as Record<string, unknown>)[key];
      if (oldValue === newValue || jsonValuesEqual(oldValue as JsonValue, newValue as JsonValue))
        continue;
      if (newValue === undefined) delete result[key];
      else if (oldValue === undefined) result[key] = newValue;
      else result[key] = mergeStableRecordEdit(oldValue, newValue, result[key]);
    }
    return result;
  }
  return after;
}

type SliceMap<T extends RecordData> = {
  [K in keyof T]?: RecordSlice<T[K]>;
};

/** Per-event delta classification keeps ordinary typing off replaceData.
 * Structural and cross-reference changes first checkpoint pending fields,
 * then check changed slices against the acknowledged native record. */
function commitRecord<T extends RecordData>(options: {
  collection: RecordCollection;
  id: string;
  before: T;
  after: T;
  fields: SliceMap<T>;
  label: string;
  semanticOwnerMoves?: { fromPrefix: string; toPrefix: string }[];
  onError: (message: string | null) => void;
}): Promise<boolean> {
  const { collection, id, before, after, fields, label, semanticOwnerMoves } = options;
  const keys = (Object.keys(fields) as (keyof T)[]).filter(
    (key) =>
      before[key] !== after[key] &&
      !jsonValuesEqual(before[key] as JsonValue, after[key] as JsonValue),
  );
  if (!keys.length) return Promise.resolve(true);
  const owner = recordSaveUnitId(collection, id);
  const structural =
    Boolean(semanticOwnerMoves?.length) ||
    keys.length > 1 ||
    keys.some((key) => !isStableRecordEdit(before[key], after[key]));
  if (!structural) {
    const key = keys[0]!;
    const field = fields[key]!;
    const live = useNativeFieldDraftStore.getState().entries[field.fieldKey]?.value;
    const document = useProjectStore.getState().document;
    const current =
      live ??
      (document
        ? getJsonAtPointer(document, buildJsonPointer([collection, id, 'data', String(key)]))
        : field.value);
    field.change(json(mergeStableRecordEdit(before[key], after[key], current)));
    options.onError(null);
    return Promise.resolve(true);
  }

  return (async () => {
    // execute() itself checkpoints pending fields before evaluating its
    // late-bound command in the native queue. Do not open a pre-execute await:
    // semantic ID input admission tokens must be captured synchronously.
    const result = await projectEdits.execute(() => {
      const document = useProjectStore.getState().document;
      if (!document) throw new Error('The Project was closed before the transaction.');
      const latest = getJsonAtPointer(document, buildJsonPointer([collection, id, 'data'])) as T;
      const rebased = { ...latest };
      for (const key of keys) {
        if (!jsonValuesEqual(json(before[key]), json(latest[key])))
          throw new Error(
            `${collection} '${id}' field '${String(key)}' changed before the transaction.`,
          );
        rebased[key] = after[key];
      }
      return {
        type: collection === 'scenes' ? 'scene.replaceData' : 'dialogue.replaceData',
        label,
        payload: {
          ...(collection === 'scenes' ? { sceneId: id } : { dialogueId: id }),
          data: rebased,
          semanticOwnerMoves,
        },
        originSaveUnitId: owner,
        persistencePolicy: 'manual-save' as const,
      };
    });
    options.onError(
      result.ok ? null : (result.diagnostics[0]?.message ?? 'Native structural edit rejected.'),
    );
    return result.ok;
  })();
}

export function useSceneEditorFields(
  id: string | undefined,
  tabId: string,
  acknowledged: SceneData,
) {
  const [commandError, setCommandError] = useState<string | null>(null);
  const displayName = useRecordSlice('scenes', id, tabId, 'displayName', acknowledged.displayName);
  const stage = useRecordSlice('scenes', id, tabId, 'stage', acknowledged.stage);
  const inputs = useRecordSlice('scenes', id, tabId, 'inputs', acknowledged.inputs);
  const outcomes = useRecordSlice('scenes', id, tabId, 'outcomes', acknowledged.outcomes);
  const events = useRecordSlice('scenes', id, tabId, 'events', acknowledged.events);
  const terminal = useRecordSlice('scenes', id, tabId, 'terminal', acknowledged.terminal);
  const fields = { displayName, stage, inputs, outcomes, events, terminal };
  const data: SceneData = {
    ...acknowledged,
    displayName: displayName.value,
    stage: stage.value,
    inputs: inputs.value,
    outcomes: outcomes.value,
    events: events.value,
    terminal: terminal.value,
  };
  const commitChecked = (
    next: SceneData,
    label = 'Update scene',
    moves?: { fromPrefix: string; toPrefix: string }[],
  ) =>
    id
      ? commitRecord({
          collection: 'scenes',
          id,
          before: data,
          after: next,
          fields,
          label,
          semanticOwnerMoves: moves,
          onError: setCommandError,
        })
      : Promise.resolve(false);
  return {
    data,
    feedback: (
      <>
        {commandError ? (
          <p role="alert" className="text-destructive text-xs">
            {commandError}
          </p>
        ) : null}
        <FieldAlerts fields={fields} />
      </>
    ),
    commit: (
      next: SceneData,
      label?: string,
      moves?: { fromPrefix: string; toPrefix: string }[],
    ) => {
      void commitChecked(next, label, moves);
    },
    commitChecked,
  };
}

export function useDialogueEditorFields(
  id: string | undefined,
  tabId: string,
  acknowledged: DialogueData,
) {
  const [commandError, setCommandError] = useState<string | null>(null);
  const displayName = useRecordSlice(
    'dialogues',
    id,
    tabId,
    'displayName',
    acknowledged.displayName,
  );
  const defaultSpeaker = useRecordSlice(
    'dialogues',
    id,
    tabId,
    'defaultSpeaker',
    acknowledged.defaultSpeaker,
  );
  const stageSlots = useRecordSlice('dialogues', id, tabId, 'stageSlots', acknowledged.stageSlots);
  const mediaSlots = useRecordSlice('dialogues', id, tabId, 'mediaSlots', acknowledged.mediaSlots);
  const settings = useRecordSlice('dialogues', id, tabId, 'settings', acknowledged.settings);
  const entryBlockId = useRecordSlice(
    'dialogues',
    id,
    tabId,
    'entryBlockId',
    acknowledged.entryBlockId,
  );
  const blocks = useRecordSlice('dialogues', id, tabId, 'blocks', acknowledged.blocks);
  const edges = useRecordSlice('dialogues', id, tabId, 'edges', acknowledged.edges);
  const completion = useRecordSlice('dialogues', id, tabId, 'completion', acknowledged.completion);
  const fields = {
    displayName,
    defaultSpeaker,
    stageSlots,
    mediaSlots,
    settings,
    entryBlockId,
    blocks,
    edges,
    completion,
  };
  const data: DialogueData = {
    ...acknowledged,
    displayName: displayName.value,
    defaultSpeaker: defaultSpeaker.value,
    stageSlots: stageSlots.value,
    mediaSlots: mediaSlots.value,
    settings: settings.value,
    entryBlockId: entryBlockId.value,
    blocks: blocks.value,
    edges: edges.value,
    completion: completion.value,
  };
  const commitChecked = (
    next: DialogueData,
    label = 'Update dialogue',
    moves?: { fromPrefix: string; toPrefix: string }[],
  ) =>
    id
      ? commitRecord({
          collection: 'dialogues',
          id,
          before: data,
          after: next,
          fields,
          label,
          semanticOwnerMoves: moves,
          onError: setCommandError,
        })
      : Promise.resolve(false);
  return {
    data,
    feedback: (
      <>
        {commandError ? (
          <p role="alert" className="text-destructive text-xs">
            {commandError}
          </p>
        ) : null}
        <FieldAlerts fields={fields} />
      </>
    ),
    commit: (
      next: DialogueData,
      label?: string,
      moves?: { fromPrefix: string; toPrefix: string }[],
    ) => {
      void commitChecked(next, label, moves);
    },
    commitChecked,
  };
}
