import { useMemo, useState } from 'react';
import {
  newPropertyManagerState,
  PropertyManager,
  type PropertyManagerRow,
  type PropertyManagerState,
} from '@/components/properties/PropertyManager';
import {
  newTypedPropertyDraft,
  typedPropertyValueFromDraft,
  type TypedPropertyDraft,
} from '@/components/properties/TypedPropertyFields';
import { useCommandStore } from '@/commands/command-store';
import type { CommandRequest } from '@/commands/command-types';
import { referenceIndexFromCurrentGraph } from '@/project/authoring-graph-consumers';
import { useCurrentAuthoringDependencyGraphSnapshot } from '@/project/authoring-dependency-graph-runtime';
import { useEntityUsagesStore } from '@/project/entity-usages-store';
import { useProjectStore } from '@/project/project-store';
import { findUsages } from '@/project/reference-index';
import { SAVE_UNIT_IDS } from '@/project/save-unit-registry';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  useWorkbenchEditorTabState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  parseVariableData,
  variableTypeValues,
  type VariableData,
  type VariableType,
} from '../../../shared/project-schema/authoring-variables';

type VariableDraft = TypedPropertyDraft;

function draftForNewVariable(): VariableDraft {
  return newTypedPropertyDraft();
}

function dataFromDraft(
  draft: VariableDraft,
): { ok: true; data: VariableData } | { ok: false; message: string } {
  const parsed = typedPropertyValueFromDraft(draft);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    data: {
      kind: 'variable',
      type: draft.type,
      nullable: draft.nullable,
      scope: 'global',
      ...(parsed.enumValues ? { enumValues: parsed.enumValues } : {}),
      value: parsed.value,
    },
  };
}

function parseVariableDraft(value: unknown): VariableDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  if (!variableTypeValues.includes(draft.type as VariableType)) return null;
  for (const key of ['id', 'label', 'description', 'valueText', 'enumText']) {
    if (typeof draft[key] !== 'string') return null;
  }
  if (typeof draft.nullable !== 'boolean' || typeof draft.valuePresent !== 'boolean') return null;
  return draft as unknown as VariableDraft;
}

function parseManagerState(value: unknown): PropertyManagerState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (typeof state.traitId !== 'string') return null;
  if (!(state.deleteId === null || typeof state.deleteId === 'string')) return null;
  if (state.editing === null)
    return { editing: null, deleteId: state.deleteId as string | null, traitId: state.traitId };
  if (!state.editing || typeof state.editing !== 'object' || Array.isArray(state.editing))
    return null;
  const editing = state.editing as Record<string, unknown>;
  const draft = parseVariableDraft(editing.draft);
  if (!draft) return null;
  if (editing.kind === 'create')
    return {
      editing: { kind: 'create', draft },
      deleteId: state.deleteId as string | null,
      traitId: state.traitId,
    };
  if (
    editing.kind === 'row' &&
    typeof editing.rowId === 'string' &&
    (editing.mode === 'schema' || editing.mode === 'value')
  )
    return {
      editing: { kind: 'row', rowId: editing.rowId, mode: editing.mode, draft },
      deleteId: state.deleteId as string | null,
      traitId: state.traitId,
    };
  return null;
}

export function VariablesEditor({ tab }: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const graphSnapshot = useCurrentAuthoringDependencyGraphSnapshot();
  const setUsages = useEntityUsagesStore((state) => state.setUsages);
  const setActiveBottomPanel = useBottomPanelStore((state) => state.setActivePanelId);
  const [managerState, setManagerState] = useState<PropertyManagerState>(newPropertyManagerState);

  const referenceIndex = useMemo(
    () =>
      project && graphSnapshot ? referenceIndexFromCurrentGraph(project, graphSnapshot) : null,
    [graphSnapshot, project],
  );
  const variables = useMemo(() => {
    if (!project) return [];
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
                usages: referenceIndex
                  ? findUsages(referenceIndex, { collection: 'variables', id })
                  : [],
              },
            ]
          : [];
      });
  }, [project, referenceIndex]);
  const rows = useMemo<PropertyManagerRow[]>(
    () =>
      variables.map(({ id, record, data, usages }) => ({
        id,
        label: record.label,
        description: record.description,
        type: data.type,
        nullable: data.nullable,
        enumValues: data.enumValues,
        value: data.value,
        valueState: 'normal',
        usageCount: usages.length,
        editMode: 'schema',
        deletable: true,
      })),
    [variables],
  );

  useWorkbenchEditorTabState(
    tab.id,
    useMemo(
      () => ({
        schema: 'noveltea.editor.variables-tab-state',
        captureTabState: (): WorkbenchTabStatePayload => ({
          schema: 'noveltea.editor.variables-tab-state',
          payload: { managerState },
        }),
        restoreTabState: (state: WorkbenchTabStatePayload) => {
          if (state.schema !== 'noveltea.editor.variables-tab-state') return;
          const payload = state.payload;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
          const restored = parseManagerState((payload as Record<string, unknown>).managerState);
          if (restored) setManagerState(restored);
        },
      }),
      [managerState],
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

  if (!project)
    return <div className="p-4 text-sm text-muted-foreground">No authoring project loaded.</div>;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <PropertyManager
        title="Variables"
        count
        propertyColumnLabel="Variable"
        valueLabel="Value"
        rows={rows}
        emptyLabel="No variables yet."
        addLabel="New variable"
        createSubmitLabel="Create variable"
        createTitle="New variable"
        editTitle={(row) => `Edit ${row.label || row.id}`}
        editDescription={() => 'Variables are referenced from Lua and expressions by ID.'}
        descriptionPlaceholder="What this variable represents"
        newDraft={draftForNewVariable}
        onCreate={createVariable}
        onEdit={(row, draft) => updateVariable(row.id, draft)}
        onDelete={(row) =>
          run({
            type: 'entity.deleteRecord',
            label: `Delete variable ${row.id}`,
            payload: { collection: 'variables', entityId: row.id, force: false },
          })
        }
        deleteMessage={(row) =>
          row.usageCount
            ? `This variable is referenced by ${row.usageCount} usage${row.usageCount === 1 ? '' : 's'}. Deleting it will leave missing references for validation to report.`
            : 'This variable has no known usages.'
        }
        onShowUsages={(row) => {
          const variable = variables.find((candidate) => candidate.id === row.id);
          if (!variable) return;
          setUsages({ collection: 'variables', id: row.id }, variable.usages);
          setActiveBottomPanel('references');
        }}
        anchor="variable.summary"
        rowAnchor={(row) => `variable.row.${row.id}`}
        state={managerState}
        onStateChange={setManagerState}
        modeMarker="variable"
      />
    </div>
  );
}
