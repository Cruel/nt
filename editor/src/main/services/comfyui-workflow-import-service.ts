import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeComfyUiServerUrl } from '../../shared/comfyui';
import { analyzeComfyUiApiWorkflow, analyzeComfyUiObjectInfoCompatibility } from '../../shared/comfyui-workflow-graph';
import { inferComfyUiWorkflowCandidates } from '../../shared/comfyui-workflow-inference';
import {
  parseComfyUiWorkflowDefinition,
  resolveComfyUiWorkflowBinding,
  validateComfyUiWorkflowDefinitionContract,
  resolvedComfyUiWorkflowOutputNodeIdList,
  SUPPORTED_COMFYUI_WORKFLOW_ROLES,
  type ComfyUiAnalyzeWorkflowImportRequest,
  type ComfyUiAnalyzeWorkflowImportResponse,
  type ComfyUiRepairWorkflowManifestRequest,
  type ComfyUiSaveImportedWorkflowRequest,
  type ComfyUiSaveImportedWorkflowResponse,
  type ComfyUiWorkflowDefinition,
  type ComfyUiWorkflowDiagnostic,
  type ComfyUiWorkflowGraphLike,
} from '../../shared/comfyui-workflows';

function diagnostic(pathValue: string, message: string, severity: ComfyUiWorkflowDiagnostic['severity'] = 'error'): ComfyUiWorkflowDiagnostic {
  return { severity, category: 'comfyui-workflows', path: pathValue, message };
}

function projectWorkflowsRoot(projectFilePath: string) {
  return path.join(path.dirname(path.resolve(projectFilePath)), 'workflows');
}

function parseWorkflowJson(text: string): { ok: true; value: unknown } | { ok: false; diagnostics: ComfyUiWorkflowDiagnostic[]; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workflow JSON is invalid.';
    return { ok: false, diagnostics: [diagnostic('/workflow', `Workflow JSON is invalid: ${message}`)], error: message };
  }
}

function safeImportFileName(value: string, extension: '.workflow.json' | '.manifest.json', label: string): string {
  if (!value || typeof value !== 'string') throw new Error(`${label} is required.`);
  if (!value.endsWith(extension)) throw new Error(`${label} must end with ${extension}.`);
  if (path.isAbsolute(value) || path.basename(value) !== value || value.includes('/') || value.includes('\\') || value.includes('..') || value.startsWith('.')) {
    throw new Error(`${label} must be a safe file name in the workflows directory.`);
  }
  return value;
}

function workflowHasBlockingShapeError(workflowJson: unknown) {
  const analysis = analyzeComfyUiApiWorkflow(workflowJson);
  return {
    analysis,
    diagnostics: analysis.diagnostics,
    blocking: !analysis.looksLikeApiWorkflow || analysis.looksLikeSaveWorkflow || analysis.diagnostics.some((item) => item.severity === 'error'),
  };
}

async function fetchObjectInfo(request: ComfyUiAnalyzeWorkflowImportRequest): Promise<unknown | null> {
  const config = request.config;
  if (!config?.enabled) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const base = normalizeComfyUiServerUrl(config.serverUrl);
    const url = new URL('/object_info', base);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function validateManifestBindings(workflow: ComfyUiWorkflowGraphLike, definition: ComfyUiWorkflowDefinition): ComfyUiWorkflowDiagnostic[] {
  const diagnostics: ComfyUiWorkflowDiagnostic[] = [...validateComfyUiWorkflowDefinitionContract(definition)];
  for (const [semanticKey, binding] of Object.entries(definition.bindings)) {
    if (!binding) continue;
    const resolution = resolveComfyUiWorkflowBinding(workflow, binding);
    if (!resolution.ok) diagnostics.push(diagnostic(`/bindings/${semanticKey}`, resolution.message ?? `Could not resolve binding ${semanticKey}.`));
  }
  try {
    resolvedComfyUiWorkflowOutputNodeIdList(workflow, definition);
  } catch (error) {
    diagnostics.push(diagnostic('/outputBindings/images', error instanceof Error ? error.message : 'Workflow output bindings could not be resolved.'));
  }
  return diagnostics;
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomic(destination: string, contents: string) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, contents, 'utf8');
  await fs.rename(temporary, destination);
}

export async function analyzeComfyUiWorkflowImport(request: ComfyUiAnalyzeWorkflowImportRequest): Promise<ComfyUiAnalyzeWorkflowImportResponse> {
  const parsed = parseWorkflowJson(request.workflowJsonText);
  if (!parsed.ok) return { ok: false, roleCandidates: {}, diagnostics: parsed.diagnostics, error: parsed.error };

  const { analysis, diagnostics, blocking } = workflowHasBlockingShapeError(parsed.value);
  const roleCandidates = Object.fromEntries(SUPPORTED_COMFYUI_WORKFLOW_ROLES.map((role) => [
    role,
    { candidates: inferComfyUiWorkflowCandidates(analysis, role) },
  ])) as ComfyUiAnalyzeWorkflowImportResponse['roleCandidates'];

  if (blocking) {
    return { ok: false, analysis, roleCandidates, diagnostics, error: diagnostics.find((item) => item.severity === 'error')?.message ?? 'Workflow import analysis failed.' };
  }

  const objectInfo = await fetchObjectInfo(request);
  if (objectInfo) {
    diagnostics.push(...analyzeComfyUiObjectInfoCompatibility(analysis, objectInfo).diagnostics);
  } else {
    diagnostics.push(diagnostic('/object_info', 'ComfyUI object_info was unavailable; class compatibility could not be checked.', 'warning'));
  }

  return { ok: true, analysis, roleCandidates, diagnostics };
}

