import { visualForCollection } from '../../../workspace/collection-visuals';
import type { NewEntityWizardTypeDefinition } from './common';

function visual(collection: NewEntityWizardTypeDefinition['collection']) {
  const base = visualForCollection(collection);
  return { icon: base.icon, iconClassName: base.colorClassName };
}

export const metadataWizardDefinitions: NewEntityWizardTypeDefinition[] = [
  {
    collection: 'assets', category: 'assets', supportLevel: 'external-flow',
    summary: 'Project files such as images, audio, fonts, Lua, shader source, text, and binary data.',
    currentScope: 'Use Import Assets or Generate Image for real asset records.',
    ...visual('assets'),
    buildPayload: () => ({ data: { kind: 'binary', source: { type: 'project-file', path: 'assets/binary/file.bin' }, aliases: [] } }),
  },
  {
    collection: 'interactables', category: 'world', supportLevel: 'metadata-only',
    summary: 'Interactable world and inventory definitions.',
    currentScope: 'Creates the strict Phase 3A shell; behavior fields arrive in a later Phase 3 slice.',
    ...visual('interactables'), buildPayload: () => ({ data: { kind: 'interactable' } }),
  },
  {
    collection: 'verbs', category: 'logic', supportLevel: 'metadata-only',
    summary: 'Player verbs for interaction authoring.',
    currentScope: 'Creates the strict Phase 3A shell; behavior fields arrive in a later Phase 3 slice.',
    ...visual('verbs'), buildPayload: () => ({ data: { kind: 'verb' } }),
  },
  {
    collection: 'interactions', category: 'logic', supportLevel: 'metadata-only',
    summary: 'Bindings between verbs, interactables, scripts, and runtime outcomes.',
    currentScope: 'Creates the strict Phase 3A shell; rules arrive in a later Phase 3 slice.',
    ...visual('interactions'), buildPayload: () => ({ data: { kind: 'interaction' } }),
  },
  {
    collection: 'maps', category: 'world', supportLevel: 'metadata-only',
    summary: 'World-map presentation records.',
    currentScope: 'Creates the strict Phase 3A shell; map content arrives in a later Phase 3 slice.',
    ...visual('maps'), buildPayload: () => ({ data: { kind: 'map' } }),
  },
  {
    collection: 'scripts', category: 'logic', supportLevel: 'metadata-only',
    summary: 'Explicit Lua script modules.',
    currentScope: 'Creates a strict inline Lua module shell.',
    ...visual('scripts'), buildPayload: () => ({ data: { kind: 'script-module', source: '' } }),
  },
];
