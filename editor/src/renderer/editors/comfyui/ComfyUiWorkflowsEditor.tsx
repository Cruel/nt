import { useEffect, useMemo, useState } from 'react';
import {
  Copy,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  Wrench,
  X,
} from 'lucide-react';
import { ComfyUiWorkflowImportDialog } from '@/editors/project/ComfyUiWorkflowImportDialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  copyComfyUiWorkflow,
  deleteComfyUiWorkflow,
  listComfyUiWorkflowLibrary,
  renameComfyUiWorkflow,
  revealComfyUiWorkflow,
  verifyComfyUiWorkflowLibrary,
} from '@/comfyui/comfyui-service';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { invalidateComfyUiWorkflowVerification } from '@/comfyui/comfyui-workflow-library-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  useWorkbenchEditorTabState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';
import type {
  ComfyUiWorkflowLibraryEntry,
  ComfyUiWorkflowLibraryListResponse,
} from '../../../shared/comfyui-workflows';

function sourceLabel(source: string) {
  if (source === 'built-in') return 'Built-in';
  if (source === 'editor') return 'Editor';
  if (source === 'project') return 'Project';
  return source;
}

function visibleEntries(
  response: ComfyUiWorkflowLibraryListResponse | null,
  showOverridden: boolean,
): ComfyUiWorkflowLibraryEntry[] {
  if (!response) return [];
  return response.entries.filter((entry) => entry.active || (showOverridden && entry.overridden));
}

function diagnosticsText(entry: ComfyUiWorkflowLibraryEntry) {
  const diagnostics = [...entry.diagnostics, ...entry.verificationDiagnostics];
  if (diagnostics.length === 0) return 'No diagnostics.';
  return diagnostics.map((diagnostic) => diagnostic.message).join(' ');
}

function lightClass(status: 'green' | 'yellow' | 'red' | 'muted') {
  return {
    green: 'bg-emerald-500',
    yellow: 'bg-amber-400',
    red: 'bg-red-500',
    muted: 'bg-muted-foreground/40',
  }[status];
}

function statusLights(entry: ComfyUiWorkflowLibraryEntry, comfyUiState: string) {
  const offline =
    entry.offlineStatus === 'invalid'
      ? 'red'
      : entry.offlineStatus === 'warning'
        ? 'yellow'
        : 'green';
  const online =
    entry.onlineStatus === 'failed'
      ? 'red'
      : entry.onlineStatus === 'verified' || entry.onlineStatus === 'previously-verified'
        ? 'green'
        : 'yellow';
  const onlineMessage =
    entry.onlineStatus === 'failed'
      ? diagnosticsText(entry)
      : entry.onlineStatus === 'verified' || entry.onlineStatus === 'previously-verified'
        ? 'ComfyUI verified'
        : comfyUiState === 'ready'
          ? 'Need ComfyUI verification'
          : 'Need ComfyUI server to verify';
  return [
    {
      label: 'Offline checks',
      color: offline,
      message: entry.diagnostics.length
        ? entry.diagnostics.map((diagnostic) => diagnostic.message).join(' ')
        : 'Offline checks passed',
    },
    { label: 'ComfyUI verification', color: online, message: onlineMessage },
  ] as const;
}

const COMFYUI_WORKFLOWS_TAB_STATE_SCHEMA = 'noveltea.editor.comfyui-workflows-tab-state';

