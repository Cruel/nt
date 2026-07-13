import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { buildCommandPaletteItems, filterSelectorItems, searchCommandPaletteItems } from '@/workspace/command-palette-search';

function project() {
  const next = createAuthoringProject();
  next.assets.logo = { id: 'logo', label: 'Sarah Portrait', data: { kind: 'image', source: { type: 'project-file', path: 'assets/sarah.png' }, aliases: [], extension: '.png' } };
  next.assets.theme = { id: 'theme', label: 'Theme', data: { kind: 'audio', source: { type: 'project-file', path: 'assets/theme.ogg' }, aliases: [], extension: '.ogg' } };
  next.layouts.coolLayout = { id: 'coolLayout', label: 'Layout lol', data: { target: 'cool-layout' } as never };
  next.layouts.sadf = { id: 'sadf', label: 'Layout sadf', data: { target: 'sadf-layout' } as never };
  next.rooms.classroom = { id: 'classroom', label: 'Classroom', data: {} as never };
  next.scenes.opening = { id: 'opening', label: 'Opening Scene', data: {} as never };
  next.dialogues.intro = { id: 'intro', label: 'Intro Dialogue', data: {} as never };
  next.scripts.boot = { id: 'boot', label: 'Boot Script', data: { kind: 'script-module', source: { kind: 'inline-lua', source: '' } } };
  next.editor.recordMetadata = {
    assets: { logo: { tags: ['Sarah'] } },
    layouts: { coolLayout: { tags: ['cool'] }, sadf: { tags: ['cool'] } },
    rooms: { classroom: { tags: ['school'] } },
  };
  return next;
}

describe('command palette search', () => {
  it('builds action and project record items', () => {
    const items = buildCommandPaletteItems(project());
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining([
      'action:settings',
      'action:new-project',
      'action:open-project',
      'action:comfyui-workflows',
      'action:project-settings',
      'record:assets:logo',
      'record:rooms:classroom',
    ]));
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

  it('shows only non-project actions without project data', () => {
    const items = buildCommandPaletteItems(null);
    expect(items.map((item) => item.id)).toEqual(['action:settings', 'action:new-project', 'action:open-project', 'action:comfyui-workflows']);
    expect(searchCommandPaletteItems(items, 'settings')[0]?.item.id).toBe('action:settings');
    expect(searchCommandPaletteItems(items, 'workflow manager')[0]?.item.id).toBe('action:comfyui-workflows');
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
