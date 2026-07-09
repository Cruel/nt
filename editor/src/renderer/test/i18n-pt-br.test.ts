import { describe, expect, it } from 'vitest';
import { createTestI18n } from '@/i18n/test-utils';
import { resolveEditorLanguage } from '@/i18n';
import { buildCommandPaletteItems, searchCommandPaletteItems } from '@/workspace/command-palette-search';

describe('pt-BR editor localization', () => {
  it('resolves Brazilian Portuguese system preferences', () => {
    expect(resolveEditorLanguage('system', ['pt-BR'])).toBe('pt-BR');
  });

  it('loads Brazilian Portuguese resource strings', async () => {
    const i18n = await createTestI18n('pt-BR');
    expect(i18n.t('settings:page.title')).toBe('Configurações');
    expect(i18n.t('menu:menus.file')).toBe('Arquivo');
  });

  it('uses localized command palette metadata while keeping English aliases searchable', async () => {
    const i18n = await createTestI18n('pt-BR');
    const items = buildCommandPaletteItems(null, i18n.t.bind(i18n));
    expect(items.map((item) => item.id)).toEqual(['action:settings', 'action:new-project', 'action:open-project', 'action:comfyui-workflows']);
    expect(items.find((item) => item.id === 'action:settings')?.title).toBe('Configurações');
    expect(searchCommandPaletteItems(items, 'settings')[0]?.item.id).toBe('action:settings');
    expect(searchCommandPaletteItems(items, 'workflow manager')[0]?.item.id).toBe('action:comfyui-workflows');
  });
});
