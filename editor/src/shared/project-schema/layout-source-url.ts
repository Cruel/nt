import type { AuthoringProject } from './authoring-project';
import { parseAssetData } from './authoring-assets';
import type { LayoutSourceData } from './authoring-layouts';

function sourceUrlIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function inlineLayoutSourceUrl(layoutId: string): string {
  return `project:/__noveltea_inline_layout_${sourceUrlIdentifier(layoutId)}.rml`;
}

export function authoredLayoutSourceUrl(
  project: AuthoringProject,
  layoutId: string,
  rml: LayoutSourceData,
): string {
  if (rml.sourceMode === 'asset' && rml.sourceAsset) {
    const asset = parseAssetData(project.assets[rml.sourceAsset.$ref.id]?.data);
    if (asset) return `project:/${asset.source.path}`;
  }
  return inlineLayoutSourceUrl(layoutId);
}
