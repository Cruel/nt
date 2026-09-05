import type {
  AssetMetadataInspectionGroup,
  AssetProvenanceEntity,
  AssetProvenanceStage,
  AssetWorkflowMetadata,
} from '../../shared/asset-metadata-inspection';
import { NOVELTEA_COMFYUI_METADATA_MARKERS } from '../../shared/comfyui-metadata';

export interface ComfyUiRecognizedGeneration {
  provenance?: { stages: AssetProvenanceStage[] };
  prompt?: string;
  negativePrompt?: string;
  facts: Array<{ id: 'model' | 'seed' | 'steps' | 'cfg' | 'dimensions'; value: string }>;
}

const COMFYUI_ENTITY: AssetProvenanceEntity = { id: 'comfyui', label: 'ComfyUI' };
const MODEL_REGISTRY: Record<string, AssetProvenanceEntity> = {
  'flux-2-klein-4b-fp8.safetensors': {
    id: 'black-forest-labs.flux-2-klein-4b',
    label: 'Flux 2 Klein 4B',
  },
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nodeTitle(node: JsonRecord): string | null {
  const metadata = record(node._meta);
  return typeof metadata?.title === 'string' ? metadata.title : null;
}

function scalarInput(node: JsonRecord, names: readonly string[]): string | number | null {
  const inputs = record(node.inputs);
  if (!inputs) return null;
  for (const name of names) {
    const value = inputs[name];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
      return value;
  }
  return null;
}

function markedNode(graph: JsonRecord, marker: string): JsonRecord | null {
  for (const candidate of Object.values(graph)) {
    const node = record(candidate);
    if (node && nodeTitle(node) === marker) return node;
  }
  return null;
}

function stringValue(
  graph: JsonRecord,
  marker: string,
  inputs: readonly string[],
): string | undefined {
  const node = markedNode(graph, marker);
  if (!node) return undefined;
  const value = scalarInput(node, inputs);
  return typeof value === 'string' ? value : undefined;
}

function numericValue(
  graph: JsonRecord,
  marker: string,
  inputs: readonly string[],
): number | undefined {
  const node = markedNode(graph, marker);
  if (!node) return undefined;
  const value = scalarInput(node, inputs);
  return typeof value === 'number' ? value : undefined;
}

function parseJsonText(value: unknown): JsonRecord | null {
  if (typeof value !== 'string') return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function pngMetadataValue(groups: AssetMetadataInspectionGroup[], key: string): unknown {
  const png = groups.find((group) => group.namespace === 'PNG');
  return png?.items.find((candidate) => candidate.key === key)?.value;
}

function looksLikeUiWorkflow(value: JsonRecord | null): value is JsonRecord {
  if (!value || !Array.isArray(value.nodes)) return false;
  return value.nodes.some((candidate) => {
    const node = record(candidate);
    return node !== null && (typeof node.type === 'string' || typeof node.id === 'number');
  });
}

function looksLikeApiGraph(value: JsonRecord | null): value is JsonRecord {
  if (!value) return false;
  const nodes = Object.values(value);
  return (
    nodes.length > 0 &&
    nodes.every((candidate) => {
      const node = record(candidate);
      return node !== null && typeof node.class_type === 'string';
    })
  );
}

function recognizeGraph(graph: JsonRecord): ComfyUiRecognizedGeneration | undefined {
  const prompt = stringValue(graph, NOVELTEA_COMFYUI_METADATA_MARKERS.prompt, ['value', 'text']);
  const negativePrompt = stringValue(graph, NOVELTEA_COMFYUI_METADATA_MARKERS.negativePrompt, [
    'value',
    'text',
  ]);
  const exactModel = stringValue(graph, NOVELTEA_COMFYUI_METADATA_MARKERS.model, [
    'unet_name',
    'ckpt_name',
    'model_name',
    'value',
  ]);
  const isImageEdit = markedNode(graph, NOVELTEA_COMFYUI_METADATA_MARKERS.sourceImage) !== null;
  const seed = numericValue(graph, NOVELTEA_COMFYUI_METADATA_MARKERS.seed, [
    'noise_seed',
    'seed',
    'value',
  ]);
  const steps = numericValue(graph, NOVELTEA_COMFYUI_METADATA_MARKERS.steps, ['steps', 'value']);
  const cfg = numericValue(graph, NOVELTEA_COMFYUI_METADATA_MARKERS.cfg, ['cfg', 'value']);
  const width = numericValue(graph, NOVELTEA_COMFYUI_METADATA_MARKERS.width, ['width', 'value']);
  const height = numericValue(graph, NOVELTEA_COMFYUI_METADATA_MARKERS.height, ['height', 'value']);

  if (
    ![prompt, negativePrompt, exactModel, seed, steps, cfg, width, height].some(
      (value) => value !== undefined,
    )
  )
    return undefined;

  const facts: ComfyUiRecognizedGeneration['facts'] = [];
  if (exactModel)
    facts.push({ id: 'model', value: MODEL_REGISTRY[exactModel]?.label ?? exactModel });
  if (seed !== undefined) facts.push({ id: 'seed', value: String(seed) });
  if (steps !== undefined) facts.push({ id: 'steps', value: String(steps) });
  if (cfg !== undefined) facts.push({ id: 'cfg', value: String(cfg) });
  if (width !== undefined && height !== undefined)
    facts.push({ id: 'dimensions', value: `${width} × ${height}` });

  const provenance: ComfyUiRecognizedGeneration['provenance'] = exactModel
    ? {
        stages: [
          {
            id: isImageEdit ? 'noveltea-comfyui-edit' : 'noveltea-comfyui-generation',
            role: isImageEdit ? 'edited' : 'generated',
            tool: COMFYUI_ENTITY,
            model: MODEL_REGISTRY[exactModel] ?? {
              id: `comfyui.model:${exactModel}`,
              label: exactModel,
            },
          },
        ],
      }
    : {
        stages: [
          {
            id: 'noveltea-comfyui-processing',
            role: 'processed',
            tool: COMFYUI_ENTITY,
          },
        ],
      };

  return {
    provenance,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(negativePrompt !== undefined ? { negativePrompt } : {}),
    facts,
  };
}

export function identifyComfyUiWorkflowMetadata(
  groups: AssetMetadataInspectionGroup[],
): AssetWorkflowMetadata[] | undefined {
  const promptGraph = parseJsonText(pngMetadataValue(groups, 'prompt'));
  const workflowGraph = parseJsonText(pngMetadataValue(groups, 'workflow'));
  if (
    !looksLikeApiGraph(promptGraph) &&
    !looksLikeApiGraph(workflowGraph) &&
    !looksLikeUiWorkflow(workflowGraph)
  )
    return undefined;
  return [{ tool: COMFYUI_ENTITY, kind: 'workflow' }];
}

export function recognizeComfyUiMetadata(
  groups: AssetMetadataInspectionGroup[],
): ComfyUiRecognizedGeneration | undefined {
  const promptGraph = parseJsonText(pngMetadataValue(groups, 'prompt'));
  if (looksLikeApiGraph(promptGraph)) {
    const executed = recognizeGraph(promptGraph);
    if (executed) return executed;
  }

  // Fallback is intentionally narrow: only API-graph-shaped workflow metadata with exact NovelTea
  // markers is interpreted. Ordinary ComfyUI save-format workflow JSON stays raw-only.
  const workflowGraph = parseJsonText(pngMetadataValue(groups, 'workflow'));
  return looksLikeApiGraph(workflowGraph) ? recognizeGraph(workflowGraph) : undefined;
}
