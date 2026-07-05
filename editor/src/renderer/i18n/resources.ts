import enCommon from './locales/en-US/common.json';
import enMenu from './locales/en-US/menu.json';
import enSettings from './locales/en-US/settings.json';
import enWorkspace from './locales/en-US/workspace.json';
import ptBrCommon from './locales/pt-BR/common.json';
import ptBrMenu from './locales/pt-BR/menu.json';
import ptBrSettings from './locales/pt-BR/settings.json';
import ptBrWorkspace from './locales/pt-BR/workspace.json';
import pseudoCommon from './locales/pseudo/common.json';
import pseudoMenu from './locales/pseudo/menu.json';
import pseudoSettings from './locales/pseudo/settings.json';
import pseudoWorkspace from './locales/pseudo/workspace.json';

export const editorI18nNamespaces = ['common', 'menu', 'settings', 'workspace'] as const;

export const editorI18nResources = {
  'en-US': {
    common: enCommon,
    menu: enMenu,
    settings: enSettings,
    workspace: enWorkspace,
  },
  'pt-BR': {
    common: ptBrCommon,
    menu: ptBrMenu,
    settings: ptBrSettings,
    workspace: ptBrWorkspace,
  },
  pseudo: {
    common: pseudoCommon,
    menu: pseudoMenu,
    settings: pseudoSettings,
    workspace: pseudoWorkspace,
  },
} as const;
