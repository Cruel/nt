import { parseAssetData } from './authoring-assets';
import {
  parseCharacterData,
  validateCharacterData,
  type CharacterAssetRef,
  type CharacterData,
  type CharacterExpressionData,
  type CharacterMaterialRef,
  type CharacterPoseData,
} from './authoring-characters';
import { parseMaterialData } from './authoring-materials';
import type { AuthoringProject } from './authoring-project';

export const CHARACTER_PREVIEW_SCHEMA = 'noveltea.character-preview.v1' as const;

export interface CharacterProjectDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(path: string, message: string, severity: 'error' | 'warning' | 'info' = 'error'): CharacterProjectDiagnostic {
  return { severity, path, message, category: 'character-project' };
}

function assetMetadata(project: AuthoringProject, ref: CharacterAssetRef | null): Record<string, unknown> | null {
  if (!ref) return null;
  const id = ref.$ref.id;
  const record = project.assets[id];
  const data = parseAssetData(record?.data);
  return {
    id,
    label: record?.label ?? id,
    kind: data?.kind ?? 'missing',
    path: data?.source.path ?? null,
    extension: data?.extension ?? null,
    contentHash: data?.contentHash ?? null,
  };
}

function materialMetadata(project: AuthoringProject, ref: CharacterMaterialRef | null): Record<string, unknown> | null {
  if (!ref) return null;
  const id = ref.$ref.id;
  const record = project.materials[id];
  const data = parseMaterialData(record?.data);
  return {
    id,
    label: record?.label ?? id,
    role: data?.role ?? null,
    shader: data?.shader?.$ref.id ?? null,
  };
}

function selectedPose(data: CharacterData): CharacterPoseData | null {
  return data.poses.find((pose) => pose.id === data.defaults.poseId)
    ?? data.poses[0]
    ?? null;
}

function selectedExpression(data: CharacterData): CharacterExpressionData | null {
  return data.expressions.find((expression) => expression.id === data.defaults.expressionId)
    ?? data.expressions[0]
    ?? null;
}

function posePayload(project: AuthoringProject, pose: CharacterPoseData | null): Record<string, unknown> | null {
  if (!pose) return null;
  return {
    id: pose.id,
    label: pose.label,
    sprite: assetMetadata(project, pose.sprite),
    material: materialMetadata(project, pose.material),
    offset: pose.offset,
    scale: pose.scale,
    anchor: pose.anchor,
  };
}

function expressionPayload(project: AuthoringProject, expression: CharacterExpressionData | null): Record<string, unknown> | null {
  if (!expression) return null;
  return {
    id: expression.id,
    label: expression.label,
    poseId: expression.poseId,
    sprite: assetMetadata(project, expression.sprite),
    material: materialMetadata(project, expression.material),
  };
}

function dependencyRevision(project: AuthoringProject, data: CharacterData): string[] {
  const assetIds = new Set<string>();
  const materialIds = new Set<string>();
  for (const pose of data.poses) {
    if (pose.sprite) assetIds.add(pose.sprite.$ref.id);
    if (pose.material) materialIds.add(pose.material.$ref.id);
  }
  for (const expression of data.expressions) {
    if (expression.sprite) assetIds.add(expression.sprite.$ref.id);
    if (expression.material) materialIds.add(expression.material.$ref.id);
  }
  const assets = [...assetIds].sort().map((id) => {
    const asset = project.assets[id];
    const assetData = parseAssetData(asset?.data);
    return `${id}:${assetData?.contentHash ?? assetData?.source.path ?? 'missing'}`;
  });
  const materials = [...materialIds].sort().map((id) => `${id}:${JSON.stringify(project.materials[id]?.data ?? null)}`);
  return [...assets, ...materials];
}

export function characterPreviewRevision(project: AuthoringProject, characterId: string): string {
  const record = project.characters[characterId];
  const data = parseCharacterData(record?.data);
  if (!record || !data) return `${characterId}:missing-or-invalid`;
  return JSON.stringify({ characterId, label: record.label, data, dependencies: dependencyRevision(project, data) });
}

export function buildCharacterPreviewDocumentData(project: AuthoringProject, characterId: string): Record<string, unknown> {
  const record = project.characters[characterId];
  const data = parseCharacterData(record?.data);
  if (!record || !data) {
    return {
      schema: CHARACTER_PREVIEW_SCHEMA,
      characterId,
      label: characterId,
      diagnostics: [diagnostic(`/characters/${characterId}/data`, 'Invalid character data.')],
    };
  }

  const pose = selectedPose(data);
  const expression = selectedExpression(data);
  const resolvedSprite = expression?.sprite ? assetMetadata(project, expression.sprite) : assetMetadata(project, pose?.sprite ?? null);
  const resolvedMaterial = expression?.material ? materialMetadata(project, expression.material) : materialMetadata(project, pose?.material ?? null);

  return {
    schema: CHARACTER_PREVIEW_SCHEMA,
    characterId,
    label: record.label,
    displayName: data.displayName,
    dialogue: data.dialogue,
    selected: { poseId: pose?.id ?? data.defaults.poseId, expressionId: expression?.id ?? data.defaults.expressionId },
    pose: posePayload(project, pose),
    expression: expressionPayload(project, expression),
    resolvedSprite,
    resolvedMaterial,
    diagnostics: validateCharacterData(project, characterId, record),
  };
}
