import { parseAssetData } from './authoring-assets';
import { parseInteractableData } from './authoring-interactables';
import { parseMaterialData } from './authoring-materials';
import type { AuthoringProject } from './authoring-project';
import { parseRoomData } from './authoring-rooms';
import { parseShaderData } from './authoring-shaders';
import { parseVerbData } from './authoring-verbs';
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

function validateVerb(
  project: AuthoringProject,
  category: HotspotAuthoringDiagnostic['category'],
  verbId: string | null,
  requiredArity: 0 | 1,
  path: string,
): HotspotAuthoringDiagnostic[] {
  if (!verbId)
    return [
      diagnostic(
        category,
        path,
        'Hotspot activation requires a Verb.',
        'hotspot.authoring.verb.required',
      ),
    ];
  const record = project.verbs[verbId];
  const verb = record ? parseVerbData(record.data) : null;
  if (!verb)
    return [
      diagnostic(
        category,
        path,
        `Missing or invalid Verb '${verbId}'.`,
        'hotspot.authoring.verb.missing',
      ),
    ];
  if (verb.arity !== requiredArity)
    return [
      diagnostic(
        category,
        path,
        `Hotspot Verb '${verbId}' must have arity ${requiredArity}.`,
        'hotspot.authoring.verb.arity',
      ),
    ];
  return [];
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
        'Clickable hotspots require an image source.',
        'hotspot.authoring.source-image-required',
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
      if (hotspot.activation.kind === 'verb')
        diagnostics.push(
          ...validateVerb(
            project,
            'Rooms',
            hotspot.activation.verb?.$ref.id ?? null,
            0,
            `${path}/activation/verb`,
          ),
        );
      else if (!exits.has(hotspot.activation.exitId))
        diagnostics.push(
          diagnostic(
            'Rooms',
            `${path}/activation/exitId`,
            `Room hotspot exit '${hotspot.activation.exitId}' does not belong to Room '${roomId}'.`,
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
    const definition = interactable.presentation.hotspots;
    const hotspots =
      definition.kind === 'sprite-alpha' ? [definition.hotspot] : definition.hotspots;
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
      diagnostics.push(
        ...validateVerb(
          project,
          'Interactables',
          hotspot.activation.verb?.$ref.id ?? null,
          1,
          `${path}/activation/verb`,
        ),
      );
      diagnostics.push(
        ...validateHighlight(
          project,
          'Interactables',
          hotspot.highlight,
          definition.kind,
          `${path}/highlight`,
        ),
      );
    });
    const requiresSprite = definition.kind === 'sprite-alpha' || definition.hotspots.length > 0;
    if (requiresSprite)
      diagnostics.push(
        ...validateSourceImage(
          project,
          'Interactables',
          interactable.presentation.sprite?.$ref.id ?? null,
          `${base}/sprite`,
          definition.kind === 'sprite-alpha',
        ),
      );
  }
  return diagnostics;
}
