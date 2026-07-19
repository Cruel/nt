import { visualForCollection } from '../../../workspace/collection-visuals';
import { defaultInteractionData } from '../../../../shared/project-schema/authoring-interactions';
import { defaultMapData } from '../../../../shared/project-schema/authoring-maps';
import { defaultScriptModuleData } from '../../../../shared/project-schema/authoring-script-modules';
import { defaultVerbData } from '../../../../shared/project-schema/authoring-verbs';
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
    summary:
      'Project files such as images, audio, fonts, Lua, shader source, text, and binary data.',
    currentScope: 'Use Import Assets or Generate Image for real asset records.',
    ...visual('assets'),
    buildPayload: () => ({
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: 'assets/binary/file.bin' },
        aliases: [],
      },
    }),
  },
  {
    collection: 'verbs',
    category: 'logic',
    supportLevel: 'typed',
    summary: 'Player verbs for interaction.',
    currentScope:
      'Creates a typed zero-operand verb with an editable availability rule and default program.',
    ...visual('verbs'),
    buildPayload: ({ draft }) => ({ data: defaultVerbData(draft.basics.label) }),
  },
  {
    collection: 'interactions',
    category: 'logic',
    supportLevel: 'typed',
    summary: 'Bindings between verbs, interactables, scripts, and runtime outcomes.',
    currentScope: 'Creates a typed interaction with an initially empty ordered rule list.',
    ...visual('interactions'),
    buildPayload: () => ({ data: defaultInteractionData() }),
  },
  {
    collection: 'maps',
    category: 'world',
    supportLevel: 'typed',
    summary: 'World-map presentation records.',
    currentScope:
      'Creates a typed map presentation with editable exit-backed locations and connections.',
    ...visual('maps'),
    buildPayload: () => ({ data: defaultMapData() }),
  },
  {
    collection: 'scripts',
    category: 'logic',
    supportLevel: 'typed',
    summary: 'Explicit Lua script modules.',
    currentScope: 'Creates a typed inline Lua module; source can be switched to a script asset.',
    ...visual('scripts'),
    buildPayload: () => ({ data: defaultScriptModuleData() }),
  },
];
