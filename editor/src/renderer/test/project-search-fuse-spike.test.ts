import Fuse, { type FuseResult, type FuseResultMatch, type IFuseOptions } from 'fuse.js';
import { describe, expect, it } from 'vitest';

type SpikeFieldKind = 'id' | 'label' | 'tag' | 'type' | 'content';

interface SpikeField {
  kind: SpikeFieldKind;
  path: string;
  value: string;
}

interface SpikeDocument {
  id: string;
  collection: string;
  entityId: string;
  label: string;
  fields: SpikeField[];
}

const documents: SpikeDocument[] = [
  {
    id: 'record:assets:logo',
    collection: 'assets',
    entityId: 'logo',
    label: 'Sarah Portrait',
    fields: [
      { kind: 'id', path: '/assets/logo/id', value: 'logo' },
      { kind: 'label', path: '/assets/logo/label', value: 'Sarah Portrait' },
      { kind: 'tag', path: '/assets/logo/tags/0', value: 'Sarah' },
      { kind: 'tag', path: '/assets/logo/tags/1', value: 'main cast' },
      { kind: 'tag', path: '/assets/logo/tags/2', value: 'VIP' },
      { kind: 'type', path: '/assets/logo/data/kind', value: 'image' },
      { kind: 'content', path: '/assets/logo/data/source/path', value: 'assets/images/sarah-portrait.png' },
    ],
  },
  {
    id: 'record:rooms:classroom',
    collection: 'rooms',
    entityId: 'classroom',
    label: 'Classroom',
    fields: [
      { kind: 'id', path: '/rooms/classroom/id', value: 'classroom' },
      { kind: 'label', path: '/rooms/classroom/label', value: 'Classroom' },
      { kind: 'tag', path: '/rooms/classroom/tags/0', value: 'school' },
      { kind: 'tag', path: '/rooms/classroom/tags/1', value: 'Sarah' },
    ],
  },
  {
    id: 'record:dialogues:intro',
    collection: 'dialogues',
    entityId: 'intro',
    label: 'Intro Dialogue',
    fields: [
      { kind: 'id', path: '/dialogues/intro/id', value: 'intro' },
      { kind: 'label', path: '/dialogues/intro/label', value: 'Intro Dialogue' },
      { kind: 'content', path: '/dialogues/intro/data/blocks/0/segments/0/text', value: 'Sarah enters the classroom before the bell rings.' },
    ],
  },
  {
    id: 'record:assets:theme',
    collection: 'assets',
    entityId: 'theme',
    label: 'Main Theme',
    fields: [
      { kind: 'id', path: '/assets/theme/id', value: 'theme' },
      { kind: 'label', path: '/assets/theme/label', value: 'Main Theme' },
      { kind: 'tag', path: '/assets/theme/tags/0', value: 'Sarah' },
      { kind: 'type', path: '/assets/theme/data/kind', value: 'audio' },
      { kind: 'content', path: '/assets/theme/data/source/path', value: 'assets/audio/main-theme.ogg' },
    ],
  },
  {
    id: 'record:dialogues:lore',
    collection: 'dialogues',
    entityId: 'lore',
    label: 'History Note',
    fields: [
      { kind: 'id', path: '/dialogues/lore/id', value: 'lore' },
      { kind: 'label', path: '/dialogues/lore/label', value: 'History Note' },
      { kind: 'content', path: '/dialogues/lore/data/blocks/0/segments/0/text', value: 'A very long passage eventually mentions Sarah after a lot of unrelated background text.' },
    ],
  },
];

function search(options: IFuseOptions<SpikeDocument>, pattern: string) {
  return new Fuse(documents, options).search(pattern);
}

function tokenFuse(tokenMatch: 'all' | 'any', caseSensitive = false) {
  return new Fuse(documents, {
    useTokenSearch: true,
    tokenMatch,
    isCaseSensitive: caseSensitive,
    includeScore: true,
    includeMatches: true,
    ignoreLocation: true,
    threshold: 0.35,
    keys: [
      { name: 'fields.value', weight: 1 },
    ],
  });
}

