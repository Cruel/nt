export const AUTHORING_PROJECT_SCHEMA = 'noveltea.authoring.project' as const;
export const AUTHORING_PROJECT_SCHEMA_VERSION = 2 as const;

export const authoringCollectionKeys = [
  'assets',
  'variables',
  'shaders',
  'materials',
  'layouts',
  'characters',
  'rooms',
  'interactables',
  'verbs',
  'interactions',
  'dialogues',
  'scenes',
  'maps',
  'scripts',
  'tests',
] as const;

export type AuthoringCollectionKey = (typeof authoringCollectionKeys)[number];

export interface AuthoringCollectionMetadata {
  key: AuthoringCollectionKey;
  label: string;
  singularLabel: string;
  nodeType:
    | 'asset'
    | 'variable'
    | 'shader'
    | 'material'
    | 'layout'
    | 'character'
    | 'room'
    | 'interactable'
    | 'verb'
    | 'interaction'
    | 'dialogue'
    | 'scene'
    | 'map'
    | 'script'
    | 'test';
}

export const authoringCollectionMetadata: Record<
  AuthoringCollectionKey,
  AuthoringCollectionMetadata
> = {
  assets: { key: 'assets', label: 'Assets', singularLabel: 'Asset', nodeType: 'asset' },
  variables: {
    key: 'variables',
    label: 'Variables',
    singularLabel: 'Variable',
    nodeType: 'variable',
  },
  shaders: { key: 'shaders', label: 'Shaders', singularLabel: 'Shader', nodeType: 'shader' },
  materials: {
    key: 'materials',
    label: 'Materials',
    singularLabel: 'Material',
    nodeType: 'material',
  },
  layouts: { key: 'layouts', label: 'Layouts', singularLabel: 'Layout', nodeType: 'layout' },
  characters: {
    key: 'characters',
    label: 'Characters',
    singularLabel: 'Character',
    nodeType: 'character',
  },
  rooms: { key: 'rooms', label: 'Rooms', singularLabel: 'Room', nodeType: 'room' },
  interactables: {
    key: 'interactables',
    label: 'Interactables',
    singularLabel: 'Interactable',
    nodeType: 'interactable',
  },
  verbs: { key: 'verbs', label: 'Verbs', singularLabel: 'Verb', nodeType: 'verb' },
  interactions: {
    key: 'interactions',
    label: 'Interactions',
    singularLabel: 'Interaction',
    nodeType: 'interaction',
  },
  dialogues: {
    key: 'dialogues',
    label: 'Dialogues',
    singularLabel: 'Dialogue',
    nodeType: 'dialogue',
  },
  scenes: { key: 'scenes', label: 'Scenes', singularLabel: 'Scene', nodeType: 'scene' },
  maps: { key: 'maps', label: 'Maps', singularLabel: 'Map', nodeType: 'map' },
  scripts: { key: 'scripts', label: 'Scripts', singularLabel: 'Script', nodeType: 'script' },
  tests: { key: 'tests', label: 'Tests', singularLabel: 'Test', nodeType: 'test' },
};

export function isAuthoringCollectionKey(value: unknown): value is AuthoringCollectionKey {
  return (
    typeof value === 'string' && authoringCollectionKeys.includes(value as AuthoringCollectionKey)
  );
}
