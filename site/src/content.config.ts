import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

const repoRoot = new URL('../../', import.meta.url);
const siteDocsPrefix = 'site/src/content/docs/';
const sharedConceptsPrefix = 'docs/public/concepts/';
const documentationExtensions = 'markdown,mdown,mkdn,mkd,mdwn,md,mdx';

function contentId(relativePath: string): string {
  const withoutExtension = relativePath.replace(/\.(?:markdown|mdown|mkdn|mkd|mdwn|md|mdx)$/u, '');
  return withoutExtension.endsWith('/index')
    ? withoutExtension.slice(0, -'/index'.length)
    : withoutExtension;
}

function documentationId(entry: string): string {
  if (entry.startsWith(siteDocsPrefix)) return contentId(entry.slice(siteDocsPrefix.length));
  if (entry.startsWith(sharedConceptsPrefix))
    return `docs/dev/concepts/${contentId(entry.slice(sharedConceptsPrefix.length))}`;
  throw new Error(`Unexpected documentation source '${entry}'.`);
}

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: repoRoot,
      pattern: [
        `${siteDocsPrefix}**/[^_]*.{${documentationExtensions}}`,
        `${sharedConceptsPrefix}**/[^_]*.{${documentationExtensions}}`,
      ],
      generateId: ({ entry }) => documentationId(entry),
    }),
    schema: docsSchema(),
  }),
};
