import { resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import {
  buildPlatformExportProfilesTab,
  buildPlatformExportTab,
  buildSettingsTab,
} from '@/workbench/editor-registry';
import type { WorkbenchNavigationRequest } from '@/workbench/workbench-navigation';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import type { ProjectValidationDiagnostic } from '../../shared/project-schema/project-validation';

function target(tab: WorkbenchNavigationRequest['tab'], id: string): WorkbenchNavigationRequest {
  return { tab, target: { id, block: 'center', flash: true, focus: true } };
}

function nonContentTarget(path: string): WorkbenchNavigationRequest | null {
  if (path.startsWith('/settings/platformExport')) {
    return target(buildPlatformExportProfilesTab(), 'platformExportProfiles.profile');
  }
  if (path.startsWith('/editor/export/toolchains') || path.startsWith('/editor/export/signing')) {
    return target(buildSettingsTab(), 'settings.export');
  }
  if (path.startsWith('/export/template')) {
    return target(buildPlatformExportTab(), 'platformExport.preflight.template');
  }
  if (path.startsWith('/export/outputDirectory')) {
    return target(buildPlatformExportTab(), 'platformExport.outputDirectory');
  }
  if (
    path.startsWith('/preparedRuntimeExport') ||
    path.startsWith('/runtimePackageEvidence') ||
    path.startsWith('/packagePath')
  ) {
    return target(buildPlatformExportTab(), 'platformExport.runtimePackage');
  }
  return null;
}

export function resolvePlatformExportDiagnosticTarget(
  project: AuthoringProject,
  diagnostic: ProjectValidationDiagnostic,
): WorkbenchNavigationRequest | null {
  for (const path of [...diagnostic.ownerPaths, diagnostic.path]) {
    const contentTarget = resolveProjectDiagnosticTarget(project, path);
    if (contentTarget) return contentTarget;
    const exportTarget = nonContentTarget(path);
    if (exportTarget) return exportTarget;
  }
  return null;
}
