import type { ComfyUiAnalyzedWorkflow, ComfyUiApiWorkflowNode } from './comfyui-workflow-graph';
import {
  COMFYUI_WORKFLOW_ROLE_CATALOG,
  type ComfyUiSemanticInput,
  type ComfyUiSemanticOutput,
  type ComfyUiWorkflowRole,
  type ComfyUiWorkflowValueType,
} from './comfyui-workflows';

export type ComfyUiBindingCandidateConfidence = 'high' | 'medium' | 'low';

export interface ComfyUiBindingCandidate {
  semanticKey: ComfyUiSemanticInput | ComfyUiSemanticOutput;
  nodeId: string;
  classType: string;
  nodeTitle: string | null;
  inputName: string;
  valueType: ComfyUiWorkflowValueType | 'image-list';
  confidence: ComfyUiBindingCandidateConfidence;
  score: number;
  reasons: string[];
  currentValue?: unknown;
}

export type ComfyUiRoleCandidateMap = Partial<
  Record<ComfyUiSemanticInput | ComfyUiSemanticOutput, ComfyUiBindingCandidate[]>
>;

const titleSynonyms: Record<ComfyUiSemanticInput | ComfyUiSemanticOutput, string[]> = {
  prompt: ['prompt', 'positive prompt', 'text prompt'],
  negativePrompt: ['negative prompt', 'negative'],
  sourceImage: ['source image', 'input image', 'image'],
  maskImage: ['mask image', 'mask'],
  width: ['width'],
  height: ['height'],
  seed: ['seed', 'noise seed'],
  steps: ['steps'],
  cfg: ['cfg', 'guidance'],
  filenamePrefix: ['filename prefix', 'prefix'],
  images: ['output', 'save image', 'preview image'],
};

const samplerStepClasses = new Set([
  'KSampler',
  'KSamplerAdvanced',
  'SamplerCustom',
  'SamplerCustomAdvanced',
  'Flux2Scheduler',
  'BasicScheduler',
]);
const latentSizeClasses = new Set([
  'EmptyLatentImage',
  'EmptyFlux2LatentImage',
  'EmptySD3LatentImage',
]);

function normalized(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? '';
}

function isGraphLink(value: unknown) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    Number.isInteger(value[1])
  );
}

function linkedDownstreamClasses(
  analysis: ComfyUiAnalyzedWorkflow,
  nodeId: string,
  inputName?: string,
): string[] {
  const downstreamIds = analysis.links
    .filter((link) => link.fromNodeId === nodeId && (!inputName || link.toInputName === inputName))
    .map((link) => link.toNodeId);
  return downstreamIds
    .map((id) => analysis.nodes.find((node) => node.id === id)?.classType)
    .filter((classType): classType is string => Boolean(classType));
}

function compatibleValueType(
  semanticKey: ComfyUiSemanticInput | ComfyUiSemanticOutput,
  inputName: string,
  classType: string,
): ComfyUiWorkflowValueType | 'image-list' | null {
  if (semanticKey === 'images') return 'image-list';
  if (semanticKey === 'sourceImage' || semanticKey === 'maskImage') return 'image-upload-reference';
  if (
    semanticKey === 'width' ||
    semanticKey === 'height' ||
    semanticKey === 'seed' ||
    semanticKey === 'steps'
  )
    return 'integer';
  if (semanticKey === 'cfg') return 'number';
  if (
    semanticKey === 'prompt' ||
    semanticKey === 'negativePrompt' ||
    semanticKey === 'filenamePrefix'
  )
    return 'string';
  if (classType || inputName) return null;
  return null;
}

function baseCandidate(
  node: ComfyUiApiWorkflowNode,
  semanticKey: ComfyUiSemanticInput | ComfyUiSemanticOutput,
  inputName: string,
  valueType: ComfyUiWorkflowValueType | 'image-list',
  currentValue: unknown,
): ComfyUiBindingCandidate {
  return {
    semanticKey,
    nodeId: node.id,
    classType: node.classType,
    nodeTitle: node.title,
    inputName,
    valueType,
    confidence: 'low',
    score: 0,
    reasons: [],
    currentValue: isGraphLink(currentValue) ? undefined : currentValue,
  };
}

function addTitleScore(candidate: ComfyUiBindingCandidate, marker: string | undefined) {
  const title = normalized(candidate.nodeTitle);
  if (marker && title === marker.toLowerCase()) {
    candidate.score += 100;
    candidate.reasons.push('title marker');
    return;
  }
  const synonyms = titleSynonyms[candidate.semanticKey];
  if (synonyms.some((synonym) => title === synonym || title.includes(synonym))) {
    candidate.score += 25;
    candidate.reasons.push('title match');
  }
}

function finalizeCandidate(candidate: ComfyUiBindingCandidate) {
  candidate.confidence = candidate.score >= 80 ? 'high' : candidate.score >= 35 ? 'medium' : 'low';
  return candidate;
}

