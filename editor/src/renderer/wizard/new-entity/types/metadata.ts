import { visualForCollection } from '../../../workspace/collection-visuals';
import type { NewEntityWizardTypeDefinition } from './common';

function visual(collection: NewEntityWizardTypeDefinition['collection']) {
  const base = visualForCollection(collection);
  return { icon: base.icon, iconClassName: base.colorClassName };
}

export const metadataWizardDefinitions: NewEntityWizardTypeDefinition[] = [
  {
    collection: 'assets',
    category: 'assets',
    supportLevel: 'external-flow',
    summary: 'Project files such as images, audio, fonts, Lua, shader source, text, and binary data.',
    currentScope: 'Use Import Assets or Generate Image for real asset records. This wizard only explains the current asset flow.',
    ...visual('assets'),
    buildPayload: () => ({ data: {} }),
  },
  {
    collection: 'objects',
    category: 'world',
    supportLevel: 'metadata-only',
    summary: 'Interactable world/inventory objects referenced by rooms, tests, and future action logic.',
    currentScope: 'Creates metadata now; object behavior schema and typed editor are pending.',
    ...visual('objects'),
    buildPayload: () => ({ data: {} }),
  },
  {
    collection: 'verbs',
    category: 'logic',
    supportLevel: 'metadata-only',
    summary: 'Player/action verbs for future interaction authoring.',
    currentScope: 'Creates metadata now; verb schema and typed editor are pending.',
    ...visual('verbs'),
    buildPayload: () => ({ data: {} }),
  },
  {
    collection: 'actions',
    category: 'logic',
    supportLevel: 'metadata-only',
    summary: 'Future bindings between verbs, objects, scripts, and runtime outcomes.',
    currentScope: 'Creates metadata now; action schema and typed editor are pending.',
    ...visual('actions'),
    buildPayload: () => ({ data: {} }),
  },
  {
    collection: 'maps',
    category: 'world',
    supportLevel: 'metadata-only',
    summary: 'Future world-map/navigation records.',
    currentScope: 'Creates metadata now; map schema and typed editor are pending.',
    ...visual('maps'),
    buildPayload: () => ({ data: {} }),
  },
  {
    collection: 'scripts',
    category: 'logic',
    supportLevel: 'metadata-only',
    summary: 'Lua scripting records for future first-class script authoring.',
    currentScope: 'Creates a minimal Lua-shaped metadata record now; runtime script asset workflow still uses imported .lua assets.',
    ...visual('scripts'),
    buildPayload: () => ({ data: { language: 'lua', source: '' } }),
  },
];
