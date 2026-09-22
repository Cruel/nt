import { parseAssetData } from './authoring-assets';
import { parseInteractableData, type InteractableData } from './authoring-interactables';
import { resolveMaterialData } from './authoring-materials';
import { materialContractRegistry } from './material-contract-registry.generated';
import type { AuthoringProject } from './authoring-project';
import { parseRoomData } from './authoring-rooms';
import type { InteractionSubjectData } from './authoring-features';
import type { HotspotHighlight } from './authoring-hotspots';

export interface HotspotAuthoringDiagnostic {
  severity: 'error' | 'warning';
  path: string;
  message: string;
  category: 'Rooms' | 'Interactables';
  code: string;
}

function diagnostic(
  category: HotspotAuthoringDiagnostic['category'],
  path: string,
  message: string,
  code: string,
  severity: HotspotAuthoringDiagnostic['severity'] = 'error',
): HotspotAuthoringDiagnostic {
  return { category, path, message, code, severity };
}

function validateSubject(
  project: AuthoringProject,
  category: HotspotAuthoringDiagnostic['category'],
  subject: InteractionSubjectData,
  path: string,
): HotspotAuthoringDiagnostic[] {
  if (subject.kind === 'character')
    return project.characters[subject.character.$ref.id]
      ? []
      : [
          diagnostic(
            category,
            `${path}/character/$ref`,
            `Missing Character '${subject.character.$ref.id}'.`,
            'hotspot.authoring.target.character-missing',
          ),
        ];
  if (subject.kind === 'interactable')
    return project.interactableInstances[subject.interactable.$ref.id]
      ? []
      : [
          diagnostic(
            category,
            `${path}/interactable/$ref`,
            `Missing Interactable Instance '${subject.interactable.$ref.id}'.`,
            'hotspot.authoring.target.interactable-missing',
          ),
        ];
  const feature = subject.feature;
  if (feature.ownerKind === 'room') {
    const room = parseRoomData(project.rooms[feature.room.$ref.id]?.data);
    if (!room)
      return [
        diagnostic(
          category,
          `${path}/feature/room/$ref`,
          `Missing Room '${feature.room.$ref.id}' for Feature target.`,
          'hotspot.authoring.target.feature-owner-missing',
        ),
      ];
    return room.features.some((candidate) => candidate.id === feature.featureId)
      ? []
      : [
          diagnostic(
            category,
            `${path}/feature/featureId`,
            `Missing Feature '${feature.featureId}' on Room '${feature.room.$ref.id}'.`,
            'hotspot.authoring.target.feature-missing',
          ),
        ];
  }
  const instance = project.interactableInstances[feature.interactable.$ref.id];
  const interactable = instance
    ? parseInteractableData(project.interactables[instance.definition.$ref.id]?.data)
    : null;
  if (!interactable)
    return [
      diagnostic(
        category,
        `${path}/feature/interactable/$ref`,
        `Missing Interactable Instance '${feature.interactable.$ref.id}' for Feature target.`,
        'hotspot.authoring.target.feature-owner-missing',
      ),
    ];
  return interactable.features.some((candidate) => candidate.id === feature.featureId)
    ? []
    : [
        diagnostic(
          category,
          `${path}/feature/featureId`,
          `Missing Feature '${feature.featureId}' on Interactable Instance '${feature.interactable.$ref.id}'.`,
          'hotspot.authoring.target.feature-missing',
        ),
      ];
}

