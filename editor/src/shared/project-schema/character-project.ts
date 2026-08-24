import { parseAssetData } from './authoring-assets';
import { resolveGameplayInstanceRecord } from './authoring-archetypes';
import {
  parseCharacterData,
  validateCharacterData,
  type CharacterAssetRef,
  type CharacterData,
  type CharacterExpressionData,
  type CharacterLayerCompositionData,
  type CharacterLayerOverrideData,
  type CharacterMaterialRef,
  type CharacterPoseData,
  type CharacterPresentationProfileData,
} from './authoring-characters';
import { parseMaterialData } from './authoring-materials';
import type { AuthoringProject } from './authoring-project';

export const CHARACTER_PREVIEW_SCHEMA = 'noveltea.character-preview' as const;

export interface CharacterProjectDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(
  path: string,
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error',
): CharacterProjectDiagnostic {
  return { severity, path, message, category: 'character-project' };
}

function assetMetadata(
  project: AuthoringProject,
  ref: CharacterAssetRef | null,
): Record<string, unknown> | null {
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

function materialMetadata(
  project: AuthoringProject,
  ref: CharacterMaterialRef | null,
): Record<string, unknown> | null {
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

function selectedProfile(data: CharacterData): CharacterPresentationProfileData | null {
  return (
    data.profiles.find((profile) => profile.id === data.defaults.profileId) ??
    data.profiles[0] ??
    null
  );
}

function selectedPose(profile: CharacterPresentationProfileData | null): CharacterPoseData | null {
  if (!profile) return null;
  return (
    profile.poses.find((pose) => pose.id === profile.defaultPoseId) ?? profile.poses[0] ?? null
  );
}

function selectedExpression(data: CharacterData): CharacterExpressionData | null {
  return (
    data.expressions.find((expression) => expression.id === data.defaults.expressionId) ??
    data.expressions[0] ??
    null
  );
}

function posePayload(pose: CharacterPoseData | null): Record<string, unknown> | null {
  if (!pose) return null;
  return {
    id: pose.id,
    label: pose.label,
    layers: pose.layers.map((layer) => ({ layerId: layer.layerId })),
  };
}

function expressionPayload(
  project: AuthoringProject,
  expression: CharacterExpressionData | null,
): Record<string, unknown> | null {
  if (!expression) return null;
  return {
    id: expression.id,
    label: expression.label,
    profiles: expression.profiles.map((entry) => ({ profileId: entry.profileId })),
  };
}

function profileOverrides<
  T extends { profiles: Array<{ profileId: string; layers: CharacterLayerOverrideData[] }> },
>(entry: T | null | undefined, profileId: string): CharacterLayerOverrideData[] | null {
  return entry?.profiles.find((candidate) => candidate.profileId === profileId)?.layers ?? null;
}

function applyOverrides(
  layer: CharacterLayerCompositionData,
  overrides: CharacterLayerOverrideData[] | null,
): CharacterLayerCompositionData {
  const patch = overrides?.find((candidate) => candidate.layerId === layer.layerId);
  if (!patch) return layer;
  return {
    ...layer,
    ...(patch.sprite !== undefined ? { sprite: patch.sprite } : {}),
    ...(patch.material !== undefined ? { material: patch.material } : {}),
    ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
  };
}

export function resolveCharacterPresentationLayers(
  data: CharacterData,
  profileId = data.defaults.profileId,
  poseId: string | null = null,
  expressionId = data.defaults.expressionId,
  appearanceId: string | null = data.defaults.appearanceId,
): Array<{
  id: string;
  role: string | null;
  sprite: CharacterAssetRef | null;
  material: CharacterMaterialRef | null;
  offset: { x: number; y: number };
  scale: number;
  anchor: { x: number; y: number };
  visible: boolean;
}> {
  const profile = data.profiles.find((candidate) => candidate.id === profileId) ?? data.profiles[0];
  if (!profile) return [];
  const pose =
    profile.poses.find((candidate) => candidate.id === (poseId ?? profile.defaultPoseId)) ??
    profile.poses[0];
  if (!pose) return [];

  const expression = data.expressions.find((candidate) => candidate.id === expressionId);
  const defaultExpression = data.expressions.find(
    (candidate) => candidate.id === data.defaults.expressionId,
  );
  const expressionOverrides =
    profileOverrides(expression, profile.id) ??
    (expression?.id !== defaultExpression?.id
      ? profileOverrides(defaultExpression, profile.id)
      : null);
  const appearance = appearanceId
    ? data.appearances.find((candidate) => candidate.id === appearanceId)
    : null;
  const appearanceOverrides = profileOverrides(appearance, profile.id);
  return profile.layers.flatMap((definition) => {
    const base = pose.layers.find((candidate) => candidate.layerId === definition.id);
    if (!base) return [];
    const withExpression = applyOverrides(base, expressionOverrides);
    const resolved = applyOverrides(withExpression, appearanceOverrides);
    return [
      {
        id: resolved.layerId,
        role: definition.role,
        sprite: resolved.sprite,
        material: resolved.material,
        offset: resolved.offset,
        scale: resolved.scale,
        anchor: resolved.anchor,
        visible: resolved.visible,
      },
    ];
  });
}

function dependencyRevision(project: AuthoringProject, data: CharacterData): string[] {
  const assetIds = new Set<string>();
  const materialIds = new Set<string>();
  for (const profile of data.profiles) {
    for (const pose of profile.poses) {
      for (const layer of pose.layers) {
        if (layer.sprite) assetIds.add(layer.sprite.$ref.id);
        if (layer.material) materialIds.add(layer.material.$ref.id);
      }
    }
    for (const clip of profile.animationClips) {
      for (const frame of clip.frames) {
        for (const layer of frame.layers) {
          if (layer.sprite) assetIds.add(layer.sprite.$ref.id);
          if (layer.material) materialIds.add(layer.material.$ref.id);
        }
      }
    }
  }
  for (const entry of [...data.expressions, ...data.appearances]) {
    for (const profile of entry.profiles) {
      for (const layer of profile.layers) {
        if (layer.sprite) assetIds.add(layer.sprite.$ref.id);
        if (layer.material) materialIds.add(layer.material.$ref.id);
      }
    }
  }
  for (const gesture of data.gestures)
    for (const profile of gesture.profiles)
      for (const cue of profile.cues) if (cue.kind === 'audio') assetIds.add(cue.asset.$ref.id);
  const assets = [...assetIds].sort().map((id) => {
    const asset = project.assets[id];
    const assetData = parseAssetData(asset?.data);
    return `${id}:${assetData?.contentHash ?? assetData?.source.path ?? 'missing'}`;
  });
  const materials = [...materialIds]
    .sort()
    .map((id) => `${id}:${JSON.stringify(project.materials[id]?.data ?? null)}`);
  return [...assets, ...materials];
}

export function characterPreviewRevision(project: AuthoringProject, characterId: string): string {
  const record = project.characters[characterId];
  const effectiveRecord = record
    ? resolveGameplayInstanceRecord(project, 'character', record)
    : null;
  const data = parseCharacterData(effectiveRecord?.data);
  if (!record || !effectiveRecord || !data) return `${characterId}:missing-or-invalid`;
  return JSON.stringify({
    characterId,
    label: record.label,
    data,
    dependencies: dependencyRevision(project, data),
  });
}

export function buildCharacterPreviewDocumentData(
  project: AuthoringProject,
  characterId: string,
): Record<string, unknown> {
  const record = project.characters[characterId];
  const effectiveRecord = record
    ? resolveGameplayInstanceRecord(project, 'character', record)
    : null;
  const data = parseCharacterData(effectiveRecord?.data);
  if (!record || !effectiveRecord || !data) {
    return {
      schema: CHARACTER_PREVIEW_SCHEMA,
      characterId,
      label: characterId,
      diagnostics: [diagnostic(`/characters/${characterId}/data`, 'Invalid character data.')],
    };
  }

  const profile = selectedProfile(data);
  const pose = selectedPose(profile);
  const expression = selectedExpression(data);
  const resolvedLayers = resolveCharacterPresentationLayers(data).map((layer) => ({
    id: layer.id,
    role: layer.role,
    sprite: assetMetadata(project, layer.sprite),
    material: materialMetadata(project, layer.material),
    offset: layer.offset,
    scale: layer.scale,
    anchor: layer.anchor,
    visible: layer.visible,
  }));

  return {
    schema: CHARACTER_PREVIEW_SCHEMA,
    characterId,
    label: record.label,
    displayName: data.displayName,
    dialogue: data.dialogue,
    selected: {
      profileId: profile?.id ?? data.defaults.profileId,
      poseId: pose?.id ?? profile?.defaultPoseId ?? '',
      expressionId: expression?.id ?? data.defaults.expressionId,
      appearanceId: data.defaults.appearanceId,
    },
    profile: profile
      ? {
          id: profile.id,
          label: profile.label,
          layers: profile.layers,
          animationClips: profile.animationClips,
          automaticAnimations: profile.automaticAnimations,
        }
      : null,
    gestures: data.gestures,
    pose: posePayload(pose),
    expression: expressionPayload(project, expression),
    resolvedLayers,
    diagnostics: validateCharacterData(project, characterId, effectiveRecord),
  };
}
