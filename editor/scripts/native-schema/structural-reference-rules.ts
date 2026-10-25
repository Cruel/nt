import type {
  AuthoringDependencyRole,
  DependencyImpactFacet,
} from '../../src/shared/authoring-dependency-contracts';

const semanticEdgeRules: readonly [
  RegExp,
  AuthoringDependencyRole,
  readonly DependencyImpactFacet[],
][] = [
  [
    /\/data\/background\/asset\/\$ref$/,
    'room-background',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/data\/background\/material\/\$ref$/,
    'room-background-material',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/data\/cast\/\d+\/character\/\$ref$/,
    'room-cast-character',
    ['reference-integrity', 'tooling-reference', 'preview-visual'],
  ],
  [
    /\/data\/overlays\/\d+\/layout\/\$ref$/,
    'room-overlay-layout',
    ['reference-integrity', 'tooling-reference', 'preview-ui'],
  ],
  [
    /\/data\/placements\/\d+\/presentation\/layout\/\$ref$/,
    'room-placement-layout',
    ['reference-integrity', 'tooling-reference', 'preview-ui'],
  ],
  [
    /\/data\/props\/\d+\/asset\/\$ref$/,
    'room-prop-asset',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/data\/props\/\d+\/material\/\$ref$/,
    'room-prop-material',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/data\/environments\/\d+\/asset\/\$ref$/,
    'room-environment-asset',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/data\/environments\/\d+\/material\/\$ref$/,
    'room-environment-material',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/data\/compose\/script\/\$ref$/,
    'room-compose-script',
    ['reference-integrity', 'tooling-reference', 'runtime-only'],
  ],
  [
    /\/data\/scriptHooks\/\d+\/handler\/module\/\$ref$/,
    'room-script-hook',
    ['reference-integrity', 'tooling-reference', 'validation', 'runtime-only'],
  ],
  [
    /\/data\/exits\/\d+\/target\/\$ref$/,
    'room-exit-target',
    ['reference-integrity', 'tooling-reference', 'runtime-only'],
  ],
  [
    /\/data\/(?:hotspots\/\d+|presentation\/hotspots\/(?:hotspot|hotspots\/\d+))\/highlight\/material\/\$ref$/,
    'hotspot-material',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/data\/profiles\/[^/]+\/poses\/[^/]+\/layers\/[^/]+\/visual\/(?:image|animation)\/\$ref$/,
    'character-pose-visual',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/data\/poses\/[^/]+\/material\/\$ref$/,
    'character-pose-material',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/data\/expressions\/[^/]+\/profiles\/[^/]+\/layers\/[^/]+\/visual\/(?:image|animation)\/\$ref$/,
    'character-expression-visual',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/data\/expressions\/[^/]+\/material\/\$ref$/,
    'character-expression-material',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/data\/presentation\/visual\/(?:image|animation)\/\$ref$/,
    'interactable-visual',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/data\/presentation\/material\/\$ref$/,
    'interactable-material',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/data\/textures\/[^/]+\/source\/\$ref$/,
    'material-texture',
    ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
  ],
  [
    /\/layouts\/[^/]+\/data\/rml\/sourceAsset\/\$ref$/,
    'layout-rml-source',
    ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
  ],
  [
    /\/layouts\/[^/]+\/data\/rcss\/sourceAsset\/\$ref$/,
    'layout-rcss-source',
    ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
  ],
  [
    /\/layouts\/[^/]+\/data\/dependencies\/images\/\d+\/\$ref$/,
    'layout-image',
    ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
  ],
  [
    /\/layouts\/[^/]+\/data\/dependencies\/fonts\/\d+\/\$ref$/,
    'layout-font',
    ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
  ],
  [
    /\/layouts\/[^/]+\/data\/dependencies\/stylesheets\/\d+\/\$ref$/,
    'layout-stylesheet',
    ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
  ],
  [
    /\/layouts\/[^/]+\/data\/dependencies\/templates\/\d+\/\$ref$/,
    'layout-template',
    ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
  ],
  [
    /\/layouts\/[^/]+\/data\/dependencies\/materials\/\d+\/\$ref$/,
    'layout-material',
    ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
  ],
  [
    /^\/settings\/ui\/systemLayouts\//,
    'system-layout',
    ['reference-integrity', 'tooling-reference', 'preview-ui'],
  ],
  [
    /^\/settings\/inventory\/defaultLayout\/\$ref$/,
    'system-layout',
    ['reference-integrity', 'tooling-reference', 'preview-ui'],
  ],
  [
    /^\/settings\/text\/defaultFont\/\$ref$/,
    'default-font',
    ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
  ],
  [
    /^(?:\/settings\/text\/fontStack\/\d+|\/localization\/locales\/[^/]+\/fontStack\/\d+)\/\$ref$/,
    'font-stack',
    ['reference-integrity', 'tooling-reference', 'preview-ui', 'resource'],
  ],
];

export const nativeStructuralReferenceRules = Object.freeze(
  semanticEdgeRules.map(([pattern, role]) => Object.freeze({ pattern: pattern.source, role })),
);
