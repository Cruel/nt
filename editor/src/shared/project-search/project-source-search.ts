import type { ProjectSourceFile } from '../project-source-files';
import { searchDocuments } from './project-search';
import type { ProjectSearchDocument, ProjectSearchResponse } from './project-search-types';

export function buildProjectSourceSearchDocuments(
  files: readonly ProjectSourceFile[],
  textById: Readonly<Record<string, string>>,
): ProjectSearchDocument[] {
  return files.map((file) => ({
    id: `source:${file.id}`,
    kind: 'subdocument',
    label: file.displayPath.split('/').at(-1) ?? file.displayPath,
    sourcePath: file.displayPath,
    fields: [
      {
        kind: 'title',
        label: 'File',
        value: file.displayPath.split('/').at(-1) ?? file.displayPath,
        path: file.displayPath,
        weight: 4,
        defaultSearchable: true,
      },
      {
        kind: 'content',
        label: 'Path',
        value: file.displayPath,
        path: file.displayPath,
        weight: 3,
        defaultSearchable: true,
      },
      ...(file.text && textById[file.id] !== undefined
        ? [
            {
              kind:
                file.kind === 'lua' || file.kind === 'layout-lua'
                  ? ('script' as const)
                  : ('content' as const),
              label: 'Content',
              value: textById[file.id]!,
              path: file.displayPath,
              weight: 1,
              defaultSearchable: true,
            },
          ]
        : []),
    ],
    facets: { tags: [] },
    references: [],
    assetAliasUsages: [],
  }));
}

export function searchProjectSourceFiles(
  files: readonly ProjectSourceFile[],
  textById: Readonly<Record<string, string>>,
  text: string,
  exactMatch = false,
): ProjectSearchResponse {
  const query = text.trim();
  if (!query)
    return {
      results: buildProjectSourceSearchDocuments(files, textById).map((document) => ({
        document,
        score: 0,
        matches: [],
      })),
      diagnostics: [],
    };
  return searchDocuments(buildProjectSourceSearchDocuments(files, textById), {
    text: query,
    mode: exactMatch ? 'token' : 'fuzzy',
    threshold: exactMatch ? 0 : 0.35,
    sort: { kind: 'label' },
  });
}
