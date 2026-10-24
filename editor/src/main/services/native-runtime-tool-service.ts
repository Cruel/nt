import type { PackageExportOptions, ToolDiagnostic } from '../../shared/editor-tooling';
import {
  invokeNovelTeaNativeOperation,
  resolveNovelTeaCliPath,
} from '../../shared/noveltea-cli-subprocess';
import { classifyProjectValidationDiagnostics } from '../../shared/project-schema/project-diagnostic-projection';
import {
  inspectMediaTool,
  installedMediaTool,
  runMediaPreparation,
} from './media-preparation-service';

export function checkMediaTools() {
  return inspectMediaTool(installedMediaTool(resolveNovelTeaCliPath()));
}

export function prepareMedia(args: readonly string[]) {
  return runMediaPreparation(installedMediaTool(resolveNovelTeaCliPath()), args);
}

// These operations consume compiled runtime inputs; Project admission belongs
// to the caller's native session, not to this downstream tool transport.
export function runPlaybackSpec(project: unknown, spec: unknown) {
  return invokeNovelTeaNativeOperation('run-test', { project, spec });
}

export function runUiPlaybackSpec(
  project: unknown,
  spec: unknown,
  projectRoot: string | null = null,
  shaderMaterialMetadata: unknown = null,
) {
  return invokeNovelTeaNativeOperation('run-ui-test', {
    project,
    spec,
    projectRoot,
    shaderMaterialMetadata,
  });
}

export function exportPackage(
  project: unknown,
  outputPath: string,
  options?: PackageExportOptions,
) {
  return invokeNovelTeaNativeOperation('export-package', {
    project,
    outputPath,
    options: options ?? {},
  }).then((value) => normalizePackageToolResponse(value));
}

function normalizePackageToolResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.diagnostics)) return value;
  const diagnostics = classifyProjectValidationDiagnostics(record.diagnostics as ToolDiagnostic[], {
    producer: 'package-publication',
  });
  return { ...record, diagnostics };
}
