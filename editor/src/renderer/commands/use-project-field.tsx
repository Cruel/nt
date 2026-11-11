import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from 'react';
import type { CommandRequest } from '@/commands/command-types';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { JsonValue } from '@/project/json-value';
import { useProjectStore } from '@/project/project-store';
import { selectPendingInput, usePendingInputStore } from '@/workbench/pending-input-store';
import { restoredDraftPayload, useEditorDraftDirty } from '@/workbench/draft-dirty-store';
import {
  discardNativeField,
  flushNativeField,
  NATIVE_FIELD_DRAFT_SCHEMA,
  nativeFieldKey,
  useNativeFieldDraftStore,
} from './native-field-drafts';
import { projectEdits } from './project-editing';
import { measureProjectEdit } from './project-edit-timings';

interface NativeFieldOptions<T extends JsonValue> {
  tabId: string;
  saveUnitId: string;
  path: string;
  value: T;
  label: string;
  buildCommand?: (next: T) => CommandRequest;
}

/** Local representation, shared across views of the same Project field. */
export function useProjectField<T extends JsonValue>({
  tabId,
  saveUnitId,
  path,
  value,
  label,
  buildCommand,
}: NativeFieldOptions<T>) {
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const projectInstanceId = useProjectStore((state) => state.projectInstanceId);
  const key = nativeFieldKey(projectSessionId ?? '', projectInstanceId ?? '', path);
  const entry = useNativeFieldDraftStore((state) => state.entries[key]);
  const draftKey = `${tabId}:native-field:${path}`;
  const restored = !entry
    ? restoredDraftPayload<T>(draftKey, NATIVE_FIELD_DRAFT_SCHEMA)
    : undefined;
  const hydratedKey = useRef<string | null>(null);
  const change = useCallback(
    (next: T) => {
      if (!projectSessionId || !projectInstanceId) return;
      projectEdits.field({ tabId, saveUnitId, path, value: next, label, buildCommand });
    },
    [projectSessionId, projectInstanceId, tabId, saveUnitId, path, label, buildCommand],
  );

  useEffect(() => {
    if (!projectSessionId || !projectInstanceId || hydratedKey.current === key) return;
    hydratedKey.current = key;
    if (restored !== undefined) change(restored);
  }, [key, restored, projectSessionId, projectInstanceId, change]);

  const inputSequence = entry?.sequence;
  const inputStartedAt = entry?.inputStartedAt;
  useLayoutEffect(() => {
    if (
      inputSequence === undefined ||
      inputStartedAt === undefined ||
      typeof window.requestAnimationFrame !== 'function'
    )
      return;
    // React has committed the immediate overlay before the next paint.
    // Measure readiness on that frame, independently from native IPC.
    const frame = window.requestAnimationFrame(() =>
      measureProjectEdit('input-to-paint-ready', inputStartedAt, { path, sequence: inputSequence }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [inputSequence, inputStartedAt, path]);

  useEditorDraftDirty(tabId, Boolean(entry || restored !== undefined), {
    key: draftKey,
    schema: NATIVE_FIELD_DRAFT_SCHEMA,
    label,
    payload: entry?.value ?? restored,
    apply: () => flushNativeField(key),
    discard: () => {
      discardNativeField(key);
      return true;
    },
    preserveOnUnmount: true,
  });

  return {
    value: (entry?.value ?? restored ?? value) as T,
    change,
    flush: () => projectEdits.flushField(path),
    error: entry?.error ?? null,
  };
}

type ProjectFieldInputProps = Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> &
  NativeFieldOptions<string>;

export function ProjectFieldInput({
  tabId,
  saveUnitId,
  path,
  value,
  label,
  buildCommand,
  onBlur,
  ...inputProps
}: ProjectFieldInputProps) {
  const draft = useProjectField({ tabId, saveUnitId, path, value, label, buildCommand });
  return (
    <>
      <Input
        {...inputProps}
        aria-invalid={draft.error !== null || inputProps['aria-invalid']}
        value={draft.value}
        onChange={(event) => draft.change(event.currentTarget.value)}
        onBlur={(event) => {
          onBlur?.(event);
          void draft.flush();
        }}
      />
      {draft.error && (
        <p role="alert" className="text-destructive text-xs">
          {draft.error}{' '}
          <button type="button" className="underline" onClick={() => void draft.flush()}>
            Retry
          </button>
        </p>
      )}
    </>
  );
}

type ProjectFieldSwitchProps = NativeFieldOptions<boolean> & {
  id?: string;
  'aria-label'?: string;
  disabled?: boolean;
  className?: string;
};

export function ProjectFieldSwitch({
  tabId,
  saveUnitId,
  path,
  value,
  label,
  buildCommand,
  ...switchProps
}: ProjectFieldSwitchProps) {
  const draft = useProjectField({ tabId, saveUnitId, path, value, label, buildCommand });
  return (
    <>
      <Switch
        {...switchProps}
        checked={draft.value}
        onCheckedChange={(checked) => draft.change(Boolean(checked))}
        onBlur={() => void draft.flush()}
      />
      {draft.error && <span role="alert">{draft.error}</span>}
    </>
  );
}

type ProjectFieldTextareaProps = Omit<ComponentProps<'textarea'>, 'value' | 'onChange'> &
  NativeFieldOptions<string>;

/** The same Project mutation contract for raw textarea and custom forms. */
export function ProjectFieldTextarea({
  tabId,
  saveUnitId,
  path,
  value,
  label,
  buildCommand,
  onBlur,
  ...props
}: ProjectFieldTextareaProps) {
  const draft = useProjectField({ tabId, saveUnitId, path, value, label, buildCommand });
  return (
    <>
      <textarea
        {...props}
        aria-invalid={draft.error !== null || props['aria-invalid']}
        value={draft.value}
        onChange={(event) => draft.change(event.currentTarget.value)}
        onBlur={(event) => {
          onBlur?.(event);
          void draft.flush();
        }}
      />
      {draft.error && (
        <p role="alert" className="text-destructive text-xs">
          {draft.error}{' '}
          <button type="button" className="underline" onClick={() => void draft.flush()}>
            Retry
          </button>
        </p>
      )}
    </>
  );
}

type ProjectFieldSelectProps<T extends JsonValue> = NativeFieldOptions<T> & {
  children: ReactNode;
  disabled?: boolean;
};

export function ProjectFieldSelect<T extends JsonValue>({
  tabId,
  saveUnitId,
  path,
  value,
  label,
  buildCommand,
  children,
  disabled,
}: ProjectFieldSelectProps<T>) {
  const draft = useProjectField({ tabId, saveUnitId, path, value, label, buildCommand });
  return (
    <>
      <Select
        value={draft.value}
        disabled={disabled}
        onValueChange={(next) => draft.change(next as T)}
      >
        {children}
      </Select>
      {draft.error && <span role="alert">{draft.error}</span>}
    </>
  );
}

type ProjectFieldNumberProps = Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  mode?: 'integer' | 'decimal';
  optional?: boolean;
} & NativeFieldOptions<number | null>;

/** Nonrepresentable numeric text stays in existing recoverable pending-input state.
 * Complete values go through the identical optimistic Project field scheduler. */
export function ProjectFieldNumber({
  tabId,
  saveUnitId,
  path,
  value,
  label,
  buildCommand,
  mode = 'integer',
  optional = false,
  onBlur,
  ...props
}: ProjectFieldNumberProps) {
  const draft = useProjectField({ tabId, saveUnitId, path, value, label, buildCommand });
  const pending = usePendingInputStore((state) => selectPendingInput(state, saveUnitId, path));
  const raw = pending?.value ?? (draft.value === null ? '' : String(draft.value));
  return (
    <>
      <Input
        {...props}
        // Native number inputs discard intermediate strings such as '-' and
        // '2.'. Preserve exactly what was typed until it parses as complete.
        type="text"
        inputMode={mode === 'integer' ? 'numeric' : 'decimal'}
        aria-invalid={Boolean(pending || draft.error || props['aria-invalid'])}
        value={raw}
        onChange={(event) => {
          const text = event.currentTarget.value;
          const complete =
            mode === 'integer'
              ? /^[+-]?\d+$/.test(text)
              : /^[+-]?(?:\d+|\d+\.\d+|\.\d+)$/.test(text);
          const parsed = Number(text);
          const inRange =
            (props.min === undefined || parsed >= Number(props.min)) &&
            (props.max === undefined || parsed <= Number(props.max));
          if (optional && text === '') {
            usePendingInputStore.getState().clearPendingInput(saveUnitId, path);
            draft.change(null);
          } else if (
            complete &&
            (mode !== 'integer' || Number.isSafeInteger(parsed)) &&
            Number.isFinite(parsed) &&
            inRange
          ) {
            usePendingInputStore.getState().clearPendingInput(saveUnitId, path);
            draft.change(parsed);
          } else {
            usePendingInputStore.getState().setPendingInput(saveUnitId, path, {
              value: text,
              diagnosticCode: 'editor.pending-input.number.invalid',
            });
          }
        }}
        onBlur={(event) => {
          onBlur?.(event);
          void draft.flush();
        }}
      />
      {draft.error && (
        <p role="alert" className="text-destructive text-xs">
          {draft.error}{' '}
          <button type="button" className="underline" onClick={() => void draft.flush()}>
            Retry
          </button>
        </p>
      )}
    </>
  );
}