function weightedTokenFuse() {
  return new Fuse(documents, {
    useTokenSearch: true,
    tokenMatch: 'any',
    includeScore: true,
    includeMatches: true,
    ignoreLocation: true,
    threshold: 0.35,
    keys: [
      { name: 'fields.value', weight: 1 },
      { name: 'label', weight: 2 },
      { name: 'id', weight: 1.5 },
    ],
  });
}

function ids(results: FuseResult<SpikeDocument>[]) {
  return results.map((result) => result.item.id);
}

function fieldForMatch(document: SpikeDocument, match: FuseResultMatch): SpikeField | null {
  const refIndex = typeof match.refIndex === 'number' ? match.refIndex : null;
  if (match.key === 'fields.value' && refIndex !== null) return document.fields[refIndex] ?? null;
  return null;
}

describe('Fuse.js project search spike', () => {
  it('supports token match all across multiple curated fields on the same document', () => {
    const results = tokenFuse('all').search('sarah classroom');
    expect(ids(results)).toEqual(expect.arrayContaining(['record:rooms:classroom', 'record:dialogues:intro']));
    expect(ids(results)).toHaveLength(2);
  });

  it('supports token match any for broad discovery', () => {
    const results = tokenFuse('any').search('sarah classroom');
    expect(ids(results)).toContain('record:assets:logo');
    expect(ids(results)).toContain('record:rooms:classroom');
    expect(ids(results)).toContain('record:dialogues:intro');
    expect(ids(results)).toContain('record:assets:theme');
  });

  it('supports typo-tolerant token search for picker-style queries', () => {
    const results = tokenFuse('all').search('srah portrait');
    expect(ids(results)[0]).toBe('record:assets:logo');
  });

  it('is case-insensitive by default and supports case-sensitive search', () => {
    expect(ids(tokenFuse('any').search('vip'))).toContain('record:assets:logo');
    expect(ids(tokenFuse('any', true).search('vip'))).not.toContain('record:assets:logo');
    expect(ids(tokenFuse('any', true).search('VIP'))).toContain('record:assets:logo');
  });

  it('returns match output that can be mapped back to field kind and JSON pointer path', () => {
    const [result] = tokenFuse('any').search('portrait');
    expect(result?.item.id).toBe('record:assets:logo');
    const mapped = result.matches?.flatMap((match) => {
      const field = fieldForMatch(result.item, match);
      return field ? [{ fieldKind: field.kind, path: field.path, ranges: match.indices }] : [];
    }) ?? [];
    expect(mapped).toContainEqual(expect.objectContaining({ fieldKind: 'label', path: '/assets/logo/label' }));
    expect(mapped.some((match) => match.ranges.length > 0)).toBe(true);
  });

  it('returns match output that can distinguish tag matches from label matches', () => {
    const [result] = tokenFuse('any').search('Sarah');
    expect(result?.item.id).toBe('record:assets:logo');
    const mapped = result.matches?.flatMap((match) => {
      const field = fieldForMatch(result.item, match);
      return field ? [{ fieldKind: field.kind, path: field.path }] : [];
    }) ?? [];
    expect(mapped).toContainEqual({ fieldKind: 'label', path: '/assets/logo/label' });
    expect(mapped).toContainEqual({ fieldKind: 'tag', path: '/assets/logo/tags/0' });
  });

  it('can rank label/id hits ahead of the same term found only in long content with weighted keys', () => {
    const results = weightedTokenFuse().search('Sarah');
    expect(ids(results).indexOf('record:assets:logo')).toBeLessThan(ids(results).indexOf('record:dialogues:lore'));
  });

  it('can import the full Fuse build with token search enabled under Vitest', () => {
    const results = search({ useTokenSearch: true, tokenMatch: 'all', keys: ['fields.value'] }, 'Sarah classroom');
    expect(results.length).toBeGreaterThan(0);
  });
});
