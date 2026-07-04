import { describe, expect, it } from 'vitest';
import { collectProjectTags, normalizeTagKey, normalizeTagName, normalizeTags, tagColorForIndex } from '../../shared/project-schema/authoring-tags';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

describe('authoring tags', () => {
  it('normalizes tag names and keys conservatively', () => {
    expect(normalizeTagName('  main   cast  ')).toBe('main cast');
    expect(normalizeTagKey('Hero')).toBe('hero');
    expect(normalizeTags([' Hero ', 'hero', '', 'main   cast'])).toEqual(['Hero', 'main cast']);
  });

  it('assigns default colors from a modulo color pool', () => {
    expect(tagColorForIndex(0)).toBe('tag-slate');
    expect(tagColorForIndex(20)).toBe('tag-slate');
    expect(tagColorForIndex(21)).toBe('tag-red');
  });

  it('collects project tags with registry colors and collection counts', () => {
    const project = createAuthoringProject();
    project.editor.tags.records.hero = { name: 'Hero', color: 'tag-violet' };
    project.characters.hero = { id: 'hero', label: 'Hero', tags: ['Hero'], data: {} };
    project.assets.voice = { id: 'voice', label: 'Voice', tags: ['Hero', 'voice'], data: {} };

    const tags = collectProjectTags(project);
    expect(tags.find((tag) => tag.key === 'hero')).toMatchObject({
      name: 'Hero',
      color: 'tag-violet',
      count: 2,
      collections: { characters: 1, assets: 1 },
    });
    expect(tags.find((tag) => tag.key === 'voice')).toMatchObject({ name: 'voice', count: 1 });
  });
});
