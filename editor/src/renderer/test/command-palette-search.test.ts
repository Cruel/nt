import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { buildCommandPaletteItems, filterSelectorItems, searchCommandPaletteItems } from '@/workspace/command-palette-search';

function project() {
  const next = createAuthoringProject();
  next.assets.logo = { id: 'logo', label: 'Sarah Portrait', tags: ['Sarah'], data: { kind: 'image', source: { type: 'project-file', path: 'assets/sarah.png' }, aliases: [], extension: '.png' } };
  next.assets.theme = { id: 'theme', label: 'Theme', tags: [], data: { kind: 'audio', source: { type: 'project-file', path: 'assets/theme.ogg' }, aliases: [], extension: '.ogg' } };
  next.layouts.coolLayout = { id: 'coolLayout', label: 'Layout lol', tags: ['cool'], data: { target: 'cool-layout' } };
  next.layouts.sadf = { id: 'sadf', label: 'Layout sadf', tags: ['cool'], data: { target: 'sadf-layout' } };
  next.rooms.classroom = { id: 'classroom', label: 'Classroom', tags: ['school'], data: {} };
  next.scenes.opening = { id: 'opening', label: 'Opening Scene', tags: [], data: {} };
  next.dialogues.intro = { id: 'intro', label: 'Intro Dialogue', tags: [], data: {} };
  next.scripts.boot = { id: 'boot', label: 'Boot Script', tags: [], data: { language: 'lua', source: '' } };
  return next;
}

describe('command palette search', () => {
  it('builds action and project record items', () => {
    const items = buildCommandPaletteItems(project());
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining(['action:project-settings', 'record:assets:logo', 'record:rooms:classroom']));
  });

  it('uses fuzzy search for quick-open style project records', () => {
    const results = searchCommandPaletteItems(buildCommandPaletteItems(project()), 'srh port');
    expect(results[0]?.item.id).toBe('record:assets:logo');
    expect(results[0]?.matches.length).toBeGreaterThan(0);
  });



  it('returns top tag match provenance for matched tags', () => {
    const results = searchCommandPaletteItems(buildCommandPaletteItems(project()), 'cool');
    expect(results[0]?.item.id).toBe('record:layouts:coolLayout');
    expect(results[0]?.matches).toEqual(expect.arrayContaining([expect.objectContaining({ fieldKind: 'tag', fieldLabel: 'Tag', value: 'cool' })]));
  });

  it('searches common actions without project data', () => {
    const results = searchCommandPaletteItems(buildCommandPaletteItems(null), 'settings');
    expect(results[0]?.item.id).toBe('action:project-settings');
  });

  it('filters selector items by image asset kind', () => {
    const items = filterSelectorItems(buildCommandPaletteItems(project()), { collections: ['assets'], assetKinds: ['image'], includeActions: false });
    expect(items.map((item) => item.id)).toEqual(['record:assets:logo']);
    expect(items[0]?.preview).toEqual({ kind: 'image', label: 'Sarah Portrait', sourcePath: 'assets/sarah.png' });
  });

  it('filters selector items by entrypoint collections', () => {
    const items = filterSelectorItems(buildCommandPaletteItems(project()), { collections: ['rooms', 'scenes', 'dialogues', 'scripts'], includeActions: false });
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining([
      'record:rooms:classroom',
      'record:scenes:opening',
      'record:dialogues:intro',
      'record:scripts:boot',
    ]));
    expect(items.some((item) => item.id === 'record:assets:logo')).toBe(false);
  });
});
