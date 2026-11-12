import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import type { CommandRequest } from '@/commands/command-types';
import { Input } from '@/components/ui/input';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { JsonValue } from '@/project/json-value';
import { useProjectStore } from '@/project/project-store';
import { selectPendingInput, usePendingInputStore } from '@/workbench/pending-input-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import {
  NATIVE_FIELD_DRAFT_SCHEMA,
  nativeFieldDraftKey,
  nativeFieldKey,
  parseNativeFieldRecovery,
  useNativeFieldDraftStore,
} from './native-field-drafts';
import { projectEdits } from './project-editing';
import { parseProjectNumberText } from './project-number-input';
import { measureProjectEdit } from './project-edit-timings';
import type { ProjectFieldIdentity } from './project-field-identity';

interface NativeFieldOptions<T extends JsonValue> {
  tabId: string;
  saveUnitId: string;
  path: string;
  value: T;
  label: string;
  buildCommand?: (next: T) => CommandRequest;
}

/** Stable control-facing contract. Native command acknowledgments, not the
 * optimistic presentation overlay, determine when a value is committed. */
export interface ProjectFieldController<T extends JsonValue> {
  readonly identity: ProjectFieldIdentity;
  readonly value: T;
  readonly status: 'acknowledged' | 'pending' | 'conflict' | 'error';
  readonly conflict: boolean;
  readonly error: string | null;
  readonly sequence: number | undefined;
  readonly latestSequence: number | undefined;
  readonly fieldKey: string;
  readonly change: (next: T) => void;
  readonly flush: () => Promise<boolean>;
  readonly endSession: () => void;
  readonly useCurrent: () => Promise<boolean>;
  readonly keepMine: () => Promise<boolean>;
}

/** Local representation, shared across views of the same Project field. */
export function useProjectField<T extends JsonValue>({
  tabId,
  saveUnitId,
  path,
  value,
  label,
  buildCommand,
}: NativeFieldOptions<T>): ProjectFieldController<T> {
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const projectInstanceId = useProjectStore((state) => state.projectInstanceId);
  const key = nativeFieldKey(projectSessionId ?? '', projectInstanceId ?? '', path);
  const entry = useNativeFieldDraftStore((state) => state.entries[key]);
  const latestSequence = useNativeFieldDraftStore((state) => state.latestSequenceByKey[key]);
  const draftKey = nativeFieldDraftKey(saveUnitId, path);
  const savedDraft = useDraftDirtyStore((state) => state.entriesByKey[draftKey]);
  const restored =
    !entry && savedDraft?.schema === NATIVE_FIELD_DRAFT_SCHEMA
      ? parseNativeFieldRecovery(savedDraft.payload)
      : null;
  const hydratedKey = useRef<string | null>(null);
  // Inline buildCommand closures and labels can change on every parent render;
  // keep the input handler stable while always submitting the latest options.
  const intentRef = useRef({ tabId, saveUnitId, path, label, buildCommand });
  intentRef.current = { tabId, saveUnitId, path, label, buildCommand };
  const change = useCallback(
    (next: T) => {
      if (!projectSessionId || !projectInstanceId) return;
      projectEdits.field({ ...intentRef.current, value: next });
    },
    [projectSessionId, projectInstanceId],
  );

  useEffect(() => {
    if (
      !projectSessionId ||
      !projectInstanceId ||
      entry ||
      !restored ||
      hydratedKey.current === key
    )
      return;
    hydratedKey.current = key;
    projectEdits.field({
      tabId,
      saveUnitId,
      path,
      value: restored.value as T,
      restoredBase: restored.base,
      label,
      buildCommand,
    });
  }, [
    key,
    entry,
    restored,
    projectSessionId,
    projectInstanceId,
    tabId,
    saveUnitId,
    path,
    label,
    buildCommand,
  ]);

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

  return {
    identity: {
      projectSessionId: projectSessionId ?? '',
      projectInstanceId: projectInstanceId ?? '',
      saveUnitId,
      path,
    },
    value: (entry ? entry.value : restored ? restored.value : value) as T,
    status: entry?.conflict
      ? 'conflict'
      : entry?.error
        ? 'error'
        : entry || restored
          ? 'pending'
          : 'acknowledged',
    change,
    flush: () => projectEdits.flushField(path),
    endSession: () => projectEdits.endFieldSession(path),
    useCurrent: () => projectEdits.useCurrentField(path),
    keepMine: () => projectEdits.keepMineField(path),
    conflict: entry?.conflict ?? false,
    sequence: entry?.sequence,
    latestSequence,
    fieldKey: key,
    error: entry?.error ?? null,
  };
}

