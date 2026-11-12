import type { ComponentProps, ReactNode } from 'react';
import { buildJsonPointer, parseJsonPointer } from '@/project/json-pointer';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import type { JsonValue } from '@/project/json-value';
import { projectEdits } from './project-editing';
import type { GameplayRecordRef } from './gameplay-record-descriptors';
import {
  ProjectFieldError,
  ProjectFieldNumber,
  ProjectFieldInput,
  ProjectFieldSelect,
  ProjectFieldSwitch,
  type ProjectFieldController,
  useProjectField,
} from './use-project-field';

interface GameplayField<T extends JsonValue> {
  record: GameplayRecordRef;
  field: string;
  tabId: string;
  value: T;
  label: string;
}

/** One owner/path/command binding for Room, Character, and Interactable fields.
 * Only stable object fields are eligible; array items use semantic recordList
 * operations rather than positional optimistic overlays. */
export function gameplayFieldOptions<T extends JsonValue>({
  record,
  field,
  tabId,
  value,
  label,
}: GameplayField<T>) {
  const segments = parseJsonPointer(field);
  if (
    !field.startsWith('/') ||
    !segments.length ||
    buildJsonPointer(segments) !== field ||
    segments.some((segment) => /^(0|[1-9]\d*)$/u.test(segment))
  )
    throw new Error(`Invalid relative record field path: ${field}`);
  return {
    tabId,
    saveUnitId: recordSaveUnitId(record.collection, record.id),
    path: buildJsonPointer([record.collection, record.id, 'data', ...segments]),
    value,
    label,
    buildCommand: (next: T) => projectEdits.recordField({ record, field, value: next, label }),
  };
}

export function useGameplayRecordField<T extends JsonValue>(
  options: GameplayField<T>,
): ProjectFieldController<T> {
  return useProjectField(gameplayFieldOptions(options));
}

type GameplayInputProps = Omit<
  ComponentProps<typeof ProjectFieldInput>,
  'path' | 'saveUnitId' | 'buildCommand'
> & { record: GameplayRecordRef; field: string };

export function GameplayFieldInput({ record, field, ...props }: GameplayInputProps) {
  return <ProjectFieldInput {...props} {...gameplayFieldOptions({ record, field, ...props })} />;
}

type GameplayNumberProps = Omit<
  ComponentProps<typeof ProjectFieldNumber>,
  'path' | 'saveUnitId' | 'buildCommand'
> & { record: GameplayRecordRef; field: string };

export function GameplayFieldNumber({ record, field, ...props }: GameplayNumberProps) {
  return <ProjectFieldNumber {...props} {...gameplayFieldOptions({ record, field, ...props })} />;
}

type GameplaySwitchProps = Omit<
  ComponentProps<typeof ProjectFieldSwitch>,
  'path' | 'saveUnitId' | 'buildCommand'
> & { record: GameplayRecordRef; field: string };

export function GameplayFieldSwitch({ record, field, ...props }: GameplaySwitchProps) {
  return <ProjectFieldSwitch {...props} {...gameplayFieldOptions({ record, field, ...props })} />;
}

/** Preserve the native checkbox presentation in editors that do not use a
 * Switch, while sharing the same immediate optimistic field lifecycle. */
type GameplayCheckboxProps = Omit<
  ComponentProps<'input'>,
  'value' | 'checked' | 'type' | 'onChange'
> &
  GameplayField<boolean>;

export function GameplayFieldCheckbox({
  record,
  field,
  tabId,
  value,
  label,
  onBlur,
  ...props
}: GameplayCheckboxProps) {
  const draft = useGameplayRecordField({ record, field, tabId, value, label });
  return (
    <>
      <input
        {...props}
        type="checkbox"
        checked={draft.value}
        aria-invalid={Boolean(draft.error || props['aria-invalid'])}
        onChange={(event) => {
          draft.change(event.currentTarget.checked);
          draft.endSession();
        }}
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

type GameplaySelectProps = {
  record: GameplayRecordRef;
  field: string;
  tabId: string;
  label: string;
  value: string;
  children: ReactNode;
  disabled?: boolean;
};

export function GameplayFieldSelect({ record, field, ...props }: GameplaySelectProps) {
  return <ProjectFieldSelect {...props} {...gameplayFieldOptions({ record, field, ...props })} />;
}
