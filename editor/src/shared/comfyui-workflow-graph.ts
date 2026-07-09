import type { ComfyUiWorkflowDiagnostic } from './comfyui-workflows';

export interface ComfyUiApiWorkflowNode {
  id: string;
  classType: string;
  title: string | null;
  inputs: Record<string, unknown>;
}

export interface ComfyUiGraphLink {
  fromNodeId: string;
  fromOutputIndex: number;
  toNodeId: string;
  toInputName: string;
}

export interface ComfyUiAnalyzedWorkflow {
  nodes: ComfyUiApiWorkflowNode[];
  links: ComfyUiGraphLink[];
  classTypes: string[];
  diagnostics: ComfyUiWorkflowDiagnostic[];
  looksLikeApiWorkflow: boolean;
  looksLikeSaveWorkflow: boolean;
}

export interface ComfyUiObjectInfoCompatibility {
  available: boolean;
  missingClassTypes: string[];
  diagnostics: ComfyUiWorkflowDiagnostic[];
}

const saveWorkflowRootFields = new Set(['nodes', 'links', 'groups', 'last_node_id', 'last_link_id', 'version']);

function diagnostic(path: string, message: string, severity: ComfyUiWorkflowDiagnostic['severity'] = 'warning'): ComfyUiWorkflowDiagnostic {
  return { severity, category: 'comfyui-workflows', path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nodeTitle(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const meta = value._meta;
  if (!isRecord(meta) || typeof meta.title !== 'string' || !meta.title.trim()) return null;
  return meta.title;
}

export function isComfyUiGraphLinkValue(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]);
}

export function analyzeComfyUiApiWorkflow(value: unknown): ComfyUiAnalyzedWorkflow {
  const diagnostics: ComfyUiWorkflowDiagnostic[] = [];
  if (!isRecord(value)) {
    return {
      nodes: [],
      links: [],
      classTypes: [],
      diagnostics: [diagnostic('/', 'ComfyUI workflow JSON must be an object.', 'error')],
      looksLikeApiWorkflow: false,
      looksLikeSaveWorkflow: false,
    };
  }

  const rootEntries = Object.entries(value);
  const saveFields = rootEntries.map(([key]) => key).filter((key) => saveWorkflowRootFields.has(key));
  const looksLikeSaveWorkflow = saveFields.length > 0 || (Array.isArray(value.nodes) && Array.isArray(value.links));
  if (looksLikeSaveWorkflow) {
    diagnostics.push(diagnostic('/', 'This looks like a ComfyUI save-format workflow. Use File -> Export Workflow (API) in ComfyUI.', 'error'));
  }

  const nodes: ComfyUiApiWorkflowNode[] = [];
  for (const [id, nodeValue] of rootEntries) {
    if (!isRecord(nodeValue)) continue;
    if (typeof nodeValue.class_type !== 'string') continue;
    if (!isRecord(nodeValue.inputs)) {
      diagnostics.push(diagnostic(`/${id}/inputs`, `Node ${id} is missing an inputs object.`, 'warning'));
      continue;
    }
    nodes.push({
      id,
      classType: nodeValue.class_type,
      title: nodeTitle(nodeValue),
      inputs: nodeValue.inputs,
    });
  }

  const likelyNodeEntries = rootEntries.filter(([, nodeValue]) => isRecord(nodeValue) && 'class_type' in nodeValue);
  const looksLikeApiWorkflow = nodes.length > 0 && likelyNodeEntries.length >= Math.max(1, Math.floor(rootEntries.length / 2)) && !looksLikeSaveWorkflow;
  if (!looksLikeApiWorkflow && !looksLikeSaveWorkflow) {
    diagnostics.push(diagnostic('/', 'This does not look like a ComfyUI API workflow export.', 'error'));
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const links: ComfyUiGraphLink[] = [];
  for (const node of nodes) {
    for (const [inputName, inputValue] of Object.entries(node.inputs)) {
      if (!isComfyUiGraphLinkValue(inputValue)) continue;
      links.push({
        fromNodeId: inputValue[0],
        fromOutputIndex: inputValue[1],
        toNodeId: node.id,
        toInputName: inputName,
      });
      if (!nodeIds.has(inputValue[0])) {
        diagnostics.push(diagnostic(`/${node.id}/inputs/${inputName}`, `Input ${node.id}.${inputName} links to missing node ${inputValue[0]}.`, 'warning'));
      }
    }
  }

  return {
    nodes,
    links,
    classTypes: [...new Set(nodes.map((node) => node.classType))].sort(),
    diagnostics,
    looksLikeApiWorkflow,
    looksLikeSaveWorkflow,
  };
}

export function analyzeComfyUiObjectInfoCompatibility(analysis: ComfyUiAnalyzedWorkflow, objectInfo: unknown): ComfyUiObjectInfoCompatibility {
  if (!isRecord(objectInfo)) {
    return {
      available: false,
      missingClassTypes: [],
      diagnostics: [diagnostic('/object_info', 'ComfyUI object_info was unavailable; class compatibility could not be checked.', 'warning')],
    };
  }
  const missingClassTypes = analysis.classTypes.filter((classType) => !(classType in objectInfo));
  return {
    available: true,
    missingClassTypes,
    diagnostics: missingClassTypes.map((classType) => diagnostic('/object_info', `Current ComfyUI server is missing node class ${classType}.`, 'error')),
  };
}
