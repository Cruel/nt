import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  searchAssets,
  searchRecords,
  searchReferences,
} from '../../shared/project-search/project-search-helpers';

function project() {
  const next = createAuthoringProject();
  next.assets.logo = {
    id: 'logo',
    label: 'Sarah Portrait',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/sarah.png' },
      aliases: ['sarah_portrait'],
      extension: '.png',
    },
  };
  next.assets.theme = {
    id: 'theme',
    label: 'Main Theme',
    data: {
      kind: 'audio',
      source: { type: 'project-file', path: 'assets/audio/theme.ogg' },
      aliases: [],
      extension: '.ogg',
    },
  };
  next.rooms.classroom = {
    id: 'classroom',
    label: 'Classroom',
    data: {} as never,
  };
  next.scenes.opening = {
    id: 'opening',
    label: 'Opening Scene',
    data: {
      room: { $ref: { collection: 'rooms', id: 'classroom' } },
      logo: { $ref: { collection: 'assets', id: 'logo' } },
      portrait: { $asset: { alias: 'sarah_portrait' } },
    } as never,
  };
  next.editor.recordMetadata = {
    assets: { logo: { tags: ['Sarah'] }, theme: { tags: ['Sarah'] } },
    rooms: { classroom: { tags: ['school'] } },
    scenes: { opening: { tags: ['school'] } },
  };
  return next;
}

function ids(results: ReturnType<typeof searchAssets>) {
  return results.results.map((result) => result.document.id);
}

describe('project search helpers', () => {
  it('searches assets with asset type and tag defaults suitable for picker dialogs', () => {
    const response = searchAssets(project(), {
      text: 'sarah',
      assetTypes: ['image'],
      tags: ['Sarah'],
    });
    expect(response.diagnostics).toEqual([]);
    expect(ids(response)).toEqual(['record:assets:logo']);
  });

  it('searches arbitrary record collections', () => {
    const response = searchRecords(project(), { text: 'class', collections: ['rooms'] });
    expect(ids(response)).toEqual(['record:rooms:classroom']);
  });

  it('searches stable references through the shared result model', () => {
    const response = searchReferences(project(), {
      referencesTo: [{ collection: 'rooms', id: 'classroom' }],
    });
    expect(ids(response)).toEqual(['record:scenes:opening']);
    expect(response.results[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldKind: 'reference', mode: 'reference' }),
      ]),
    );
  });

  it('searches asset alias references through the shared result model', () => {
    const response = searchReferences(project(), { aliases: ['sarah_portrait'] });
    expect(ids(response)).toEqual(['record:scenes:opening']);
    expect(response.results[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldKind: 'alias', mode: 'reference', value: 'sarah_portrait' }),
      ]),
    );
  });

  it('unifies stable and asset alias reference searches', () => {
    const response = searchReferences(project(), {
      referencesTo: [{ collection: 'assets', id: 'logo' }],
      aliases: ['sarah_portrait'],
    });
    expect(ids(response)).toEqual(['record:scenes:opening']);
    expect(response.results[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldKind: 'reference', mode: 'reference' }),
        expect.objectContaining({ fieldKind: 'alias', mode: 'reference' }),
      ]),
    );
  });
});
