import { useEffect, useState } from 'react';
import { Copy, FileSearch, FolderOpen, RefreshCw, Trash2, Upload, Wrench } from 'lucide-react';
import { ComfyUiWorkflowImportDialog } from '@/editors/project/ComfyUiWorkflowImportDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { copyComfyUiWorkflow, deleteComfyUiWorkflow, listComfyUiWorkflowLibrary, revealComfyUiWorkflow, verifyComfyUiWorkflowLibrary } from '@/comfyui/comfyui-service';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { invalidateComfyUiWorkflowVerification } from '@/comfyui/comfyui-workflow-library-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import type { ComfyUiWorkflowLibraryEntry, ComfyUiWorkflowLibraryListResponse } from '../../../shared/comfyui-workflows';

function sourceLabel(source: string) {
  if (source === 'built-in') return 'Built-in';
  if (source === 'editor') return 'Editor';
  if (source === 'project') return 'Project';
  return source;
}

function visibleEntries(response: ComfyUiWorkflowLibraryListResponse | null): ComfyUiWorkflowLibraryEntry[] {
  if (!response) return [];
  return response.entries.filter((entry) => entry.active || entry.overridden);
}

function statusVariant(status: ComfyUiWorkflowLibraryEntry['offlineStatus'] | ComfyUiWorkflowLibraryEntry['onlineStatus']) {
  if (status === 'invalid' || status === 'failed') return 'destructive';
  if (status === 'warning' || status === 'unverified' || status === 'previously-verified') return 'outline';
  return 'secondary';
}

function diagnosticsText(entry: ComfyUiWorkflowLibraryEntry) {
  const diagnostics = [...entry.diagnostics, ...entry.verificationDiagnostics];
  if (diagnostics.length === 0) return 'None';
  return diagnostics.map((diagnostic) => diagnostic.message).join(' ');
}

function pathText(path?: string) {
  if (!path) return 'Missing';
  return path;
}

