import { useMemo, useState } from 'react';
import { Braces, Hash, List, Plus, Text, ToggleLeft, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useCommandStore } from '@/commands/command-store';
import type { CommandRequest } from '@/commands/command-types';
import { SAVE_UNIT_IDS } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import { useEntityUsagesStore } from '@/project/entity-usages-store';
import { buildReferenceIndex, findUsages } from '@/project/reference-index';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  useWorkbenchEditorTabState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';
import {
  isAuthoringProject,
  type AuthoringRecordBase,
} from '../../../shared/project-schema/authoring-project';
import {
  defaultVariableData,
  parseEnumValuesText,
  parseVariableData,
  parseVariableDefaultText,
  variableDefaultValueToText,
  variableTypeValues,
  type VariableData,
  type VariableType,
} from '../../../shared/project-schema/authoring-variables';

function typeLabel(type: VariableType) {
  if (type === 'boolean') return 'Boolean';
  if (type === 'integer') return 'Integer';
  if (type === 'number') return 'Number';
  if (type === 'string') return 'String';
  return 'Enum';
}

function typeIcon(type: VariableType) {
  if (type === 'boolean') return ToggleLeft;
  if (type === 'integer' || type === 'number') return Hash;
  if (type === 'string') return Text;
  if (type === 'enum') return List;
  return Braces;
}

function formatDefault(data: VariableData) {
  if (data.type === 'string')
    return data.defaultValue === '' ? 'Empty string' : JSON.stringify(data.defaultValue);
  return variableDefaultValueToText(data.defaultValue);
}

interface VariableDraft {
  id: string;
  label: string;
  description: string;
  type: VariableType;
  defaultText: string;
  enumText: string;
}

function draftForNewVariable(): VariableDraft {
  return {
    id: '',
    label: '',
    description: '',
    type: 'boolean',
    defaultText: 'false',
    enumText: 'default',
  };
}

function draftForVariable(
  id: string,
  record: AuthoringRecordBase,
  data: VariableData,
): VariableDraft {
  return {
    id,
    label: record.label === id ? '' : record.label,
    description: record.description ?? '',
    type: data.type,
    defaultText: variableDefaultValueToText(data.defaultValue),
    enumText: data.enumValues?.join(', ') ?? 'default',
  };
}

function dataFromDraft(
  draft: VariableDraft,
): { ok: true; data: VariableData } | { ok: false; message: string } {
  const enumValues = draft.type === 'enum' ? parseEnumValuesText(draft.enumText) : undefined;
  if (draft.type === 'enum' && (!enumValues || enumValues.length === 0)) {
    return { ok: false, message: 'Enum variables require at least one value.' };
  }
  const parsed = parseVariableDefaultText(draft.type, draft.defaultText, enumValues);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    data: {
      ...defaultVariableData(draft.type),
      ...(enumValues ? { enumValues } : {}),
      defaultValue: parsed.value,
    },
  };
}

