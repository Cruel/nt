import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from 'react-i18next';
import { PropertyEditDialog } from './PropertyEditDialog';
import { PropertyTable, type PropertyManagerRow } from './PropertyTable';
import {
  TraitAttachments,
  type PropertyManagerTraitAttachment,
  type PropertyManagerTraitChoice,
} from './TraitAttachments';
import {
  newTypedPropertyDraft,
  typedPropertyDraftForSchema,
  type TypedPropertyDraft,
} from './property-editor-draft';

export interface PropertyManagerState {
  editing:
    | { kind: 'create'; draft: TypedPropertyDraft }
    | { kind: 'row'; rowId: string; mode: 'schema' | 'value'; draft: TypedPropertyDraft }
    | null;
  deleteId: string | null;
  traitId: string;
}

export function newPropertyManagerState(): PropertyManagerState {
  return { editing: null, deleteId: null, traitId: '' };
}

export interface PropertyManagerTraitModel {
  attached: readonly PropertyManagerTraitAttachment[];
  available: readonly PropertyManagerTraitChoice[];
  onAttach: (traitId: string) => string | null | void;
  onDetach: (traitId: string) => string | null | void;
}

export interface PropertyManagerProps {
  title?: string;
  description?: string;
  count?: boolean;
  propertyColumnLabel?: string;
  valueLabel: string;
  valueOptional?: boolean;
  rows: readonly PropertyManagerRow[];
  emptyLabel: string;
  addLabel?: string;
  createSubmitLabel?: string;
  createTitle?: string;
  editTitle?: (row: PropertyManagerRow) => string;
  valueEditTitle?: (row: PropertyManagerRow) => string;
  editDescription?: (row?: PropertyManagerRow) => string | undefined;
  descriptionPlaceholder?: string;
  newDraft?: () => TypedPropertyDraft;
  onCreate?: (draft: TypedPropertyDraft) => string | null | void;
  onEdit?: (row: PropertyManagerRow, draft: TypedPropertyDraft) => string | null | void;
  onSetValue?: (row: PropertyManagerRow, draft: TypedPropertyDraft) => string | null | void;
  onReset?: (row: PropertyManagerRow) => string | null | void;
  onDelete?: (row: PropertyManagerRow) => string | null | void;
  deleteMessage?: (row: PropertyManagerRow) => string;
  onMove?: (row: PropertyManagerRow, direction: 'up' | 'down') => string | null | void;
  onShowUsages?: (row: PropertyManagerRow) => void;
  traits?: PropertyManagerTraitModel;
  compact?: boolean;
  className?: string;
  anchor?: string;
  modeMarker?: string;
  rowAnchor?: (row: PropertyManagerRow) => string | undefined;
  state?: PropertyManagerState;
  onStateChange?: (state: PropertyManagerState) => void;
}

function resultMessage(result: string | null | void) {
  return typeof result === 'string' && result ? result : null;
}