export function ComfyUiWorkflowsEditor(_props: WorkbenchEditorProps) {
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

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setMessage(null);
    void listComfyUiWorkflowLibrary({ projectFilePath, includeOverridden: showOverridden, comfyUiVersion: comfyUiStatus.comfyUiVersion }).then((next) => {
      if (canceled) return;
      setResponse(next);
      const warningCount = next.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info').length;
      setMessage(warningCount > 0 ? `${warningCount} workflow diagnostic${warningCount === 1 ? '' : 's'} found.` : null);
    }).catch((error) => {
      if (!canceled) {
        setResponse(null);
        setMessage(error instanceof Error ? error.message : 'Failed to load ComfyUI workflows.');
      }
    }).finally(() => {
      if (!canceled) setLoading(false);
    });
    return () => { canceled = true; };
  }, [comfyUiStatus.comfyUiVersion, comfyUiStatus.state, projectFilePath, refreshToken, showOverridden]);

  const entries = visibleEntries(response);

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

  function operationMessage(responseMessage: { success: boolean; error?: string; diagnostics?: Array<{ message?: string }> }, fallback: string) {
    return responseMessage.success
      ? fallback
      : responseMessage.error ?? responseMessage.diagnostics?.find((diagnostic) => diagnostic.message)?.message ?? 'ComfyUI workflow operation failed.';
  }

  async function copyWorkflow(entry: ComfyUiWorkflowLibraryEntry, targetSource: 'editor' | 'project') {
    const actionKey = `copy:${targetSource}:${entry.workflowKey}`;
    setBusyAction(actionKey);
    setMessage(null);
    try {
      let result = await copyComfyUiWorkflow({ workflowKey: entry.workflowKey, targetSource, projectFilePath });
      if (result.action === 'replace-required') {
        const replace = window.confirm(`Replace the existing ${targetSource} workflow '${entry.id ?? entry.workflowKey}'?`);
        if (replace) result = await copyComfyUiWorkflow({ workflowKey: entry.workflowKey, targetSource, projectFilePath, replace: true });
      }
      setMessage(operationMessage(result, result.action === 'already-copied' ? 'Workflow is already copied.' : `Workflow ${result.action}.`));
      if (result.success && result.action !== 'already-copied') invalidateComfyUiWorkflowVerification();
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
      const result = await deleteComfyUiWorkflow({ workflowKey: entry.workflowKey, projectFilePath });
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

  async function verifyWorkflows() {
    const actionKey = 'verify';
    setBusyAction(actionKey);
    setMessage(null);
    try {
      const result = await verifyComfyUiWorkflowLibrary({ projectFilePath, config: useComfyUiStore.getState().config, force: true });
      setMessage(operationMessage(result, `Verified ${result.verified.length} workflow${result.verified.length === 1 ? '' : 's'}.`));
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
            <p className="mt-0.5 text-xs text-muted-foreground">
              {projectFilePath ? `Project: ${projectFilePath}` : 'No project open'}
            </p>
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
            <Button type="button" size="sm" variant="outline" onClick={refresh}>
              <RefreshCw className="mr-2 size-4" />
              Refresh
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void verifyWorkflows()} disabled={busyAction === 'verify'}>
              <FileSearch className="mr-2 size-4" />
              Verify with ComfyUI
            </Button>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mb-4 flex flex-wrap gap-2 text-xs">
          <span className="rounded-md border px-2 py-1 text-muted-foreground">Active: {response?.summary.activeCount ?? 0}</span>
          <span className="rounded-md border px-2 py-1 text-muted-foreground">Overridden: {response?.summary.overriddenCount ?? 0}</span>
          <span className="rounded-md border px-2 py-1 text-muted-foreground">Invalid: {response?.summary.invalidCount ?? 0}</span>
          <span className="rounded-md border px-2 py-1 text-muted-foreground">ComfyUI: {comfyUiStatus.state}</span>
        </div>
        {message ? <div className="mb-4 rounded border p-2 text-xs text-muted-foreground">{message}</div> : null}
        {loading ? <p className="text-sm text-muted-foreground">Loading workflows...</p> : null}
        {!loading && entries.length === 0 ? <p className="text-sm text-muted-foreground">No ComfyUI workflows found.</p> : null}
        {entries.length > 0 ? (
          <div className="overflow-auto rounded border">
            <table className="w-full min-w-[1180px] text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Label</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">ID</th>
                  <th className="px-3 py-2 font-medium">Verification</th>
                  <th className="px-3 py-2 font-medium">Workflow file</th>
                  <th className="px-3 py-2 font-medium">Manifest file</th>
                  <th className="px-3 py-2 font-medium">Diagnostics</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.workflowKey} className={`border-b last:border-b-0 ${entry.overridden ? 'text-muted-foreground opacity-70' : ''}`}>
                    <td className="px-3 py-2 align-top">
                      <Badge variant={entry.overridden ? 'outline' : statusVariant(entry.offlineStatus)}>{entry.overridden ? 'Overridden' : entry.offlineStatus}</Badge>
                    </td>
                    <td className="px-3 py-2">{sourceLabel(entry.source)}</td>
                    <td className="px-3 py-2">{entry.label}</td>
                    <td className="px-3 py-2 font-mono text-xs">{entry.role}</td>
                    <td className="px-3 py-2 font-mono text-xs">{entry.id}</td>
                    <td className="px-3 py-2 align-top">
                      <Badge variant={statusVariant(entry.onlineStatus)}>{entry.onlineStatus}</Badge>
                    </td>
                    <td className="max-w-[180px] px-3 py-2 align-top font-mono text-[11px]">
                      <span className="block truncate" title={pathText(entry.workflowPath)}>{entry.workflowFile ?? 'Missing'}</span>
                    </td>
                    <td className="max-w-[180px] px-3 py-2 align-top font-mono text-[11px]">
                      <span className="block truncate" title={entry.manifestPath}>{entry.manifestFile}</span>
                    </td>
                    <td className="max-w-[240px] px-3 py-2 align-top text-xs text-muted-foreground">
                      <span className="line-clamp-3" title={diagnosticsText(entry)}>{diagnosticsText(entry)}</span>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex flex-wrap gap-1.5">
                        <Button type="button" size="icon-sm" variant="outline" disabled={busyAction !== null} onClick={() => setImportOpen(true)} title="Import workflow" aria-label="Import workflow">
                          <Upload className="size-3.5" />
                        </Button>
                        <Button type="button" size="icon-sm" variant="outline" disabled={busyAction !== null || !entry.capabilities.canCopyToEditor} onClick={() => void copyWorkflow(entry, 'editor')} title={entry.capabilities.canCopyToEditor ? 'Copy to Editor' : 'Copy to Editor unavailable'} aria-label={`Copy ${entry.label ?? entry.workflowKey} to Editor`}>
                          <Copy className="size-3.5" />
                        </Button>
                        {projectFilePath ? (
                          <Button type="button" size="icon-sm" variant="outline" disabled={busyAction !== null || !entry.capabilities.canCopyToProject} onClick={() => void copyWorkflow(entry, 'project')} title={entry.capabilities.canCopyToProject ? 'Copy to Project' : 'Copy to Project unavailable'} aria-label={`Copy ${entry.label ?? entry.workflowKey} to Project`}>
                            <Copy className="size-3.5" />
                          </Button>
                        ) : null}
                        <Button type="button" size="icon-sm" variant="outline" disabled={busyAction !== null || !entry.capabilities.canRepair} onClick={() => openRepair(entry)} title={entry.capabilities.canRepair ? 'Repair manifest' : 'Repair unavailable for this workflow'} aria-label={`Repair ${entry.label ?? entry.workflowKey}`}>
                          <Wrench className="size-3.5" />
                        </Button>
                        <Button type="button" size="icon-sm" variant="outline" disabled={busyAction !== null || !entry.capabilities.canReveal} onClick={() => void revealWorkflow(entry)} title={entry.capabilities.canReveal ? 'Reveal in folder' : 'Reveal unavailable'} aria-label={`Reveal ${entry.label ?? entry.workflowKey} in folder`}>
                          <FolderOpen className="size-3.5" />
                        </Button>
                        <Button type="button" size="icon-sm" variant="outline" disabled={busyAction !== null || entry.offlineStatus === 'invalid'} onClick={() => void verifyWorkflows()} title="Verify with ComfyUI" aria-label={`Verify ${entry.label ?? entry.workflowKey} with ComfyUI`}>
                          <FileSearch className="size-3.5" />
                        </Button>
                        <Button type="button" size="icon-sm" variant="destructive" disabled={busyAction !== null || !entry.capabilities.canDelete} onClick={() => void deleteWorkflow(entry)} title={entry.capabilities.canDelete ? 'Delete workflow' : 'Delete unavailable for this workflow'} aria-label={`Delete ${entry.label ?? entry.workflowKey}`}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
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
        onOpenChange={(open) => { if (!open) setRepairEntry(null); }}
        onImported={handleImported}
      />
    </div>
  );
}
