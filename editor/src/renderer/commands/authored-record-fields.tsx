import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { ProjectFieldError, useProjectField } from './use-project-field';
import { projectEdits } from './project-editing';
import { useNativeFieldDraftStore } from './native-field-drafts';
import { parseProjectNumberText } from './project-number-input';
import { buildJsonPointer, getJsonAtPointer } from '@/project/json-pointer';
import { jsonValuesEqual, type JsonValue } from '@/project/json-value';
import { useProjectStore } from '@/project/project-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { selectPendingInput, usePendingInputStore } from '@/workbench/pending-input-store';
import { isValidEntityId } from '../../shared/project-schema/authoring-common';
import { remapNamedSlotReferences } from '@/editors/verbs/verb-slot-rename';
import type { VerbData } from '../../shared/project-schema/authoring-verbs';
import { parseInteractionData } from '../../shared/project-schema/authoring-interactions';
import { parseTestData } from '../../shared/project-schema/authoring-tests';

type Collection = 'tests' | 'interactions' | 'verbs';

interface RejectedAuthoredIntent<T> {
  before: T;
  after: T;
  label: string;
  error: string;
}

// A coordinated edit spans several field controllers and must be submitted as
// one native command. A rejected proposal is retained as one recoverable raw
// intent, not split into non-atomic independent field drafts.
function semanticPendingPath(collection: Collection, id: string) {
  return buildJsonPointer([collection, id, 'data', '@semantic']);
}

function renamedVerbSlot(before: VerbData, after: VerbData) {
  const oldIds = before.slots.map((slot) => slot.id);
  const newIds = after.slots.map((slot) => slot.id);
  if (oldIds.length !== newIds.length) return null;
  const removed = oldIds.filter((id) => !newIds.includes(id));
  const added = newIds.filter((id) => !oldIds.includes(id));
  return removed.length === 1 && added.length === 1
    ? { previousId: removed[0]!, nextId: added[0]! }
    : null;
}

// Legacy export retained for the sibling Authored Test/Interaction/Verb adapters.
// All authored record editors use one narrow native JSON patch planner.
export { nativeFieldJsonPatches as authoredNativePatches } from './native-field-json-patches';
import { nativeFieldJsonPatches as authoredNativePatches } from './native-field-json-patches';

export function useAuthoredRecordField<T>(
  collection: Collection,
  id: string | undefined,
  tabId: string,
  field: string,
  value: T,
) {
  const path = buildJsonPointer([collection, id ?? '', 'data', field]);
  const saveUnitId = recordSaveUnitId(collection, id ?? '');
  const controller = useProjectField({
    tabId,
    saveUnitId,
    path,
    value: value as JsonValue,
    label: `Edit ${collection} ${field}`,
    buildCommand: (next: JsonValue) => {
      const document = useProjectStore.getState().document;
      if (!document) throw new Error('The Project was closed before the field edit.');
      const previous = getJsonAtPointer(document, path);
      const patches = authoredNativePatches(previous, next, path);
      return {
        type: 'project.applyPatch',
        label: `Edit ${collection} ${field}`,
        payload: patches,
        originSaveUnitId: saveUnitId,
        persistencePolicy: 'manual-save',
      };
    },
  });
  return { ...controller, value: controller.value as T };
}

type Field<T> = ReturnType<typeof useAuthoredRecordField<T>>;
export type AuthoredRecordFields<T extends object> = { [K in keyof T]: Field<T[K]> };

