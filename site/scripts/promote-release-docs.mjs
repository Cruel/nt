import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const releaseDocsOrigin = 'https://noveltea.dev/docs/dev';
const latestDocsOrigin = 'https://noveltea.dev/docs';

async function rewritePromotedPageUrls(sourceDirectory, targetDirectory) {
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = resolve(sourceDirectory, entry.name);
    const targetPath = resolve(targetDirectory, entry.name);
    if (entry.isDirectory()) {
      await rewritePromotedPageUrls(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;

    const html = await readFile(targetPath, 'utf8');
    await writeFile(targetPath, html.replaceAll(releaseDocsOrigin, latestDocsOrigin));
  }
}

export async function promoteReleaseDocs({ releaseDist, targetDist, releaseVersion }) {
  const sourceDocs = resolve(releaseDist, 'docs/dev');
  const sourceIndex = await readFile(resolve(sourceDocs, 'index.html'), 'utf8');

  if (!sourceIndex.includes('Docs channel') || !sourceIndex.includes('Released')) {
    throw new Error(
      'Release documentation was not rendered in latest-channel mode; refusing to publish it as /docs.',
    );
  }
  if (releaseVersion && !sourceIndex.includes(releaseVersion)) {
    throw new Error(
      `Release documentation does not identify expected release ${releaseVersion}; refusing to compose mixed revisions.`,
    );
  }

  const targetDocs = resolve(targetDist, 'docs');
  await mkdir(targetDocs, { recursive: true });
  await cp(sourceDocs, targetDocs, { recursive: true, force: true });
  await rewritePromotedPageUrls(sourceDocs, targetDocs);

  // Release-rendered pages may reference asset hashes produced by that exact revision.
  await cp(resolve(releaseDist, '_astro'), resolve(targetDist, '_astro'), {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [releaseDist, targetDist, releaseVersion] = process.argv.slice(2);
  if (!releaseDist || !targetDist || !releaseVersion) {
    console.error(
      'usage: node scripts/promote-release-docs.mjs <release-dist> <target-dist> <release-version>',
    );
    process.exit(2);
  }
  await promoteReleaseDocs({ releaseDist, targetDist, releaseVersion });
}