function validateHighlight(
  project: AuthoringProject,
  category: HotspotAuthoringDiagnostic['category'],
  highlight: HotspotHighlight,
  mode: 'sprite-alpha' | 'custom',
  path: string,
): HotspotAuthoringDiagnostic[] {
  if (highlight.kind !== 'material') return [];
  const materialId = highlight.material.$ref.id;
  const material = resolveMaterialData(project, materialId).data;
  if (!material)
    return [
      diagnostic(
        category,
        `${path}/material/$ref`,
        `Missing or invalid hotspot highlight Material '${materialId}'.`,
        'hotspot.authoring.highlight.material-missing',
      ),
    ];
  if (material.role !== 'hotspot-overlay')
    return [
      diagnostic(
        category,
        `${path}/material/$ref`,
        `Hotspot highlight Material '${materialId}' must use role 'hotspot-overlay'.`,
        'hotspot.authoring.highlight.material-role',
      ),
    ];
  const preset = materialContractRegistry.presets.find(
    (candidate) => candidate.id === material.preset.id,
  );
  const imageState = preset?.capabilities.samplers.s_hotspotImage;
  const maskState = preset?.capabilities.samplers.s_hotspotMask;
  const samplerCompatible =
    imageState === 'required' &&
    (mode === 'sprite-alpha' ? maskState === 'disabled' : maskState === 'required');
  return samplerCompatible
    ? []
    : [
        diagnostic(
          category,
          `${path}/material/$ref`,
          mode === 'sprite-alpha'
            ? 'Default-alpha hotspot highlights require the alpha hotspot Material contract.'
            : 'Custom hotspot highlights require the custom-mask hotspot Material contract.',
          'hotspot.authoring.highlight.sampler-interface',
        ),
      ];
}

function validateSourceImage(
  project: AuthoringProject,
  category: HotspotAuthoringDiagnostic['category'],
  assetId: string | null,
  path: string,
  alphaMode: boolean,
): HotspotAuthoringDiagnostic[] {
  if (!assetId)
    return [
      diagnostic(
        category,
        path,
        category === 'Interactables'
          ? alphaMode
            ? 'Alpha hotspot mode requires a sprite image. Add a sprite or switch hotspot mode.'
            : 'Custom hotspots require a sprite image. Add a sprite or remove the custom hotspots.'
          : 'Clickable hotspots require an image source.',
        'hotspot.authoring.source-image-required',
        'error',
      ),
    ];
  const record = project.assets[assetId];
  const asset = record ? parseAssetData(record.data) : null;
  if (!asset || asset.kind !== 'image')
    return [
      diagnostic(
        category,
        path,
        `Hotspot source '${assetId}' must be a valid image Asset.`,
        'hotspot.authoring.source-image-invalid',
      ),
    ];
  if (!asset.imageMetadata)
    return [
      diagnostic(
        category,
        path,
        'Hotspot source image requires valid image metadata.',
        'hotspot.authoring.image-metadata-required',
      ),
    ];
  const diagnostics: HotspotAuthoringDiagnostic[] = [];
  if (asset.imageMetadata.orientation !== 1)
    diagnostics.push(
      diagnostic(
        category,
        path,
        'Hotspot source image must use identity EXIF orientation; normalize and reimport it.',
        'hotspot.authoring.image-orientation',
      ),
    );
  if (alphaMode && !asset.imageMetadata.hasAlpha)
    diagnostics.push(
      diagnostic(
        category,
        path,
        'Sprite has no alpha channel; the default hotspot covers the full image rectangle.',
        'hotspot.authoring.alpha.opaque-image',
        'warning',
      ),
    );
  return diagnostics;
}

export function validateInteractableHotspotAuthoringSemantics(
  project: AuthoringProject,
  interactable: Pick<InteractableData, 'features' | 'presentation'>,
  base: string,
  ownerLabel: string,
): HotspotAuthoringDiagnostic[] {
  const diagnostics: HotspotAuthoringDiagnostic[] = [];
  const definition = interactable.presentation.hotspots;
  const hotspots =
    definition.kind === 'none'
      ? []
      : definition.kind === 'sprite-alpha'
        ? [definition.hotspot]
        : definition.hotspots;
  const seen = new Set<string>();
  hotspots.forEach((hotspot, index) => {
    const path =
      definition.kind === 'sprite-alpha'
        ? `${base}/hotspots/hotspot`
        : `${base}/hotspots/hotspots/${index}`;
    if (seen.has(hotspot.id))
      diagnostics.push(
        diagnostic(
          'Interactables',
          `${path}/id`,
          `Duplicate hotspot ID '${hotspot.id}'.`,
          'hotspot.authoring.id.duplicate',
        ),
      );
    seen.add(hotspot.id);
    if (hotspot.target.kind === 'owner-feature') {
      const featureId = hotspot.target.featureId;
      if (!interactable.features.some((feature) => feature.id === featureId))
        diagnostics.push(
          diagnostic(
            'Interactables',
            `${path}/target/featureId`,
            `Interactable Feature '${featureId}' does not belong to ${ownerLabel}.`,
            'hotspot.authoring.target.feature-missing',
          ),
        );
    } else if (hotspot.target.kind === 'subject') {
      diagnostics.push(
        ...validateSubject(
          project,
          'Interactables',
          hotspot.target.subject,
          `${path}/target/subject`,
        ),
      );
    }
    diagnostics.push(
      ...validateHighlight(
        project,
        'Interactables',
        hotspot.highlight,
        definition.kind === 'sprite-alpha' ? 'sprite-alpha' : 'custom',
        `${path}/highlight`,
      ),
    );
  });
  const requiresSprite =
    definition.kind === 'sprite-alpha' ||
    (definition.kind === 'custom' && definition.hotspots.length > 0);
  if (requiresSprite)
    diagnostics.push(
      ...validateSourceImage(
        project,
        'Interactables',
        interactable.presentation.sprite?.$ref.id ?? null,
        interactable.presentation.sprite ? `${base}/sprite` : `${base}/hotspots/kind`,
        definition.kind === 'sprite-alpha',
      ),
    );
  return diagnostics;
}

