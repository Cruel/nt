import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ToolDiagnostic } from '../../shared/editor-tooling';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultPackageOutputFileName, exportShaderVariantValues, selectedExportProfile, type ExportProfileData, type ExportShaderVariant } from '../../shared/project-schema/authoring-export';
import { buildAuthoringRuntimeExport, hasAuthoringShadersOrMaterials } from '../../shared/project-schema/authoring-runtime-export';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { runPackageExportWorkflow } from './package-export-workflow';
import { usePackageExportStore } from './package-export-store';
import { dispatchWorkspaceToolbarCommand } from '@/workspace/workspace-toolbar-events';

interface PackageExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: AuthoringProject | null;
  projectRoot: string | null;
  projectFilePath: string | null;
}

function dirname(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : null;
}

function defaultOutputPath(project: AuthoringProject, projectRoot: string | null, projectFilePath: string | null) {
  const root = projectRoot ?? dirname(projectFilePath) ?? '';
  const file = defaultPackageOutputFileName(project);
  return root ? `${root.replace(/[\\/]+$/, '')}/${file}` : file;
}

function toggleVariant(profile: ExportProfileData, variant: ExportShaderVariant): ExportProfileData {
  const next = profile.shaderVariants.includes(variant)
    ? profile.shaderVariants.filter((item) => item !== variant)
    : [...profile.shaderVariants, variant];
  return { ...profile, shaderVariants: next.length > 0 ? next : [variant] };
}

function severityVariant(severity: ToolDiagnostic['severity']) {
  return severity === 'error' ? 'destructive' : severity === 'warning' ? 'secondary' : 'outline';
}

function DiagnosticPreview({ title, diagnostics }: { title: string; diagnostics: ToolDiagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <div className="rounded border p-3 text-xs">
      <div className="mb-2 font-medium">{title}</div>
      <div className="space-y-2">
        {diagnostics.slice(0, 6).map((diagnostic, index) => (
          <div key={`${diagnostic.path}-${diagnostic.message}-${index}`} className="rounded bg-muted/40 p-2">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Badge variant={severityVariant(diagnostic.severity)}>{diagnostic.severity}</Badge>
              <Badge variant="outline">{diagnostic.category ?? 'export'}</Badge>
              <span className="font-mono text-[10px] text-muted-foreground">{diagnostic.path || '/'}</span>
            </div>
            <div>{diagnostic.message}</div>
          </div>
        ))}
        {diagnostics.length > 6 ? <div className="text-muted-foreground">{diagnostics.length - 6} more diagnostic(s) are available in the Package Export panel.</div> : null}
      </div>
    </div>
  );
}

