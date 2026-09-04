export const NOVELTEA_COMFYUI_METADATA_MARKERS = {
  prompt: 'noveltea.prompt',
  negativePrompt: 'noveltea.negativePrompt',
  model: 'noveltea.model',
  sourceImage: 'noveltea.sourceImage',
  seed: 'noveltea.seed',
  steps: 'noveltea.steps',
  cfg: 'noveltea.cfg',
  width: 'noveltea.width',
  height: 'noveltea.height',
} as const;

export type NovelTeaComfyUiMetadataRole = keyof typeof NOVELTEA_COMFYUI_METADATA_MARKERS;
