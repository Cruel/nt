import { describe, expect, it } from 'vite-plus/test';
import {
  completeDesktopProjectImportRequestSchema,
  normalizeDesktopProjectImportArgument,
} from '../../shared/project-import-handoff';

describe('desktop Project import handoff', () => {
  it('normalizes local .ntproject file-open arguments', () => {
    expect(normalizeDesktopProjectImportArgument('./fixtures/My Story.ntproject', '/work')).toEqual(
      {
        source: {
          kind: 'local',
          bundlePath: '/work/fixtures/My Story.ntproject',
        },
        suggestedName: 'My Story',
      },
    );
  });

  it('normalizes the fixed noveltea:// remote import contract', () => {
    const request = normalizeDesktopProjectImportArgument(
      'noveltea://import?url=https%3A%2F%2Fassets.noveltea.dev%2Fexamples%2Fverbs.ntproject&sha256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&name=Verbs%20Example',
      '/work',
    );

    expect(request).toEqual({
      source: {
        kind: 'remote',
        url: 'https://assets.noveltea.dev/examples/verbs.ntproject',
        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      suggestedName: 'Verbs Example',
    });
  });

  it('keeps the renderer-to-main completion contract on the same HTTPS artifact boundary', () => {
    const base = {
      request: {
        source: {
          kind: 'remote' as const,
          sha256: 'a'.repeat(64),
        },
        suggestedName: 'Fixture',
      },
      projectName: 'Fixture',
      destination: '/work/fixture',
    };

    expect(
      completeDesktopProjectImportRequestSchema.safeParse({
        ...base,
        request: {
          ...base.request,
          source: { ...base.request.source, url: 'https://example.com/fixture.ntproject' },
        },
      }).success,
    ).toBe(true);
    expect(
      completeDesktopProjectImportRequestSchema.safeParse({
        ...base,
        request: {
          ...base.request,
          source: { ...base.request.source, url: 'http://example.com/fixture.ntproject' },
        },
      }).success,
    ).toBe(false);
    expect(
      completeDesktopProjectImportRequestSchema.safeParse({
        ...base,
        request: {
          ...base.request,
          source: {
            ...base.request.source,
            url: 'https://user:secret@example.com/fixture.ntproject',
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects unsafe or malformed remote handoffs', () => {
    expect(
      normalizeDesktopProjectImportArgument(
        'noveltea://import?url=http%3A%2F%2Fexample.com%2Fproject.ntproject&sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '/work',
      ),
    ).toBeNull();
    expect(
      normalizeDesktopProjectImportArgument(
        'noveltea://import?url=https%3A%2F%2Fexample.com%2Fproject.ntproject&sha256=bad',
        '/work',
      ),
    ).toBeNull();
    expect(
      normalizeDesktopProjectImportArgument(
        'noveltea://other?url=https%3A%2F%2Fexample.com%2Fproject.ntproject&sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '/work',
      ),
    ).toBeNull();
  });
});