export async function saveImportedComfyUiWorkflow(request: ComfyUiSaveImportedWorkflowRequest): Promise<ComfyUiSaveImportedWorkflowResponse> {
  if (!request.projectFilePath) {
    return { ok: false, success: false, diagnostics: [diagnostic('/projectFilePath', 'Save the project before importing ComfyUI workflows.')], error: 'Project file path is required.' };
  }

  try {
    const workflowFileName = safeImportFileName(request.workflowFileName, '.workflow.json', 'workflowFileName');
    const manifestFileName = safeImportFileName(request.manifestFileName, '.manifest.json', 'manifestFileName');
    const parsed = parseWorkflowJson(request.workflowJsonText);
    if (!parsed.ok) return { ok: false, success: false, diagnostics: parsed.diagnostics, error: parsed.error };

    const shape = workflowHasBlockingShapeError(parsed.value);
    if (shape.blocking) {
      return { ok: false, success: false, diagnostics: shape.diagnostics, error: shape.diagnostics.find((item) => item.severity === 'error')?.message ?? 'Workflow import failed.' };
    }

    const definition = parseComfyUiWorkflowDefinition(request.manifest, manifestFileName);
    if (definition.workflowFile !== workflowFileName) {
      return { ok: false, success: false, diagnostics: [diagnostic('/manifest/workflowFile', `Manifest workflowFile must match ${workflowFileName}.`)], error: 'Manifest workflowFile does not match the requested workflow file name.' };
    }

    const bindingDiagnostics = validateManifestBindings(parsed.value as ComfyUiWorkflowGraphLike, definition);
    if (bindingDiagnostics.some((item) => item.severity === 'error')) {
      return { ok: false, success: false, diagnostics: bindingDiagnostics, error: bindingDiagnostics[0]?.message ?? 'Workflow bindings are invalid.' };
    }

    const workflowsRoot = projectWorkflowsRoot(request.projectFilePath);
    const workflowPath = path.join(workflowsRoot, workflowFileName);
    const manifestPath = path.join(workflowsRoot, manifestFileName);
    if (!request.overwrite && (await pathExists(workflowPath) || await pathExists(manifestPath))) {
      return { ok: false, success: false, diagnostics: [diagnostic('/workflows', 'Workflow or manifest file already exists. Enable overwrite to replace it.')], error: 'Workflow import would overwrite existing files.' };
    }

    await fs.mkdir(workflowsRoot, { recursive: true });
    await writeFileAtomic(workflowPath, `${JSON.stringify(parsed.value, null, 2)}\n`);
    await writeFileAtomic(manifestPath, `${JSON.stringify(request.manifest, null, 2)}\n`);
    return { ok: true, success: true, workflowFile: workflowFileName, manifestFile: manifestFileName, definition, diagnostics: bindingDiagnostics };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save imported ComfyUI workflow.';
    return { ok: false, success: false, diagnostics: [diagnostic('/workflows', message)], error: message };
  }
}

export async function repairComfyUiWorkflowManifest(request: ComfyUiRepairWorkflowManifestRequest): Promise<ComfyUiSaveImportedWorkflowResponse> {
  if (!request.projectFilePath) {
    return { ok: false, success: false, diagnostics: [diagnostic('/projectFilePath', 'Save the project before repairing ComfyUI workflows.')], error: 'Project file path is required.' };
  }

  try {
    const manifestFileName = safeImportFileName(request.manifestFileName, '.manifest.json', 'manifestFileName');
    const definition = parseComfyUiWorkflowDefinition(request.manifest, manifestFileName);
    const workflowsRoot = projectWorkflowsRoot(request.projectFilePath);
    const workflowPath = path.join(workflowsRoot, definition.workflowFile);
    const workflowJsonText = await fs.readFile(workflowPath, 'utf8');
    const parsed = parseWorkflowJson(workflowJsonText);
    if (!parsed.ok) return { ok: false, success: false, diagnostics: parsed.diagnostics, error: parsed.error };

    const shape = workflowHasBlockingShapeError(parsed.value);
    if (shape.blocking) {
      return { ok: false, success: false, diagnostics: shape.diagnostics, error: shape.diagnostics.find((item) => item.severity === 'error')?.message ?? 'Workflow repair failed.' };
    }

    const bindingDiagnostics = validateManifestBindings(parsed.value as ComfyUiWorkflowGraphLike, definition);
    if (bindingDiagnostics.some((item) => item.severity === 'error')) {
      return { ok: false, success: false, diagnostics: bindingDiagnostics, error: bindingDiagnostics[0]?.message ?? 'Workflow bindings are invalid.' };
    }

    await writeFileAtomic(path.join(workflowsRoot, manifestFileName), `${JSON.stringify(request.manifest, null, 2)}\n`);
    return { ok: true, success: true, workflowFile: definition.workflowFile, manifestFile: manifestFileName, definition, diagnostics: bindingDiagnostics };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to repair ComfyUI workflow manifest.';
    return { ok: false, success: false, diagnostics: [diagnostic('/workflows', message)], error: message };
  }
}
