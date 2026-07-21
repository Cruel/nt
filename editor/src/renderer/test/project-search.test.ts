import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { buildProjectSearchIndex } from '../../shared/project-search/project-search-index';
import { searchProject, searchProjectIndex } from '../../shared/project-search/project-search';

function project() {
  const next = createAuthoringProject();
  next.assets.logo = {
    id: 'logo',
    label: 'Sarah Portrait',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/sarah-portrait.png' },
      aliases: ['sarah_portrait'],
      extension: '.png',
    },
  };
  next.assets.theme = {
    id: 'theme',
    label: 'Main Theme',
    data: {
      kind: 'audio',
      source: { type: 'project-file', path: 'assets/audio/main-theme.ogg' },
      aliases: [],
      extension: '.ogg',
    },
  };
  next.rooms.classroom = {
    id: 'classroom',
    label: 'Classroom',
    data: { hotspot: { target: { $ref: { collection: 'assets', id: 'logo' } } } } as never,
  };
  next.dialogues.intro = {
    id: 'intro',
    label: 'Intro Dialogue',
    data: {
      blocks: [{ segments: [{ text: 'Sarah enters the classroom before the bell rings.' }] }],
    } as never,
  };
  next.scenes.opening = {
    id: 'opening',
    label: 'Opening Scene',
    data: {
      room: { $ref: { collection: 'rooms', id: 'classroom' } },
      portrait: { $asset: { alias: 'sarah_portrait' } },
    } as never,
  };
  next.editor.recordMetadata = {
    assets: { logo: { tags: ['Sarah', 'main cast'] }, theme: { tags: ['Sarah'] } },
    rooms: { classroom: { tags: ['school', 'Sarah'] } },
    scenes: { opening: { tags: ['school'] } },
  };
  return next;
}

function ids(response: ReturnType<typeof searchProject>) {
  return response.results.map((result) => result.document.id);
}

describe('project search service', () => {
  it('indexes authoring records as curated documents', () => {
    const index = buildProjectSearchIndex(project());
    expect(index.documents.map((document) => document.id)).toEqual(
      expect.arrayContaining([
        'settings:display-accessibility',
        'record:assets:logo',
        'record:rooms:classroom',
        'record:dialogues:intro',
      ]),
    );
    expect(
      index.documents.find((document) => document.id === 'settings:display-accessibility')?.fields,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Reference Resolution',
          path: '/settings/display/referenceResolution',
          value: '1920x1080',
        }),
        expect.objectContaining({
          label: 'World Raster Policy',
          path: '/settings/display/worldRasterPolicy',
          value: 'capped',
        }),
        expect.objectContaining({
          label: 'Text Scale Maximum',
          path: '/settings/accessibility/textScale/maximum',
          value: '2',
        }),
      ]),
    );
    expect(
      index.documents.find((document) => document.id === 'record:assets:logo')?.fields,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'id', path: '/assets/logo/id', value: 'logo' }),
        expect.objectContaining({
          kind: 'label',
          path: '/assets/logo/label',
          value: 'Sarah Portrait',
        }),
        expect.objectContaining({
          kind: 'tag',
          path: '/editor/recordMetadata/assets/logo/tags/0',
          value: 'Sarah',
        }),
        expect.objectContaining({ kind: 'type', path: '/assets/logo/data/kind', value: 'image' }),
      ]),
    );
  });

  it('searches display and accessibility project settings', () => {
    expect(ids(searchProject(project(), { text: 'capped' }))).toContain(
      'settings:display-accessibility',
    );
    expect(ids(searchProject(project(), { text: '1920x1080' }))).toContain(
      'settings:display-accessibility',
    );
  });

  it('searches id, label, and tags by default with token all across fields', () => {
    const response = searchProject(project(), { text: 'Sarah classroom', tokenMode: 'all' });
    expect(response.diagnostics).toEqual([]);
    expect(ids(response)).toContain('record:rooms:classroom');
    expect(ids(response)).not.toContain('record:assets:logo');
  });

  it('keeps content opt-in rather than default searchable', () => {
    expect(ids(searchProject(project(), { text: 'bell' }))).not.toContain('record:dialogues:intro');
    expect(ids(searchProject(project(), { text: 'bell', includeFields: ['content'] }))).toContain(
      'record:dialogues:intro',
    );
  });

  it('returns match provenance for field kind and JSON pointer path', () => {
    const response = searchProject(project(), { text: 'Sarah', collections: ['assets'], limit: 1 });
    expect(response.results[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldKind: 'label', path: '/assets/logo/label' }),
        expect.objectContaining({
          fieldKind: 'tag',
          path: '/editor/recordMetadata/assets/logo/tags/0',
        }),
      ]),
    );
  });

  it('filters assets by type independently from tags', () => {
    const response = searchProject(project(), { collections: ['assets'], assetTypes: ['image'] });
    expect(ids(response)).toEqual(['record:assets:logo']);
    expect(response.results[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldKind: 'type',
          path: '/assets/logo/data/kind',
          mode: 'facet',
        }),
      ]),
    );
  });

  it('filters tags with any and all modes', () => {
    expect(ids(searchProject(project(), { tags: ['Sarah', 'main cast'], tagMode: 'all' }))).toEqual(
      ['record:assets:logo'],
    );
    expect(ids(searchProject(project(), { tags: ['Sarah', 'main cast'], tagMode: 'any' }))).toEqual(
      expect.arrayContaining([
        'record:assets:logo',
        'record:assets:theme',
        'record:rooms:classroom',
      ]),
    );
  });

  it('supports exact document and record id structural filters', () => {
    expect(ids(searchProject(project(), { recordIds: ['classroom'] }))).toEqual([
      'record:rooms:classroom',
    ]);
    expect(
      ids(searchProject(project(), { collections: ['assets'], recordIds: ['logo', 'theme'] })),
    ).toEqual(['record:assets:theme', 'record:assets:logo']);
    expect(ids(searchProject(project(), { documentIds: ['record:scenes:opening'] }))).toEqual([
      'record:scenes:opening',
    ]);
  });

  it('supports regex search and invalid regex diagnostics', () => {
    const response = searchProject(project(), { text: 'Sarah\\s+Portrait', mode: 'regex' });
    expect(ids(response)).toContain('record:assets:logo');
    const invalid = searchProject(project(), { text: '[', mode: 'regex' });
    expect(invalid.results).toEqual([]);
    expect(invalid.diagnostics[0]).toMatchObject({ severity: 'error' });
  });

  it('filters by stable reference target using the existing reference index', () => {
    const response = searchProject(project(), {
      referencesTo: [{ collection: 'rooms', id: 'classroom' }],
    });
    expect(ids(response)).toEqual(['record:scenes:opening']);
    expect(response.results[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldKind: 'reference',
          path: '/scenes/opening/data/room/$ref',
          mode: 'reference',
        }),
      ]),
    );
  });

  it('filters by asset alias usage using the existing alias index', () => {
    const response = searchProject(project(), { aliases: ['sarah_portrait'] });
    expect(ids(response)).toEqual(['record:scenes:opening']);
  });

  it('can search an existing index repeatedly', () => {
    const index = buildProjectSearchIndex(project());
    expect(ids(searchProjectIndex(index, { text: 'portrait' }))).toContain('record:assets:logo');
    expect(ids(searchProjectIndex(index, { text: 'classroom' }))).toContain(
      'record:rooms:classroom',
    );
  });
});
