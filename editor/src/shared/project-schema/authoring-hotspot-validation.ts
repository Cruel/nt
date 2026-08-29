import { parseAssetData } from './authoring-assets';
import { parseInteractableData, type InteractableData } from './authoring-interactables';
import { parseMaterialData } from './authoring-materials';
import type { AuthoringProject } from './authoring-project';
import { parseRoomData } from './authoring-rooms';
import { parseShaderData } from './authoring-shaders';
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
  const materialRecord = project.materials[materialId];
  const material = materialRecord ? parseMaterialData(materialRecord.data) : null;
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
  const shaderId = material.shader?.$ref.id;
  const shaderRecord = shaderId ? project.shaders[shaderId] : undefined;
  const shader = shaderRecord ? parseShaderData(shaderRecord.data) : null;
  if (!shader || !shader.roles.includes('hotspot-overlay'))
    return [
      diagnostic(
        category,
        `${path}/material/$ref`,
        `Hotspot highlight Material '${materialId}' must reference a valid hotspot-overlay Shader.`,
        'hotspot.authoring.highlight.shader-role',
      ),
    ];

  const diagnostics: HotspotAuthoringDiagnostic[] = [];
  const requiredUniforms = new Map([
    ['engine.hotspot_bounds', 'vec4'],
    ['engine.hotspot_hovered', 'bool'],
    ['engine.hotspot_pressed', 'bool'],
    ['engine.hotspot_image_dimensions', 'vec2'],
    ['engine.hotspot_mask_dimensions', 'vec2'],
  ] as const);
  for (const [binding, type] of requiredUniforms) {
    const matches = shader.uniforms.filter((uniform) => uniform.binding === binding);
    if (matches.length !== 1 || matches[0]?.type !== type)
      diagnostics.push(
        diagnostic(
          category,
          `${path}/material/$ref`,
          `Hotspot Shader must declare exactly one '${binding}' uniform with type '${type}'.`,
          'hotspot.authoring.highlight.uniform-interface',
        ),
      );
  }
  const imageBindings = shader.samplers.filter(
    (sampler) => sampler.binding === 'engine.hotspot_image',
  );
  const maskBindings = shader.samplers.filter(
    (sampler) => sampler.binding === 'engine.hotspot_mask',
  );
  const samplerCompatible =
    imageBindings.length === 1 &&
    (mode === 'sprite-alpha' ? maskBindings.length === 0 : maskBindings.length === 1);
  if (!samplerCompatible)
    diagnostics.push(
      diagnostic(
        category,
        `${path}/material/$ref`,
        mode === 'sprite-alpha'
          ? "Default-alpha hotspot Shader must declare exactly one 'engine.hotspot_image' sampler and no 'engine.hotspot_mask' sampler."
          : "Custom hotspot Shader must declare exactly one 'engine.hotspot_image' and one 'engine.hotspot_mask' sampler.",
        'hotspot.authoring.highlight.sampler-interface',
      ),
    );
  return diagnostics;
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

export function validateHotspotAuthoringSemantics(
  project: AuthoringProject,
): HotspotAuthoringDiagnostic[] {
  const diagnostics: HotspotAuthoringDiagnostic[] = [];
  for (const [roomId, record] of Object.entries(project.rooms)) {
    const room = parseRoomData(record.data);
    if (!room) continue;
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
  }

  for (const [interactableId, record] of Object.entries(project.interactables)) {
    const interactable = parseInteractableData(record.data);
    if (!interactable) continue;
    const base = `/interactables/${interactableId}/data/presentation`;
    diagnostics.push(
      ...validateInteractableHotspotAuthoringSemantics(
        project,
        interactable,
        base,
        `Interactable '${interactableId}'`,
      ),
    );
  }
  return diagnostics;
}