export function ComfyUiWorkflowsEditor({ tab }: WorkbenchEditorProps) {
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const comfyUiStatus = useComfyUiStore((state) => state.status);
  const [showOverridden, setShowOverridden] = useState(false);
  const [response, setResponse] = useState<ComfyUiWorkflowLibraryListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [repairEntry, setRepairEntry] = useState<ComfyUiWorkflowLibraryEntry | null>(null);
  const [editingWorkflowKey, setEditingWorkflowKey] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  useWorkbenchEditorTabState(
    tab.id,
    useMemo(
      () => ({
        captureTabState: (): WorkbenchTabStatePayload => ({
          schema: COMFYUI_WORKFLOWS_TAB_STATE_SCHEMA,
          schemaVersion: 1,
          payload: { showOverridden },
        }),
        restoreTabState: (state: WorkbenchTabStatePayload) => {
          if (state.schema !== COMFYUI_WORKFLOWS_TAB_STATE_SCHEMA || state.schemaVersion !== 1)
            return;
          const payload = state.payload;
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            const values = payload as Record<string, unknown>;
            if (typeof values.showOverridden === 'boolean')
              setShowOverridden(values.showOverridden);
          }
        },
      }),
      [showOverridden],
    ),
  );

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setMessage(null);
    void listComfyUiWorkflowLibrary({
      projectFilePath,
      includeOverridden: true,
      comfyUiVersion: comfyUiStatus.comfyUiVersion,
    })
      .then((next) => {
        if (canceled) return;
        setResponse(next);
        const warningCount = next.diagnostics.filter(
          (diagnostic) => diagnostic.severity !== 'info',
        ).length;
        setMessage(
          warningCount > 0
            ? `${warningCount} workflow diagnostic${warningCount === 1 ? '' : 's'} found.`
            : null,
        );
      })
      .catch((error) => {
        if (!canceled) {
          setResponse(null);
          setMessage(error instanceof Error ? error.message : 'Failed to load ComfyUI workflows.');
        }
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [comfyUiStatus.comfyUiVersion, comfyUiStatus.state, projectFilePath, refreshToken]);

  const entries = visibleEntries(response, showOverridden);

  function refresh() {
    setRefreshToken((value) => value + 1);
  }

  async function handleImported(nextMessage: string) {
    setMessage(nextMessage);
    invalidateComfyUiWorkflowVerification();
    refresh();
  }

  function openRepair(entry: ComfyUiWorkflowLibraryEntry) {
    setRepairEntry(entry);
  }

  function operationMessage(
    responseMessage: {
      success: boolean;
      error?: string;
      diagnostics?: Array<{ message?: string }>;
    },
    fallback: string,
  ) {
    return responseMessage.success
      ? fallback
      : (responseMessage.error ??
          responseMessage.diagnostics?.find((diagnostic) => diagnostic.message)?.message ??
          'ComfyUI workflow operation failed.');
  }

  async function copyWorkflow(
    entry: ComfyUiWorkflowLibraryEntry,
    targetSource: 'editor' | 'project',
  ) {
    const actionKey = `copy:${targetSource}:${entry.workflowKey}`;
    setBusyAction(actionKey);
    setMessage(null);
    try {
      let result = await copyComfyUiWorkflow({
        workflowKey: entry.workflowKey,
        targetSource,
        projectFilePath,
      });
      if (result.action === 'replace-required') {
        const replace = window.confirm(
          `Replace the existing ${targetSource} workflow '${entry.id ?? entry.workflowKey}'?`,
        );
        if (replace)
          result = await copyComfyUiWorkflow({
            workflowKey: entry.workflowKey,
            targetSource,
            projectFilePath,
            replace: true,
          });
      }
      setMessage(
        operationMessage(
          result,
          result.action === 'already-copied'
            ? 'Workflow is already copied.'
            : `Workflow ${result.action}.`,
        ),
      );
      if (result.success && result.action !== 'already-copied')
        invalidateComfyUiWorkflowVerification();
      refresh();
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteWorkflow(entry: ComfyUiWorkflowLibraryEntry) {
    if (!window.confirm(`Delete workflow '${entry.label ?? entry.workflowKey}'?`)) return;
    const actionKey = `delete:${entry.workflowKey}`;
    setBusyAction(actionKey);
    setMessage(null);
    try {
      const result = await deleteComfyUiWorkflow({
        workflowKey: entry.workflowKey,
        projectFilePath,
      });
      setMessage(operationMessage(result, 'Workflow deleted.'));
      if (result.success) invalidateComfyUiWorkflowVerification();
      refresh();
    } finally {
      setBusyAction(null);
    }
  }

  async function revealWorkflow(entry: ComfyUiWorkflowLibraryEntry) {
    const actionKey = `reveal:${entry.workflowKey}`;
    setBusyAction(actionKey);
    setMessage(null);
    try {
      const result = await revealComfyUiWorkflow(entry.workflowKey, projectFilePath);
      setMessage(result ? 'Opened workflow in folder.' : 'Workflow folder is unavailable.');
    } finally {
      setBusyAction(null);
    }
  }

  function beginRename(entry: ComfyUiWorkflowLibraryEntry) {
    setEditingWorkflowKey(entry.workflowKey);
    setEditingName(entry.label ?? '');
  }

  function cancelRename() {
    setEditingWorkflowKey(null);
    setEditingName('');
  }

  async function saveRename(entry: ComfyUiWorkflowLibraryEntry) {
    const nextName = editingName.trim();
    if (!nextName || nextName === entry.label) {
      cancelRename();
      return;
    }
    const actionKey = `rename:${entry.workflowKey}`;
    setBusyAction(actionKey);
    try {
      const result = await renameComfyUiWorkflow({
        workflowKey: entry.workflowKey,
        label: nextName,
        projectFilePath,
      });
      setMessage(operationMessage(result, 'Workflow renamed.'));
      if (result.success) {
        cancelRename();
        refresh();
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function verifyWorkflows() {
    const actionKey = 'refresh';
    setBusyAction(actionKey);
    setMessage(null);
    try {
      const result = await verifyComfyUiWorkflowLibrary({
        projectFilePath,
        config: useComfyUiStore.getState().config,
      });
      setMessage(
        operationMessage(
          result,
          `Verified ${result.verified.length} workflow${result.verified.length === 1 ? '' : 's'}.`,
        ),
      );
      refresh();
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b bg-background px-4 py-2">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">ComfyUI Workflows</h2>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showOverridden}
                onChange={(event) => setShowOverridden(event.currentTarget.checked)}
              />
              Show overridden
            </label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void verifyWorkflows()}
              disabled={busyAction === 'refresh'}
            >
              <RefreshCw className="mr-2 size-4" />
              Refresh
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setImportOpen(true)}
              disabled={busyAction !== null}
            >
              <Upload className="mr-2 size-4" />
              Import
            </Button>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {message ? (
          <div className="mb-4 rounded border p-2 text-xs text-muted-foreground">{message}</div>
        ) : null}
        {!loading && entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No ComfyUI workflows found.</p>
        ) : null}
        {entries.length > 0 ? (
          <div className="overflow-auto rounded border">
            <table className="w-full min-w-0 table-fixed text-left text-sm">
              <colgroup>
                <col className="w-24" />
                <col />
                <col className="w-36" />
                <col className="w-16" />
                <col className="w-8" />
              </colgroup>
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="w-16 whitespace-nowrap px-2 py-2 font-medium">Status</th>
                  <th className="w-8 px-1 py-2 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.workflowKey}
                    className={`group/row border-b last:border-b-0 ${entry.overridden ? 'text-muted-foreground opacity-70' : ''}`}
                  >
                    <td className="px-3 py-2">{sourceLabel(entry.source)}</td>
                    <td className="px-3 py-2">
                      {editingWorkflowKey === entry.workflowKey ? (
                        <div className="flex items-center gap-1">
                          <input
                            autoFocus
                            className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                            value={editingName}
                            onChange={(event) => setEditingName(event.currentTarget.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void saveRename(entry);
                              if (event.key === 'Escape') cancelRename();
                            }}
                            aria-label={`Edit name for ${entry.label ?? entry.workflowKey}`}
                          />
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            disabled={busyAction !== null}
                            onClick={cancelRename}
                            aria-label="Cancel workflow name edit"
                          >
                            <X className="size-4" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate">{entry.label}</span>
                          {entry.capabilities.canRename === true ? (
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              className="size-6 shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                              disabled={busyAction !== null}
                              onClick={() => beginRename(entry)}
                              aria-label={`Edit name for ${entry.label ?? entry.workflowKey}`}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                          ) : null}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{entry.role}</td>
                    <td className="w-16 whitespace-nowrap px-2 py-2 align-middle">
                      <TooltipProvider>
                        <div className="flex items-center gap-2">
                          {statusLights(entry, comfyUiStatus.state).map((light) => (
                            <Tooltip key={light.label}>
                              <TooltipTrigger
                                render={
                                  <span
                                    role="img"
                                    aria-label={`${light.label}: ${light.message}`}
                                    className={`size-2.5 rounded-full ${lightClass(light.color)}`}
                                  />
                                }
                              />
                              <TooltipContent>{light.message}</TooltipContent>
                            </Tooltip>
                          ))}
                        </div>
                      </TooltipProvider>
                    </td>
                    <td className="w-8 px-1 py-2 text-right align-top">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              className="opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                              disabled={busyAction !== null}
                              aria-label={`Actions for ${entry.label ?? entry.workflowKey}`}
                            />
                          }
                        >
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48 min-w-48">
                          <DropdownMenuItem
                            disabled={!entry.capabilities.canCopyToEditor}
                            onClick={() => void copyWorkflow(entry, 'editor')}
                          >
                            <Copy />
                            Copy to Editor
                          </DropdownMenuItem>
                          {projectFilePath ? (
                            <DropdownMenuItem
                              disabled={!entry.capabilities.canCopyToProject}
                              onClick={() => void copyWorkflow(entry, 'project')}
                            >
                              <Copy />
                              Copy to Project
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem
                            disabled={!entry.capabilities.canRepair}
                            onClick={() => openRepair(entry)}
                          >
                            <Wrench />
                            Repair manifest
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!entry.capabilities.canReveal}
                            onClick={() => void revealWorkflow(entry)}
                          >
                            <FolderOpen />
                            Reveal in folder
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={!entry.capabilities.canDelete}
                            onClick={() => void deleteWorkflow(entry)}
                          >
                            <Trash2 />
                            Delete workflow
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      <ComfyUiWorkflowImportDialog
        open={importOpen}
        projectFilePath={projectFilePath}
        repairEntry={null}
        onOpenChange={setImportOpen}
        onImported={handleImported}
      />
      <ComfyUiWorkflowImportDialog
        open={Boolean(repairEntry)}
        projectFilePath={projectFilePath}
        repairEntry={repairEntry}
        onOpenChange={(open) => {
          if (!open) setRepairEntry(null);
        }}
        onImported={handleImported}
      />
    </div>
  );
}
