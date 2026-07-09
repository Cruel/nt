import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComfyUiWorkflowsEditor } from '@/editors/comfyui/ComfyUiWorkflowsEditor';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { ComfyUiWorkflowLibraryEntry, ComfyUiWorkflowLibraryListResponse } from '../../shared/comfyui-workflows';

const tab = {
  id: 'tab:comfyui-workflows',
  title: 'ComfyUI Workflows',
  editorType: 'comfyui-workflows',
  resource: { kind: 'tool' as const, stableId: 'utility:comfyui-workflows' },
};

function entry(overrides: Partial<ComfyUiWorkflowLibraryEntry>): ComfyUiWorkflowLibraryEntry {
  const source = overrides.source ?? 'built-in';
  const id = overrides.id ?? 'flux2-klein-text-to-image';
  return {
    source,
    workflowKey: overrides.workflowKey ?? `${source}:${id}.manifest.json`,
    id,
    label: overrides.label ?? 'Flux 2 Klein Text to Image',
    role: overrides.role ?? 'image.generate',
    manifestFile: overrides.manifestFile ?? `${id}.manifest.json`,
    workflowFile: overrides.workflowFile ?? `${id}.workflow.json`,
    manifestPath: overrides.manifestPath ?? `/mock/${source}/${id}.manifest.json`,
    workflowPath: overrides.workflowPath ?? `/mock/${source}/${id}.workflow.json`,
    packageHash: 'sha256:mock',
    active: overrides.active ?? true,
    overridden: overrides.overridden ?? false,
    overriddenBy: overrides.overriddenBy,
    offlineStatus: overrides.offlineStatus ?? 'valid',
    onlineStatus: overrides.onlineStatus ?? 'unverified',
    repairable: overrides.repairable ?? false,
    diagnostics: overrides.diagnostics ?? [],
    verificationDiagnostics: overrides.verificationDiagnostics ?? [],
    capabilities: overrides.capabilities ?? {
      canCopyToEditor: true,
      canCopyToProject: true,
      canDelete: source !== 'built-in',
      canRepair: source !== 'built-in',
      canReveal: true,
    },
  };
}

function response(entries: ComfyUiWorkflowLibraryEntry[]): ComfyUiWorkflowLibraryListResponse {
  const visible = entries.filter((item) => item.active || item.overridden);
  return {
    ok: true,
    success: true,
    diagnostics: [],
    entries: visible,
    activeWorkflows: [],
    overriddenEntries: entries.filter((item) => item.overridden),
    summary: {
      sources: [],
      totalCount: entries.length,
      activeCount: entries.filter((item) => item.active).length,
      overriddenCount: entries.filter((item) => item.overridden).length,
      invalidCount: entries.filter((item) => item.offlineStatus === 'invalid').length,
      verifiedCount: entries.filter((item) => item.onlineStatus === 'verified').length,
      failedVerificationCount: entries.filter((item) => item.onlineStatus === 'failed').length,
    },
  };
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useComfyUiStore.setState((state) => ({
    status: { ...state.status, state: 'ready', message: 'ComfyUI ready' },
  }));
  vi.mocked(window.noveltea.listComfyUiWorkflowLibrary).mockReset();
  vi.mocked(window.noveltea.listComfyUiWorkflowLibrary).mockResolvedValue(response([
    entry({ source: 'built-in', id: 'base', label: 'Base Workflow' }),
  ]));
  vi.mocked(window.noveltea.copyComfyUiWorkflow).mockResolvedValue({ ok: true, success: true, action: 'copied', diagnostics: [] });
  vi.mocked(window.noveltea.deleteComfyUiWorkflow).mockResolvedValue({ ok: true, success: true, deleted: [], diagnostics: [] });
  vi.mocked(window.noveltea.revealComfyUiWorkflow).mockResolvedValue(true);
  vi.mocked(window.noveltea.verifyComfyUiWorkflowLibrary).mockResolvedValue({ ok: true, success: true, checkedAt: 'now', verified: [], failed: [], skipped: [], entries: [], diagnostics: [] });
  vi.spyOn(window, 'confirm').mockReturnValue(true);

});

