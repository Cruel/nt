import { useCallback, useEffect, useRef, type ComponentProps } from 'react';
import { useCommandStore } from '@/commands/command-store';
import type { CommandRequest } from '@/commands/command-types';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { JsonValue } from '@/project/json-value';
import { useProjectStore } from '@/project/project-store';
import { restoredDraftPayload, useEditorDraftDirty } from '@/workbench/draft-dirty-store';
import {
  discardNativeField,
  flushNativeField,
  NATIVE_FIELD_DRAFT_SCHEMA,
  nativeFieldKey,
  stageNativeField,
  useNativeFieldDraftStore,
} from './native-field-drafts';

interface NativeFieldOptions<T extends JsonValue> {
  tabId: string;
  saveUnitId: string;
  path: string;
  value: T;
  label: string;
  buildCommand?: (next: T) => CommandRequest;
}

/** Local representation, shared across views of the same Project field. */
export function useNativeFieldDraft<T extends JsonValue>({
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
  const submit = useCallback(
    (next: JsonValue) =>
      useCommandStore.getState().executeCommandAsync(
        () =>
          buildCommand
            ? buildCommand(next as T)
            : {
                type: 'project.replaceAtPath',
                label,
                payload: { path, value: next },
                originSaveUnitId: saveUnitId,
                persistencePolicy: 'manual-save',
              },
        { bufferedField: true },
      ),
    [buildCommand, label, path, saveUnitId],
  );
  const change = useCallback(
    (next: T) => {
      if (!projectSessionId || !projectInstanceId) return;
      stageNativeField(
        { projectSessionId, projectInstanceId, saveUnitId, path, value: next },
        submit,
      );
    },
    [projectSessionId, projectInstanceId, saveUnitId, path, submit],
  );

  useEffect(() => {
    if (!projectSessionId || !projectInstanceId || hydratedKey.current === key) return;
    hydratedKey.current = key;
    if (restored !== undefined) change(restored);
  }, [key, restored, projectSessionId, projectInstanceId, change]);

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
    flush: () => flushNativeField(key),
    error: entry?.error ?? null,
  };
}

type NativeBufferedInputProps = Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> &
  NativeFieldOptions<string>;

export function NativeBufferedInput({
  tabId,
  saveUnitId,
  path,
  value,
  label,
  buildCommand,
  onBlur,
  ...inputProps
}: NativeBufferedInputProps) {
  const draft = useNativeFieldDraft({ tabId, saveUnitId, path, value, label, buildCommand });
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

type NativeBufferedSwitchProps = NativeFieldOptions<boolean> & {
  id?: string;
  'aria-label'?: string;
  disabled?: boolean;
  className?: string;
};

export function NativeBufferedSwitch({
  tabId,
  saveUnitId,
  path,
  value,
  label,
  buildCommand,
  ...switchProps
}: NativeBufferedSwitchProps) {
  const draft = useNativeFieldDraft({ tabId, saveUnitId, path, value, label, buildCommand });
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