export function AuthoredRecordErrors<T extends object>({
  fields,
  collection,
  recordId,
}: {
  fields: AuthoredRecordFields<T>;
  collection: Collection;
  recordId: string;
}) {
  const owner = recordSaveUnitId(collection, recordId);
  const path = semanticPendingPath(collection, recordId);
  const pending = usePendingInputStore((state) => selectPendingInput(state, owner, path));
  let rejected: RejectedAuthoredIntent<T> | null = null;
  if (pending) {
    try {
      const parsed = JSON.parse(pending.value) as Partial<RejectedAuthoredIntent<T>>;
      if (
        parsed &&
        typeof parsed === 'object' &&
        'before' in parsed &&
        'after' in parsed &&
        typeof parsed.label === 'string' &&
        typeof parsed.error === 'string'
      )
        rejected = parsed as RejectedAuthoredIntent<T>;
    } catch {
      // Corrupt recovery remains visible and discardable, never executable.
    }
  }
  return (
    <>
      {(Object.entries(fields) as [string, Field<unknown>][]).map(([name, field]) =>
        field?.error ? (
          <div key={name} data-field-error={name}>
            <ProjectFieldError field={field} />
          </div>
        ) : null,
      )}
      {pending && (
        <p role="alert" className="text-destructive text-xs">
          {rejected?.error ?? 'The stored coordinated edit is invalid.'} The unapplied change is
          retained for recovery.{' '}
          {rejected && (
            <button
              type="button"
              className="underline"
              onClick={() => {
                usePendingInputStore.getState().clearPendingInput(owner, path);
                commitAuthoredRecord({
                  collection,
                  id: recordId,
                  before: rejected!.before,
                  after: rejected!.after,
                  fields,
                  label: rejected!.label,
                });
              }}
            >
              Retry
            </button>
          )}{' '}
          <button
            type="button"
            className="underline"
            onClick={() => usePendingInputStore.getState().clearPendingInput(owner, path)}
          >
            Discard
          </button>
        </p>
      )}
    </>
  );
}

function equal(before: unknown, after: unknown) {
  return jsonValuesEqual(before as JsonValue, after as JsonValue);
}

function memberId(item: unknown): string | null {
  return item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    typeof (item as { id?: unknown }).id === 'string'
    ? (item as { id: string }).id
    : null;
}

/** Merge an event-time edit into the newest optimistic projection. Keyed arrays
 * resolve members by stable ID, not a stale index; additions and reorders are
 * applied to the current sequence without dropping disjoint member edits. */
export function mergeAuthoredValue(before: unknown, after: unknown, latest: unknown): unknown {
  if (equal(before, after)) return latest;
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(latest)) {
    const oldIds = before.map(memberId);
    const nextIds = after.map(memberId);
    const latestIds = latest.map(memberId);
    const keyed =
      [...oldIds, ...nextIds, ...latestIds].every((id) => id !== null) &&
      [oldIds, nextIds, latestIds].every((ids) => new Set(ids).size === ids.length);
    if (keyed) {
      const originals = new Map(oldIds.map((id, index) => [id, before[index]]));
      const updates = new Map(nextIds.map((id, index) => [id, after[index]]));
      const current = new Map(latestIds.map((id, index) => [id, latest[index]]));
      for (const id of oldIds) {
        if (!current.has(id)) throw new Error(`Collection member '${id}' was removed.`);
        if (!updates.has(id)) current.delete(id);
        else
          current.set(id, mergeAuthoredValue(originals.get(id), updates.get(id), current.get(id)));
      }
      for (const id of nextIds) {
        if (originals.has(id)) continue;
        if (current.has(id)) throw new Error(`Collection member '${id}' already exists.`);
        current.set(id, updates.get(id));
      }
      const originalOrder = oldIds.filter((id) => updates.has(id));
      const updatedOrder = nextIds.filter((id) => originals.has(id));
      const orderUnchanged =
        originalOrder.length === updatedOrder.length &&
        originalOrder.every((id, index) => id === updatedOrder[index]);
      const order = latestIds.filter((id) => current.has(id));
      if (!orderUnchanged) {
        // Reordering one list must not erase concurrently inserted members.
        for (const id of updatedOrder) {
          const at = order.indexOf(id);
          if (at >= 0) order.splice(at, 1);
        }
        order.unshift(...updatedOrder);
      }
      // Insert new items at their requested semantic position.
      for (const [index, id] of nextIds.entries()) {
        if (originals.has(id)) continue;
        const anchor = nextIds.slice(index + 1).find((candidate) => order.includes(candidate));
        order.splice(anchor === undefined ? order.length : order.indexOf(anchor), 0, id);
      }
      return order.map((id) => current.get(id));
    }
    if (before.length !== after.length || before.length !== latest.length) {
      if (equal(before, latest)) return after;
      throw new Error('Unkeyed collection changed length while editing.');
    }
    return after.map((item, index) => mergeAuthoredValue(before[index], item, latest[index]));
  }
  if (
    before !== null &&
    after !== null &&
    latest !== null &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    typeof latest === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after) &&
    !Array.isArray(latest)
  ) {
    const result = { ...(latest as Record<string, unknown>) };
    const previous = before as Record<string, unknown>;
    const next = after as Record<string, unknown>;
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (equal(previous[key], next[key])) continue;
      if (!(key in next)) {
        if (!equal(previous[key], result[key]))
          throw new Error(`Field '${key}' changed while editing.`);
        delete result[key];
      } else if (!(key in previous)) {
        if (key in result) throw new Error(`Field '${key}' was already added.`);
        result[key] = next[key];
      } else result[key] = mergeAuthoredValue(previous[key], next[key], result[key]);
    }
    return result;
  }
  // When an earlier acknowledgment lands between two browser events, the
  // newer focused field intent wins. The authoritative native draft machinery
  // separately detects external-CAS conflicts and retains those in recovery.
  return after;
}