describe('ComfyUiWorkflowsEditor', () => {
  it('shows the compact workflow columns and hides project actions without an open project', async () => {
    render(<ComfyUiWorkflowsEditor tab={tab} />);

    expect(await screen.findByText('Base Workflow')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for Base Workflow' })).toBeEnabled();
    expect(screen.queryByText('Verification')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /to Project/ })).not.toBeInTheDocument();
  });

  it('requests overridden rows only when Show overridden is enabled', async () => {
    vi.mocked(window.noveltea.listComfyUiWorkflowLibrary)
      .mockResolvedValueOnce(response([
        entry({ source: 'project', id: 'portrait', label: 'Project Portrait', active: true }),
        entry({ source: 'built-in', id: 'portrait', label: 'Built-in Portrait', active: false, overridden: true, overriddenBy: 'project:portrait.manifest.json' }),
      ]));

    render(<ComfyUiWorkflowsEditor tab={tab} />);

    expect(await screen.findByText('Project Portrait')).toBeInTheDocument();
    expect(screen.queryByText('Built-in Portrait')).not.toBeInTheDocument();
    expect(window.noveltea.listComfyUiWorkflowLibrary).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Show overridden'));

    expect(await screen.findByText('Built-in Portrait')).toBeInTheDocument();
    expect(screen.getByText('Built-in')).toBeInTheDocument();
    expect(window.noveltea.listComfyUiWorkflowLibrary).toHaveBeenLastCalledWith({ projectFilePath: null, includeOverridden: true });
  });

  it('shows project actions when a project is open and refreshes with the project path', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: createAuthoringProject(),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });

    render(<ComfyUiWorkflowsEditor tab={tab} />);

    expect(await screen.findByText('Base Workflow')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Base Workflow' }));
    expect(await screen.findByRole('menuitem', { name: 'Copy to Project' })).toBeEnabled();
    expect(window.noveltea.listComfyUiWorkflowLibrary).toHaveBeenLastCalledWith({
      projectFilePath: '/mock/project/game.json',
      includeOverridden: true,
    });
  });

  it('runs workflow copy, reveal, delete, and refresh actions through the library API', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: createAuthoringProject(),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    vi.mocked(window.noveltea.listComfyUiWorkflowLibrary).mockResolvedValue(response([
      entry({ source: 'editor', id: 'custom', label: 'Custom Workflow' }),
    ]));

    render(<ComfyUiWorkflowsEditor tab={tab} />);

    expect(await screen.findByText('Custom Workflow')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Custom Workflow' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy to Project' }));
    await screen.findByText('Workflow copied.');
    expect(window.noveltea.copyComfyUiWorkflow).toHaveBeenCalledWith({
      workflowKey: 'editor:custom.manifest.json',
      targetSource: 'project',
      projectFilePath: '/mock/project/game.json',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Custom Workflow' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in folder' }));
    await screen.findByText('Opened workflow in folder.');
    expect(window.noveltea.revealComfyUiWorkflow).toHaveBeenCalledWith('editor:custom.manifest.json', '/mock/project/game.json');

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Custom Workflow' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete workflow' }));
    await screen.findByText('Workflow deleted.');
    expect(window.confirm).toHaveBeenCalledWith("Delete workflow 'Custom Workflow'?");
    expect(window.noveltea.deleteComfyUiWorkflow).toHaveBeenCalledWith({
      workflowKey: 'editor:custom.manifest.json',
      projectFilePath: '/mock/project/game.json',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Verified 0 workflows.');
    expect(window.noveltea.verifyComfyUiWorkflowLibrary).toHaveBeenCalledWith(expect.objectContaining({
      projectFilePath: '/mock/project/game.json',
    }));
  });
  it('opens import and repair dialogs from manager actions', async () => {
    vi.mocked(window.noveltea.listComfyUiWorkflowLibrary).mockResolvedValue(response([
      entry({ source: 'editor', id: 'custom', label: 'Custom Workflow', repairable: true, capabilities: {
        canCopyToEditor: false,
        canCopyToProject: true,
        canDelete: true,
        canRepair: true,
        canReveal: true,
      } }),
    ]));

    render(<ComfyUiWorkflowsEditor tab={tab} />);

    expect(await screen.findByText('Custom Workflow')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Import ComfyUI Workflow')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Custom Workflow' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Repair manifest' }));
    expect(await screen.findByText('Repair ComfyUI Workflow')).toBeInTheDocument();
  });
});