export function validateRoomHotspotAuthoringSemantics(
  project: AuthoringProject,
  roomId: string,
): HotspotAuthoringDiagnostic[] {
  const record = project.rooms[roomId];
  const room = record ? parseRoomData(record.data) : null;
  if (!room) return [];
  const diagnostics: HotspotAuthoringDiagnostic[] = [];
  const base = `/rooms/${roomId}/data`;
  if (room.hotspots.length > 0)
    diagnostics.push(
      ...validateSourceImage(
        project,
        'Rooms',
        room.background.asset?.$ref.id ?? null,
        `${base}/background/asset`,
        false,
      ),
    );
  const exits = new Set(room.exits.map((exit) => exit.id));
  room.hotspots.forEach((hotspot, index) => {
    const path = `${base}/hotspots/${index}`;
    if (hotspot.target.kind === 'owner-feature') {
      const featureId = hotspot.target.featureId;
      if (!room.features.some((feature) => feature.id === featureId))
        diagnostics.push(
          diagnostic(
            'Rooms',
            `${path}/target/featureId`,
            `Room Feature '${featureId}' does not belong to Room '${roomId}'.`,
            'hotspot.authoring.target.feature-missing',
          ),
        );
    } else if (hotspot.target.kind === 'subject') {
      diagnostics.push(
        ...validateSubject(project, 'Rooms', hotspot.target.subject, `${path}/target/subject`),
      );
    } else if (!exits.has(hotspot.target.exitId))
      diagnostics.push(
        diagnostic(
          'Rooms',
          `${path}/target/exitId`,
          `Room hotspot exit '${hotspot.target.exitId}' does not belong to Room '${roomId}'.`,
          'hotspot.authoring.exit.foreign',
        ),
      );
    diagnostics.push(
      ...validateHighlight(project, 'Rooms', hotspot.highlight, 'custom', `${path}/highlight`),
    );
  });
  return diagnostics;
}

export function validateInteractableRecordHotspotAuthoringSemantics(
  project: AuthoringProject,
  interactableId: string,
): HotspotAuthoringDiagnostic[] {
  const record = project.interactables[interactableId];
  const interactable = record ? parseInteractableData(record.data) : null;
  if (!interactable) return [];
  return validateInteractableHotspotAuthoringSemantics(
    project,
    interactable,
    `/interactables/${interactableId}/data/presentation`,
    `Interactable '${interactableId}'`,
  );
}

export function validateHotspotAuthoringSemantics(
  project: AuthoringProject,
): HotspotAuthoringDiagnostic[] {
  const diagnostics: HotspotAuthoringDiagnostic[] = [];
  for (const roomId of Object.keys(project.rooms))
    diagnostics.push(...validateRoomHotspotAuthoringSemantics(project, roomId));
  for (const interactableId of Object.keys(project.interactables))
    diagnostics.push(
      ...validateInteractableRecordHotspotAuthoringSemantics(project, interactableId),
    );
  return diagnostics;
}