/** Ordinary controls stage only changed top-level fields. Coordinated changes
 * (e.g. Verb slot rename with its bindings and Offers) checkpoint the owner
 * and execute one late-bound, atomic semantic command instead. */
export function commitAuthoredRecord<T extends object>(options: {
  collection: Collection;
  id: string;
  before: T;
  after: T;
  fields: AuthoredRecordFields<T>;
  label: string;
}) {
  const { collection, id, before, after, fields, label } = options;
  const keys = (Object.keys(fields) as (keyof T)[]).filter(
    (key) => !equal(before[key], after[key]),
  );
  if (!keys.length) return;
  if (keys.length === 1) {
    const key = keys[0]!;
    const controller = fields[key];
    const draft = useNativeFieldDraftStore.getState().entries[controller.fieldKey];
    const acknowledged = useProjectStore.getState().document;
    const latest =
      draft?.value ??
      (acknowledged
        ? getJsonAtPointer(acknowledged, buildJsonPointer([collection, id, 'data', String(key)]))
        : controller.value);
    try {
      // Zod output can contain optional undefined members. Stage the canonical
      // JSON payload, not a pseudo-JSON object with implicit null coercions.
      controller.change(
        JSON.parse(
          JSON.stringify(mergeAuthoredValue(before[key], after[key], latest)),
        ) as JsonValue,
      );
    } catch {
      // A conflicting structural proposal cannot be safely staged as a patch.
      // Preserve its exact event-time payload in durable pending-input recovery.
      usePendingInputStore
        .getState()
        .setPendingInput(
          recordSaveUnitId(collection, id),
          buildJsonPointer([collection, id, 'data', '@conflict', String(key)]),
          { value: JSON.stringify(after[key]), diagnosticCode: 'editor.pending-input.conflict' },
        );
    }
    return;
  }
  const owner = recordSaveUnitId(collection, id);
  void (async () => {
    if (!(await projectEdits.flush(owner))) return;
    let error: string | null = null;
    try {
      const result = await projectEdits.execute(() => {
        const document = useProjectStore.getState().document;
        if (!document) throw new Error('The Project was closed before the edit.');
        const latest = getJsonAtPointer(document, buildJsonPointer([collection, id, 'data'])) as T;
        const next = { ...latest };
        for (const key of keys)
          next[key] = mergeAuthoredValue(before[key], after[key], latest[key]) as T[typeof key];
        // One native patch transaction owns the coordinated semantic change.
        // Whole-data replaceData would serialize normalized array members and
        // can break sparse YAML Save of a record with abbreviated references.
        const patches = keys.flatMap((key) =>
          authoredNativePatches(
            latest[key] as JsonValue,
            next[key] as JsonValue,
            buildJsonPointer([collection, id, 'data', String(key)]),
          ),
        );
        if (collection === 'verbs') {
          const rename = renamedVerbSlot(before as VerbData, after as VerbData);
          if (rename) {
            const interactions = (document as { interactions?: Record<string, { data: unknown }> })
              .interactions;
            for (const [interactionId, record] of Object.entries(interactions ?? {})) {
              const parsed = parseInteractionData(record.data);
              if (!parsed) continue;
              const nextRules = parsed.rules.map((rule) =>
                rule.verb.$ref.id === id
                  ? remapNamedSlotReferences(rule, rename.previousId, rename.nextId)
                  : rule,
              );
              patches.push(
                ...authoredNativePatches(
                  parsed.rules as JsonValue,
                  nextRules as JsonValue,
                  buildJsonPointer(['interactions', interactionId, 'data', 'rules']),
                ),
              );
            }
            // Test run-interaction steps bind the same named Verb slots. Keep
            // executable authored tests consistent with the renamed Verb and
            // its rule selectors in the very same native transaction.
            const tests = (document as { tests?: Record<string, { data: unknown }> }).tests;
            for (const [testId, record] of Object.entries(tests ?? {})) {
              const parsed = parseTestData(record.data);
              if (!parsed) continue;
              const nextSteps = parsed.steps.map((step) =>
                step.input === 'run-interaction' && step.runInteraction.verb?.$ref.id === id
                  ? remapNamedSlotReferences(step, rename.previousId, rename.nextId)
                  : step,
              );
              patches.push(
                ...authoredNativePatches(
                  parsed.steps as JsonValue,
                  nextSteps as JsonValue,
                  buildJsonPointer(['tests', testId, 'data', 'steps']),
                ),
              );
            }
          }
        }
        return {
          type: 'project.applyPatch',
          label,
          payload: patches,
          originSaveUnitId: owner,
          persistencePolicy: 'manual-save' as const,
        };
      });
      if (!result.ok) error = result.diagnostics[0]?.message ?? 'Native coordinated edit rejected.';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Native coordinated edit rejected.';
    }
    if (error)
      usePendingInputStore.getState().setPendingInput(owner, semanticPendingPath(collection, id), {
        value: JSON.stringify({ before, after, label, error }),
        diagnosticCode: 'editor.pending-input.semantic-rejected',
      });
  })();
}