/** Shared localized presentation for all native field errors and retries. */
export function ProjectFieldError({
  field,
}: {
  field: Pick<
    ReturnType<typeof useProjectField>,
    'error' | 'conflict' | 'flush' | 'useCurrent' | 'keepMine'
  >;
}) {
  const { t } = useTranslation('workspace');
  if (!field.error) return null;
  return (
    <p role="alert" className="text-destructive text-xs">
      {field.error}{' '}
      {field.conflict ? (
        <>
          <button type="button" className="underline" onClick={() => void field.useCurrent()}>
            {t('projectField.useCurrent')}
          </button>{' '}
          <button type="button" className="underline" onClick={() => void field.keepMine()}>
            {t('projectField.keepMine')}
          </button>
        </>
      ) : (
        <button type="button" className="underline" onClick={() => void field.flush()}>
          {t('projectField.retry')}
        </button>
      )}
    </p>
  );
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
          draft.endSession();
          void draft.flush();
        }}
      />
      <ProjectFieldError field={draft} />
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
        onCheckedChange={(checked) => {
          draft.change(Boolean(checked));
          draft.endSession();
        }}
        onBlur={() => {
          draft.endSession();
          void draft.flush();
        }}
      />
      <ProjectFieldError field={draft} />
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
          draft.endSession();
          void draft.flush();
        }}
      />
      <ProjectFieldError field={draft} />
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
        onValueChange={(next) => {
          draft.change(next as T);
          draft.endSession();
        }}
      >
        {children}
      </Select>
      <ProjectFieldError field={draft} />
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
  // A valid numeric value does not imply that its exact in-progress text can be
  // reconstructed (1.0, +1, 01 and 2. must remain intact while editing).
  const editingKey = nativeFieldDraftKey(saveUnitId, path);
  const fieldKey = draft.fieldKey;
  const [editingText, setEditingText] = useState<{
    key: string;
    fieldKey: string;
    text: string;
    sequence?: number;
    pendingValue?: string;
    parsed?: number | null;
  } | null>(null);
  const composing = useRef(false);
  // The exact representation belongs only to this editing generation. A
  // sibling's newer field intent or raw-input correction takes precedence.
  const ownPresentation =
    editingText?.key === editingKey &&
    editingText.fieldKey === fieldKey &&
    editingText.sequence === draft.latestSequence &&
    editingText.pendingValue === pending?.value &&
    (composing.current ||
      editingText.sequence === draft.sequence ||
      (draft.sequence === undefined &&
        editingText.parsed !== undefined &&
        Object.is(editingText.parsed, draft.value)));
  const raw =
    (ownPresentation ? editingText?.text : null) ??
    pending?.value ??
    (draft.value === null ? '' : String(draft.value));
  const updateNumber = (text: string) => {
    let parsedValue: number | null | undefined;
    if (composing.current) {
      setEditingText({
        key: editingKey,
        fieldKey,
        text,
        sequence: draft.latestSequence,
        pendingValue: pending?.value,
      });
      return;
    }
    const parsed = parseProjectNumberText(text, {
      mode,
      min: props.min === undefined ? undefined : Number(props.min),
      max: props.max === undefined ? undefined : Number(props.max),
    });
    if (optional && text === '') {
      usePendingInputStore.getState().clearPendingInput(saveUnitId, path);
      draft.change(null);
      parsedValue = null;
    } else if (parsed !== undefined) {
      usePendingInputStore.getState().clearPendingInput(saveUnitId, path);
      draft.change(parsed);
      parsedValue = parsed;
    } else {
      usePendingInputStore.getState().setPendingInput(saveUnitId, path, {
        value: text,
        diagnosticCode: 'editor.pending-input.number.invalid',
      });
    }
    setEditingText({
      key: editingKey,
      fieldKey,
      text,
      sequence: useNativeFieldDraftStore.getState().latestSequenceByKey[fieldKey],
      pendingValue: selectPendingInput(usePendingInputStore.getState(), saveUnitId, path)?.value,
      parsed: parsedValue,
    });
  };
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
        onChange={(event) => updateNumber(event.currentTarget.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          updateNumber(event.currentTarget.value);
        }}
        onBlur={(event) => {
          onBlur?.(event);
          setEditingText(null);
          draft.endSession();
          void draft.flush();
        }}
      />
      <ProjectFieldError field={draft} />
    </>
  );
}