function inferNodeInputCandidate(
  analysis: ComfyUiAnalyzedWorkflow,
  role: ComfyUiWorkflowRole,
  node: ComfyUiApiWorkflowNode,
  inputName: string,
  currentValue: unknown,
  semanticKey: ComfyUiSemanticInput,
): ComfyUiBindingCandidate | null {
  const valueType = compatibleValueType(semanticKey, inputName, node.classType);
  if (!valueType || valueType === 'image-list') return null;
  const candidate = baseCandidate(node, semanticKey, inputName, valueType, currentValue);
  addTitleScore(candidate, COMFYUI_WORKFLOW_ROLE_CATALOG[role].inference.titleMarkers[semanticKey]);

  if (
    (semanticKey === 'prompt' || semanticKey === 'negativePrompt') &&
    inputName === 'text' &&
    node.classType === 'CLIPTextEncode'
  ) {
    candidate.score += 35;
    candidate.reasons.push('CLIPTextEncode text');
    if (semanticKey === 'negativePrompt' && normalized(node.title).includes('negative'))
      candidate.score += 20;
    if (semanticKey === 'prompt' && !normalized(node.title).includes('negative'))
      candidate.score += 10;
  }
  if (
    (semanticKey === 'prompt' || semanticKey === 'negativePrompt') &&
    inputName === 'value' &&
    node.classType === 'PrimitiveStringMultiline'
  ) {
    candidate.score += 25;
    candidate.reasons.push('primitive text');
    if (linkedDownstreamClasses(analysis, node.id).includes('CLIPTextEncode')) {
      candidate.score += 25;
      candidate.reasons.push('feeds CLIPTextEncode');
    }
  }
  if (semanticKey === 'sourceImage' && inputName === 'image' && node.classType === 'LoadImage') {
    candidate.score += role === 'image.edit' ? 55 : 20;
    candidate.reasons.push('LoadImage input');
  }
  if (
    semanticKey === 'maskImage' &&
    (inputName === 'mask' || normalized(node.title).includes('mask'))
  ) {
    candidate.score += 35;
    candidate.reasons.push('mask input');
  }
  if (
    (semanticKey === 'width' || semanticKey === 'height') &&
    inputName === 'value' &&
    node.classType === 'PrimitiveInt'
  ) {
    candidate.score += 35;
    candidate.reasons.push('primitive size');
  }
  if (
    (semanticKey === 'width' || semanticKey === 'height') &&
    inputName === semanticKey &&
    latentSizeClasses.has(node.classType) &&
    !isGraphLink(currentValue)
  ) {
    candidate.score += 40;
    candidate.reasons.push('latent size literal');
  }
  if (semanticKey === 'seed' && (inputName === 'noise_seed' || inputName === 'seed')) {
    candidate.score += node.classType === 'RandomNoise' ? 85 : 35;
    candidate.reasons.push(node.classType === 'RandomNoise' ? 'RandomNoise seed' : 'seed input');
  }
  if (semanticKey === 'steps' && inputName === 'steps') {
    candidate.score += samplerStepClasses.has(node.classType) ? 55 : 35;
    candidate.reasons.push('steps input');
  }
  if (semanticKey === 'cfg' && inputName === 'cfg') {
    candidate.score += 45;
    candidate.reasons.push('cfg input');
  }
  if (
    semanticKey === 'filenamePrefix' &&
    inputName === 'filename_prefix' &&
    node.classType === 'SaveImage'
  ) {
    candidate.score += 85;
    candidate.reasons.push('SaveImage filename prefix');
  }

  return candidate.score > 0 ? finalizeCandidate(candidate) : null;
}

function inferOutputCandidate(
  role: ComfyUiWorkflowRole,
  node: ComfyUiApiWorkflowNode,
): ComfyUiBindingCandidate | null {
  if (node.classType !== 'SaveImage' && node.classType !== 'PreviewImage') return null;
  const candidate = baseCandidate(node, 'images', 'images', 'image-list', node.inputs.images);
  addTitleScore(candidate, COMFYUI_WORKFLOW_ROLE_CATALOG[role].inference.titleMarkers.images);
  candidate.score += node.classType === 'SaveImage' ? 70 : 55;
  candidate.reasons.push(node.classType);
  if ('images' in node.inputs) {
    candidate.score += 10;
    candidate.reasons.push('image input');
  }
  return finalizeCandidate(candidate);
}

function reduceAmbiguousCandidates(candidates: ComfyUiBindingCandidate[]) {
  const highWithoutMarker = candidates.filter(
    (candidate) => candidate.confidence === 'high' && !candidate.reasons.includes('title marker'),
  );
  if (highWithoutMarker.length <= 1) return candidates;
  return candidates.map((candidate) => {
    if (!highWithoutMarker.includes(candidate)) return candidate;
    return {
      ...candidate,
      confidence: 'medium' as const,
      reasons: [...candidate.reasons, 'ambiguous match'],
    };
  });
}

export function inferComfyUiWorkflowCandidates(
  analysis: ComfyUiAnalyzedWorkflow,
  role: ComfyUiWorkflowRole,
): ComfyUiRoleCandidateMap {
  const result: ComfyUiRoleCandidateMap = {};
  const roleDefinition = COMFYUI_WORKFLOW_ROLE_CATALOG[role];
  for (const node of analysis.nodes) {
    for (const [inputName, currentValue] of Object.entries(node.inputs)) {
      for (const semanticKey of Object.keys(
        roleDefinition.contract.inputs,
      ) as ComfyUiSemanticInput[]) {
        const candidate = inferNodeInputCandidate(
          analysis,
          role,
          node,
          inputName,
          currentValue,
          semanticKey,
        );
        if (!candidate) continue;
        result[semanticKey] = [...(result[semanticKey] ?? []), candidate];
      }
    }
    const outputCandidate = inferOutputCandidate(role, node);
    if (outputCandidate) result.images = [...(result.images ?? []), outputCandidate];
  }

  for (const semanticKey of Object.keys(result) as Array<
    ComfyUiSemanticInput | ComfyUiSemanticOutput
  >) {
    result[semanticKey] = reduceAmbiguousCandidates(result[semanticKey] ?? []).sort(
      (left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId),
    );
  }
  return result;
}