/** A stable-ID recovery key for partial numbers in authored lists. The @id
 * segment never reaches a native JSON patch. */
export function AuthoredMemberNumber({
  collection,
  recordId,
  memberId: id,
  field,
  value,
  label,
  mode = 'decimal',
  min,
  onChange,
}: {
  collection: Collection;
  recordId: string;
  memberId: string;
  field: string;
  value: number;
  label: string;
  mode?: 'integer' | 'decimal';
  min?: number;
  onChange: (value: number) => void;
}) {
  const owner = recordSaveUnitId(collection, recordId);
  const path = buildJsonPointer([collection, recordId, 'data', '@' + id, field]);
  const pending = usePendingInputStore((state) => selectPendingInput(state, owner, path));
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Input
      aria-label={label}
      type="text"
      inputMode={mode === 'integer' ? 'numeric' : 'decimal'}
      aria-invalid={Boolean(pending)}
      value={editing ?? pending?.value ?? String(value)}
      onChange={(event) => {
        const raw = event.currentTarget.value;
        setEditing(raw);
        const number = parseProjectNumberText(raw, { mode, min });
        if (number === undefined) {
          usePendingInputStore.getState().setPendingInput(owner, path, {
            value: raw,
            diagnosticCode: 'editor.pending-input.number.invalid',
          });
        } else {
          usePendingInputStore.getState().clearPendingInput(owner, path);
          if (!Object.is(number, value)) onChange(number);
        }
      }}
      onBlur={() => setEditing(null)}
    />
  );
}

/** Identity is structural: editing it character by character would remount
 * keyed React rows and break references. Keep exact raw input in recovery,
 * and commit the coordinated rename once on blur. */
export function AuthoredMemberIdInput({
  collection,
  recordId,
  memberId: id,
  family,
  ids,
  onCommit,
  label,
}: {
  collection: Collection;
  recordId: string;
  memberId: string;
  family: string;
  ids: readonly string[];
  onCommit: (next: string) => void;
  label: string;
}) {
  const owner = recordSaveUnitId(collection, recordId);
  const path = buildJsonPointer([collection, recordId, 'data', family, '@' + id, 'id']);
  const pending = usePendingInputStore((state) => selectPendingInput(state, owner, path));
  const [editing, setEditing] = useState<string | null>(null);
  const commit = (raw: string) => {
    if (!isValidEntityId(raw) || (raw !== id && ids.includes(raw))) {
      usePendingInputStore.getState().setPendingInput(owner, path, {
        value: raw,
        diagnosticCode: 'editor.pending-input.id.invalid',
      });
      return;
    }
    usePendingInputStore.getState().clearPendingInput(owner, path);
    if (raw !== id) onCommit(raw);
    setEditing(null);
  };
  return (
    <Input
      aria-label={label}
      aria-invalid={Boolean(pending)}
      value={editing ?? pending?.value ?? id}
      onChange={(event) => {
        const raw = event.currentTarget.value;
        setEditing(raw);
        usePendingInputStore.getState().setPendingInput(owner, path, {
          value: raw,
          diagnosticCode: 'editor.pending-input.id.invalid',
        });
      }}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}