function VariableDialog({
  open,
  initialDraft,
  title,
  submitLabel,
  onOpenChange,
  onSubmit,
  draft,
  onDraftChange,
}: {
  open: boolean;
  initialDraft: VariableDraft;
  title: string;
  submitLabel: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: VariableDraft) => string | null;
  draft: VariableDraft;
  onDraftChange: (draft: VariableDraft) => void;
}) {
  const [message, setMessage] = useState<string | null>(null);

  const reset = () => {
    onDraftChange(initialDraft);
    setMessage(null);
  };

  const changeType = (type: VariableType) => {
    const defaults = defaultVariableData(type);
    onDraftChange({
      ...draft,
      type,
      defaultText: variableDefaultValueToText(defaults.defaultValue),
      enumText: type === 'enum' ? 'default' : draft.enumText,
    });
  };

  const submit = () => {
    const failure = onSubmit(draft);
    if (failure) {
      setMessage(failure);
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) reset();
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="w-[min(560px,calc(100vw-2rem))]">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          Variables are referenced from Lua and expressions by ID.
        </DialogDescription>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>ID</Label>
            <Input
              autoFocus
              className="font-mono"
              value={draft.id}
              onChange={(event) => {
                const id = event.currentTarget.value;
                onDraftChange({ ...draft, id });
              }}
              placeholder="has-key"
            />
          </div>
          <div className="space-y-1.5">
            <Label>
              Label <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              value={draft.label}
              onChange={(event) => {
                const label = event.currentTarget.value;
                onDraftChange({ ...draft, label });
              }}
              placeholder="Uses the ID when empty"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>
            Description <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            value={draft.description}
            onChange={(event) => {
              const description = event.currentTarget.value;
              onDraftChange({ ...draft, description });
            }}
            placeholder="What this variable represents"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select
              value={draft.type}
              onValueChange={(value) => value && changeType(value as VariableType)}
            >
              <SelectTrigger className="!h-8 w-full" aria-label="Type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {variableTypeValues.map((type) => (
                  <SelectItem key={type} value={type}>
                    {typeLabel(type)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Default value</Label>
            {draft.type === 'boolean' ? (
              <div className="flex h-8 items-center gap-2">
                <Switch
                  checked={draft.defaultText === 'true'}
                  onCheckedChange={(checked) =>
                    onDraftChange({ ...draft, defaultText: String(checked) })
                  }
                  aria-label="Default value"
                />
                <span className="text-sm text-muted-foreground">{draft.defaultText}</span>
              </div>
            ) : draft.type === 'enum' ? (
              <Select
                value={draft.defaultText}
                onValueChange={(value) => value && onDraftChange({ ...draft, defaultText: value })}
              >
                <SelectTrigger className="!h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {parseEnumValuesText(draft.enumText).map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                className="h-8"
                type={draft.type === 'integer' || draft.type === 'number' ? 'number' : 'text'}
                step={draft.type === 'integer' ? 1 : draft.type === 'number' ? 'any' : undefined}
                value={draft.defaultText}
                onChange={(event) => {
                  const defaultText = event.currentTarget.value;
                  onDraftChange({ ...draft, defaultText });
                }}
              />
            )}
          </div>
        </div>

        {draft.type === 'enum' ? (
          <div className="space-y-1.5">
            <Label>Enum values</Label>
            <Input
              value={draft.enumText}
              onChange={(event) => {
                const enumText = event.currentTarget.value;
                const values = parseEnumValuesText(enumText);
                onDraftChange({
                  ...draft,
                  enumText,
                  defaultText: values.includes(draft.defaultText)
                    ? draft.defaultText
                    : (values[0] ?? ''),
                });
              }}
              placeholder="idle, active, complete"
            />
          </div>
        ) : null}

        {message ? (
          <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {message}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!draft.id.trim()}>
            {submitLabel}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function parseVariableDraft(value: unknown): VariableDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  if (!variableTypeValues.includes(draft.type as VariableType)) return null;
  for (const key of ['id', 'label', 'description', 'defaultText', 'enumText']) {
    if (typeof draft[key] !== 'string') return null;
  }
  return draft as unknown as VariableDraft;
}

export function VariablesEditor({ tab }: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const setUsages = useEntityUsagesStore((state) => state.setUsages);
  const setActiveBottomPanel = useBottomPanelStore((state) => state.setActivePanelId);
  const [creating, setCreating] = useState(false);
  const [creatingDraft, setCreatingDraft] = useState(draftForNewVariable);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<VariableDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    variableId: string;
    usages: ReturnType<typeof findUsages>;
  } | null>(null);

  const referenceIndex = useMemo(() => (project ? buildReferenceIndex(project) : null), [project]);
  const variables = useMemo(() => {
    if (!project || !referenceIndex) return [];
    return Object.entries(project.variables)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([id, record]) => {
        const data = parseVariableData(record.data);
        return data
          ? [
              {
                id,
                record,
                data,
                usages: findUsages(referenceIndex, { collection: 'variables', id }),
              },
            ]
          : [];
      });
  }, [project, referenceIndex]);

  useWorkbenchEditorTabState(
    tab.id,
    useMemo(
      () => ({
        captureTabState: (): WorkbenchTabStatePayload => ({
          schema: 'noveltea.editor.variables-tab-state',
          schemaVersion: 1,
          payload: { creating, creatingDraft, editingId, editingDraft },
        }),
        restoreTabState: (state: WorkbenchTabStatePayload) => {
          if (state.schema !== 'noveltea.editor.variables-tab-state' || state.schemaVersion !== 1)
            return;
          const payload = state.payload;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
          const values = payload as Record<string, unknown>;
          const restoredCreatingDraft = parseVariableDraft(values.creatingDraft);
          const restoredEditingDraft = parseVariableDraft(values.editingDraft);
          setCreating(values.creating === true && !!restoredCreatingDraft);
          if (restoredCreatingDraft) setCreatingDraft(restoredCreatingDraft);
          setEditingId(
            typeof values.editingId === 'string' && restoredEditingDraft ? values.editingId : null,
          );
          setEditingDraft(restoredEditingDraft);
        },
      }),
      [creating, creatingDraft, editingDraft, editingId],
    ),
  );

  function run(command: Omit<CommandRequest, 'originSaveUnitId' | 'persistencePolicy'>) {
    const result = executeCommand({
      ...command,
      originSaveUnitId: SAVE_UNIT_IDS.variableCollection,
      persistencePolicy: 'manual-save',
    });
    return (
      result.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ??
      (result.ok ? null : 'Command failed.')
    );
  }

  function createVariable(draft: VariableDraft) {
    const id = draft.id.trim();
    const parsed = dataFromDraft(draft);
    if (!parsed.ok) return parsed.message;
    return run({
      type: 'entity.createRecord',
      label: `Create variable ${id}`,
      payload: {
        collection: 'variables',
        entityId: id,
        label: draft.label.trim() || id,
        description: draft.description.trim() || undefined,
        data: parsed.data,
      },
    });
  }

  function updateVariable(originalId: string, draft: VariableDraft) {
    const nextId = draft.id.trim();
    const parsed = dataFromDraft(draft);
    if (!parsed.ok) return parsed.message;

    if (nextId !== originalId) {
      const renameFailure = run({
        type: 'entity.renameId',
        label: `Rename variable ${originalId}`,
        payload: {
          collection: 'variables',
          fromId: originalId,
          toId: nextId,
          label: draft.label.trim() || nextId,
        },
      });
      if (renameFailure) return renameFailure;
    }

    const metadataFailure = run({
      type: 'entity.updateMetadata',
      label: `Update variable ${nextId}`,
      payload: {
        collection: 'variables',
        entityId: nextId,
        label: draft.label.trim() || nextId,
        description: draft.description.trim() || undefined,
      },
    });
    if (metadataFailure) return metadataFailure;

    return run({
      type: 'variable.replaceData',
      label: `Update variable ${nextId}`,
      payload: { variableId: nextId, data: parsed.data },
    });
  }

  function showUsages(variableId: string, usages: ReturnType<typeof findUsages>) {
    setUsages({ collection: 'variables', id: variableId }, usages);
    setActiveBottomPanel('references');
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const failure = run({
      type: 'entity.deleteRecord',
      label: `Delete variable ${deleteTarget.variableId}`,
      payload: { collection: 'variables', entityId: deleteTarget.variableId, force: true },
    });
    if (!failure) setDeleteTarget(null);
  }

  if (!project)
    return <div className="p-4 text-sm text-muted-foreground">No authoring project loaded.</div>;

  const editing = editingId
    ? (variables.find((variable) => variable.id === editingId) ?? null)
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <div
        className="flex items-center justify-between gap-3"
        data-workbench-anchor="variable.summary"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Variables</h2>
          <Badge variant="outline">{variables.length}</Badge>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setCreatingDraft(draftForNewVariable());
            setCreating(true);
          }}
        >
          <Plus className="size-4" />
          New variable
        </Button>
      </div>

      <section
        className="mt-4 min-h-0 overflow-hidden rounded-md border"
        data-workbench-anchor="variable.rows"
      >
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="w-px whitespace-nowrap px-3 py-2 text-center">Use</th>
              <th className="whitespace-nowrap px-3 py-2">Variable</th>
              <th className="w-px whitespace-nowrap px-2 py-2 text-center">Type</th>
              <th className="whitespace-nowrap px-3 py-2">Default</th>
              <th className="px-3 py-2">Description</th>
              <th className="w-px">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {variables.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-sm text-muted-foreground">
                  No variables yet.
                </td>
              </tr>
            ) : null}
            {variables.map(({ id, record, data, usages }) => {
              const Icon = typeIcon(data.type);
              const displayLabel = record.label || id;
              return (
                <tr
                  key={id}
                  className="group/row cursor-pointer border-t align-middle hover:bg-muted/30"
                  data-workbench-anchor={`variable.row.${id}`}
                  onClick={() => {
                    setEditingDraft(draftForVariable(id, record, data));
                    setEditingId(id);
                  }}
                >
                  <td className="w-px whitespace-nowrap px-3 py-2 text-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 min-w-7 px-2 font-mono"
                      onClick={(event) => {
                        event.stopPropagation();
                        showUsages(id, usages);
                      }}
                      aria-label={`${usages.length} usages for ${id}`}
                    >
                      {usages.length}
                    </Button>
                  </td>
                  <td className="max-w-64 whitespace-nowrap px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{displayLabel}</div>
                      {displayLabel !== id ? (
                        <div className="truncate font-mono text-[11px] text-muted-foreground">
                          {id}
                        </div>
                      ) : null}
                    </div>
                  </td>
                  <td className="w-px whitespace-nowrap px-2 py-2 text-center">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="inline-flex size-7 items-center justify-center rounded text-muted-foreground" />
                          }
                        >
                          <Icon className="size-4" />
                        </TooltipTrigger>
                        <TooltipContent>{typeLabel(data.type)}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </td>
                  <td
                    className="max-w-64 truncate whitespace-nowrap px-3 py-2 font-mono text-xs"
                    title={formatDefault(data)}
                  >
                    {formatDefault(data)}
                  </td>
                  <td
                    className="truncate px-3 py-2 text-muted-foreground"
                    title={record.description}
                  >
                    {record.description || '—'}
                  </td>
                  <td className="sticky right-0 w-0 p-0 text-right">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      className="absolute right-1 top-1/2 z-10 -translate-y-1/2 bg-background/90 text-destructive opacity-0 shadow-sm backdrop-blur-sm transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/row:opacity-100 focus-visible:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleteTarget({ variableId: id, usages });
                      }}
                      aria-label={`Delete ${displayLabel}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <VariableDialog
        key={creating ? 'create-open' : 'create-closed'}
        open={creating}
        initialDraft={draftForNewVariable()}
        title="New variable"
        submitLabel="Create variable"
        onOpenChange={setCreating}
        onSubmit={createVariable}
        draft={creatingDraft}
        onDraftChange={setCreatingDraft}
      />

      {editing ? (
        <VariableDialog
          key={editing.id}
          open
          initialDraft={draftForVariable(editing.id, editing.record, editing.data)}
          title={`Edit ${editing.record.label || editing.id}`}
          submitLabel="Save changes"
          onOpenChange={(open) => {
            if (!open) setEditingId(null);
          }}
          onSubmit={(draft) => updateVariable(editing.id, draft)}
          draft={editingDraft ?? draftForVariable(editing.id, editing.record, editing.data)}
          onDraftChange={setEditingDraft}
        />
      ) : null}

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogPopup>
          <DialogTitle>Delete variable?</DialogTitle>
          <DialogDescription>
            {deleteTarget?.usages.length
              ? `This variable is referenced by ${deleteTarget.usages.length} usage${deleteTarget.usages.length === 1 ? '' : 's'}. Deleting it will leave missing references for validation to report.`
              : 'This variable has no known usages.'}
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={confirmDelete}>
              Delete Variable
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