export function PackageExportDialog({ open, onOpenChange, project, projectRoot, projectFilePath }: PackageExportDialogProps) {
  const running = usePackageExportStore((state) => state.running);
  const lastResult = usePackageExportStore((state) => state.lastResult);
  const [profile, setProfile] = useState<ExportProfileData | null>(null);

  useEffect(() => {
    if (open && project) setProfile(selectedExportProfile(project));
  }, [open, project]);

  const activeProfile = profile ?? (project ? selectedExportProfile(project) : null);
  const validationDiagnostics = useMemo(() => {
    if (!project) return [];
    return validateAuthoringProject(project);
  }, [project]);
  const preview = useMemo(() => {
    if (!project || !activeProfile) return null;
    return buildAuthoringRuntimeExport(project, { projectRoot, profile: activeProfile });
  }, [project, projectRoot, activeProfile]);

  if (!project || !activeProfile) return null;
  const currentProject: AuthoringProject = project;
  const currentProfile: ExportProfileData = activeProfile;
  const outputPath = currentProfile.outputPath || defaultOutputPath(currentProject, projectRoot, projectFilePath);
  const usesProjectShaders = hasAuthoringShadersOrMaterials(currentProject);
  const preflightDiagnostics = [...validationDiagnostics, ...(preview?.diagnostics ?? [])];
  const blockingDiagnostics = preflightDiagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warningCount = preflightDiagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
  const failedResultDiagnostics = lastResult && !lastResult.success && lastResult.outputPath === outputPath ? lastResult.diagnostics.filter((diagnostic) => diagnostic.severity === 'error') : [];
  const canExport = !running && blockingDiagnostics.length === 0 && outputPath.trim().length > 0;
  const hasProjectSettingsBlocker = blockingDiagnostics.some((diagnostic) => diagnostic.path === '/entrypoint' || diagnostic.path.startsWith('/settings/') || diagnostic.path.startsWith('/project/'));

  function openProjectSettings() {
    dispatchWorkspaceToolbarCommand('project-settings');
    onOpenChange(false);
  }

  async function chooseOutputPath() {
    const selected = await window.noveltea.selectPackageOutputPath(outputPath);
    if (selected) setProfile({ ...currentProfile, outputPath: selected });
  }

  async function runExport() {
    if (blockingDiagnostics.length > 0) return;
    let finalOutputPath = currentProfile.outputPath || outputPath;
    if (!finalOutputPath.trim()) {
      const selected = await window.noveltea.selectPackageOutputPath(defaultOutputPath(currentProject, projectRoot, projectFilePath));
      if (!selected) return;
      finalOutputPath = selected;
    }
    const result = await runPackageExportWorkflow({ project: currentProject, projectRoot, outputPath: finalOutputPath, profile: { ...currentProfile, outputPath: finalOutputPath } });
    if (result.success) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogTitle>Export Project</DialogTitle>
        <DialogDescription className="sr-only">Export a compiled project file.</DialogDescription>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="package-export-output">Output file</Label>
            <div className="flex gap-2">
              <Input id="package-export-output" className="font-mono text-[11px]" value={outputPath} onChange={(event) => setProfile({ ...currentProfile, outputPath: event.currentTarget.value })} />
              <Button type="button" variant="outline" onClick={chooseOutputPath}>Browse…</Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 rounded border p-3">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={currentProfile.includeChecksums} onChange={(event) => setProfile({ ...currentProfile, includeChecksums: event.currentTarget.checked })} />
              Include checksums
            </label>
            {usesProjectShaders ? (
              <>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={currentProfile.stripShaderSources} onChange={(event) => setProfile({ ...currentProfile, stripShaderSources: event.currentTarget.checked })} />
                  Strip shader sources
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={currentProfile.compileShadersBeforeExport} onChange={(event) => setProfile({ ...currentProfile, compileShadersBeforeExport: event.currentTarget.checked })} />
                  Compile shaders before export
                </label>
              </>
            ) : null}
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={currentProfile.includeAllProjectAssets} onChange={(event) => setProfile({ ...currentProfile, includeAllProjectAssets: event.currentTarget.checked, includeOnlyReferencedAssets: !event.currentTarget.checked })} />
              Include all project assets
            </label>
          </div>
          {usesProjectShaders ? (
            <div className="grid gap-2 rounded border p-3">
              <div className="font-medium">Shader variants</div>
              <div className="flex flex-wrap gap-3">
                {exportShaderVariantValues.map((variant) => (
                  <label key={variant} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={currentProfile.shaderVariants.includes(variant)} onChange={() => setProfile(toggleVariant(currentProfile, variant))} />
                    {variant}
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          <div className="rounded border p-3 text-xs">
            <div className="mb-2 font-medium">Manifest preview</div>
            <div className="grid grid-cols-2 gap-2 text-muted-foreground">
              <div>Project: <span className="text-foreground">{currentProject.project.name}</span></div>
              <div>Version: <span className="text-foreground">{currentProject.project.version}</span></div>
              <div>Package entries: <span className="text-foreground">{preview?.manifestPreview.entryCount ?? 0}</span></div>
              <div>Assets: <span className="text-foreground">{preview?.fileEntries.length ?? 0}</span></div>
              <div>Errors: <span className={blockingDiagnostics.length > 0 ? 'text-destructive' : 'text-foreground'}>{blockingDiagnostics.length}</span></div>
              <div>Warnings: <span className="text-foreground">{warningCount}</span></div>
            </div>
          </div>
          {blockingDiagnostics.length > 0 ? (
            <DiagnosticPreview title="Export is blocked" diagnostics={blockingDiagnostics} />
          ) : null}
          {failedResultDiagnostics.length > 0 ? (
            <DiagnosticPreview title="Last export failed" diagnostics={failedResultDiagnostics} />
          ) : null}
        </div>
        <DialogFooter>
          {hasProjectSettingsBlocker ? <Button variant="secondary" onClick={openProjectSettings} disabled={running}>Open Project Settings</Button> : null}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>Cancel</Button>
          <Button onClick={runExport} disabled={!canExport} title={blockingDiagnostics.length > 0 ? 'Fix export errors before exporting.' : undefined}>{running ? 'Exporting…' : blockingDiagnostics.length > 0 ? 'Fix Errors Before Export' : 'Export Project'}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
