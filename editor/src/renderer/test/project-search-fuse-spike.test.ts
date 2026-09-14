import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { searchProject } from '../../shared/project-search/project-search';

function project() {
  const next = createAuthoringProject();
  next.assets.logo = {
    id: 'logo',
    label: 'Sarah Portrait',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/sarah-portrait.png' },
      aliases: [],
      extension: '.png',
      imageMetadata: { width: 640, height: 960, hasAlpha: true, orientation: 1 },
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
      imageMetadata: null,
    },
  };
  return next;
}

describe('project search fuzzy behavior', () => {
  it('routes typo-tolerant fuzzy matching through the production search service', () => {
    const response = searchProject(project(), { text: 'Srah Portriat', mode: 'fuzzy' });

    expect(response.results[0]?.document.id).toBe('record:assets:logo');
    expect(response.results[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldKind: 'label',
          path: '/assets/logo/label',
          mode: 'fuzzy',
        }),
      ]),
    );
  });

  it('honors regex case sensitivity at the public Project Search boundary', () => {
    const insensitive = searchProject(project(), { text: 'sarah', mode: 'regex' });
    const lowercase = searchProject(project(), {
      text: 'sarah',
      mode: 'regex',
      caseSensitive: true,
    });
    const matchingCase = searchProject(project(), {
      text: 'Sarah',
      mode: 'regex',
      caseSensitive: true,
    });

    expect(insensitive.results[0]?.document.id).toBe('record:assets:logo');
    expect(lowercase.results).toEqual([]);
    expect(matchingCase.results[0]?.document.id).toBe('record:assets:logo');
  });
});