export function PropertyManager(props: PropertyManagerProps) {
  const { t } = useTranslation('workspace');
  const [internalState, setInternalState] = useState<PropertyManagerState>(newPropertyManagerState);
  const [message, setMessage] = useState<string | null>(null);
  const state = props.state ?? internalState;
  const setState = (next: PropertyManagerState) => {
    if (props.onStateChange) props.onStateChange(next);
    else setInternalState(next);
  };
  const updateState = (patch: Partial<PropertyManagerState>) => setState({ ...state, ...patch });
  const activeEditing = state.editing;
  const editingRow =
    activeEditing?.kind === 'row'
      ? (props.rows.find((row) => row.id === activeEditing.rowId) ?? null)
      : null;
  const deleteRow = state.deleteId
    ? (props.rows.find((row) => row.id === state.deleteId) ?? null)
    : null;

  const openCreate = () => {
    setMessage(null);
    updateState({
      editing: { kind: 'create', draft: props.newDraft?.() ?? newTypedPropertyDraft() },
    });
  };
  const openRow = (row: PropertyManagerRow) => {
    if (!row.editMode) return;
    setMessage(null);
    updateState({
      editing: {
        kind: 'row',
        rowId: row.id,
        mode: row.editMode,
        draft: typedPropertyDraftForSchema(
          row,
          row.value,
          props.valueOptional ? row.valueState !== 'missing' : true,
        ),
      },
    });
  };
  const closeEditing = () => {
    setMessage(null);
    updateState({ editing: null });
  };
  const openDelete = (row: PropertyManagerRow) => {
    setMessage(null);
    updateState({ deleteId: row.id });
  };
  const closeDelete = () => {
    setMessage(null);
    updateState({ deleteId: null });
  };
  const submit = () => {
    const editing = state.editing;
    if (!editing) return;
    const failure =
      editing.kind === 'create'
        ? resultMessage(props.onCreate?.(editing.draft))
        : editing.mode === 'schema'
          ? resultMessage(
              editingRow
                ? props.onEdit?.(editingRow, editing.draft)
                : t('propertyManager.errors.propertyMissing'),
            )
          : resultMessage(
              editingRow
                ? props.onSetValue?.(editingRow, editing.draft)
                : t('propertyManager.errors.propertyMissing'),
            );
    if (failure) {
      setMessage(failure);
      return;
    }
    closeEditing();
  };
  const perform = (action: () => string | null | void) => {
    const failure = resultMessage(action());
    if (failure) setMessage(failure);
    else setMessage(null);
    return !failure;
  };

  const editing = state.editing;
  const defaultValueEditTitle = t('propertyManager.setValue', { label: props.valueLabel });
  const defaultNamedEditTitle = editingRow
    ? t('propertyManager.editNamedProperty', { property: editingRow.label ?? editingRow.id })
    : t('propertyManager.editProperty');
  const editTitle = !editing
    ? t('propertyManager.editProperty')
    : editing.kind === 'create'
      ? (props.createTitle ?? props.addLabel ?? t('propertyManager.addProperty'))
      : editingRow
        ? editing.mode === 'value'
          ? (props.valueEditTitle?.(editingRow) ?? defaultValueEditTitle)
          : (props.editTitle?.(editingRow) ?? defaultNamedEditTitle)
        : t('propertyManager.editProperty');
  const submitLabel =
    editing?.kind === 'create'
      ? (props.createSubmitLabel ?? props.addLabel ?? t('propertyManager.addProperty'))
      : t('propertyManager.saveChanges');

  return (
    <section
      className={`space-y-3 rounded-md border ${props.compact ? 'p-2' : 'p-3'} ${props.className ?? ''}`}
      data-workbench-anchor={props.anchor}
      data-property-manager-mode={props.modeMarker}
    >
      {props.title || props.description || props.onCreate ? (
        <div className="flex items-start justify-between gap-3">
          <div>
            {props.title ? (
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">{props.title}</h3>
                {props.count ? <Badge variant="outline">{props.rows.length}</Badge> : null}
              </div>
            ) : null}
            {props.description ? (
              <p className="text-xs text-muted-foreground">{props.description}</p>
            ) : null}
          </div>
          {props.onCreate ? (
            <Button size="sm" variant={props.compact ? 'outline' : 'default'} onClick={openCreate}>
              <Plus className="size-4" /> {props.addLabel ?? t('propertyManager.addProperty')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {props.traits ? (
        <TraitAttachments
          attached={props.traits.attached}
          available={props.traits.available}
          selectedId={state.traitId}
          onSelectedIdChange={(traitId) => updateState({ traitId })}
          onAttach={(traitId) => {
            if (perform(() => props.traits!.onAttach(traitId))) updateState({ traitId: '' });
          }}
          onDetach={(traitId) => perform(() => props.traits!.onDetach(traitId))}
          compact={props.compact}
        />
      ) : null}

      <PropertyTable
        rows={props.rows}
        propertyColumnLabel={props.propertyColumnLabel}
        valueColumnLabel={props.valueLabel}
        emptyLabel={props.emptyLabel}
        onEdit={openRow}
        onReset={(row) => perform(() => props.onReset?.(row))}
        onDelete={openDelete}
        onMove={
          props.onMove
            ? (row, direction) => perform(() => props.onMove!(row, direction))
            : undefined
        }
        onShowUsages={props.onShowUsages}
        rowAnchor={props.rowAnchor}
      />

      {message && !editing ? <p className="text-xs text-destructive">{message}</p> : null}

      {editing ? (
        <PropertyEditDialog
          open
          mode={editing.kind === 'create' ? 'schema' : editing.mode}
          draft={editing.draft}
          title={editTitle}
          description={props.editDescription?.(editingRow ?? undefined)}
          submitLabel={submitLabel}
          valueLabel={props.valueLabel}
          valueOptional={props.valueOptional}
          descriptionPlaceholder={props.descriptionPlaceholder}
          message={message}
          onDraftChange={(draft) =>
            updateState({
              editing: editing.kind === 'create' ? { ...editing, draft } : { ...editing, draft },
            })
          }
          onOpenChange={(open) => !open && closeEditing()}
          onSubmit={submit}
        />
      ) : null}

      <Dialog open={deleteRow !== null} onOpenChange={(open) => !open && closeDelete()}>
        <DialogPopup className="w-[min(520px,calc(100vw-2rem))]">
          <DialogTitle>{t('propertyManager.delete.title')}</DialogTitle>
          <DialogDescription>
            {deleteRow
              ? (props.deleteMessage?.(deleteRow) ??
                (deleteRow.usageCount
                  ? t('propertyManager.delete.used', {
                      id: deleteRow.id,
                      count: deleteRow.usageCount,
                    })
                  : t('propertyManager.delete.unused', { id: deleteRow.id })))
              : ''}
          </DialogDescription>
          {message ? <p className="text-xs text-destructive">{message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeDelete}>
              {t('propertyManager.actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deleteRow) return;
                if (perform(() => props.onDelete?.(deleteRow))) closeDelete();
              }}
            >
              {t('propertyManager.delete.action')}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </section>
  );
}

export type { PropertyManagerRow } from './PropertyTable';
