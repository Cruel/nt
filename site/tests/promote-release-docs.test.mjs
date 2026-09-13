import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { promoteReleaseDocs } from '../scripts/promote-release-docs.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'noveltea-release-docs-'));
  const releaseDist = join(root, 'release');
  const targetDist = join(root, 'target');
  await mkdir(join(releaseDist, 'docs/dev/reference/raw'), { recursive: true });
  await mkdir(join(releaseDist, '_astro'), { recursive: true });
  await mkdir(join(targetDist, 'docs/dev'), { recursive: true });
  await mkdir(join(targetDist, '_astro'), { recursive: true });
  await writeFile(join(targetDist, 'docs/dev/index.html'), 'master development docs');
  return { releaseDist, targetDist };
}

test('promotes exact release-rendered docs to /docs without replacing /docs/dev', async () => {
  const { releaseDist, targetDist } = await fixture();
  await writeFile(
    join(releaseDist, 'docs/dev/index.html'),
    '<link rel="canonical" href="https://noveltea.dev/docs/dev/"><p>Docs channel</p><p>Released · v1.2.3</p><a href="/docs/dev/">Dev</a>',
  );
  await writeFile(
    join(releaseDist, 'docs/dev/reference/index.html'),
    '<meta property="og:url" content="https://noveltea.dev/docs/dev/reference/">release reference v1.2.3',
  );
  await writeFile(join(releaseDist, 'docs/dev/reference/raw/project.schema.json'), '{}');
  await writeFile(join(releaseDist, '_astro/release.css'), 'release asset');

  await promoteReleaseDocs({ releaseDist, targetDist, releaseVersion: 'v1.2.3' });

  const latestIndex = await readFile(join(targetDist, 'docs/index.html'), 'utf8');
  assert.match(latestIndex, /v1\.2\.3/);
  assert.match(latestIndex, /https:\/\/noveltea\.dev\/docs\//);
  assert.doesNotMatch(latestIndex, /https:\/\/noveltea\.dev\/docs\/dev\//);
  assert.match(latestIndex, /href="\/docs\/dev\/"/);
  assert.equal(await readFile(join(targetDist, 'docs/dev/index.html'), 'utf8'), 'master development docs');
  assert.equal(
    await readFile(join(targetDist, 'docs/reference/index.html'), 'utf8'),
    '<meta property="og:url" content="https://noveltea.dev/docs/reference/">release reference v1.2.3',
  );
  assert.equal(await readFile(join(targetDist, '_astro/release.css'), 'utf8'), 'release asset');
});

test('refuses to promote docs that were not rendered as the expected release', async () => {
  const { releaseDist, targetDist } = await fixture();
  await writeFile(join(releaseDist, 'docs/dev/index.html'), '<p>Unreleased development channel</p>');

  await assert.rejects(
    promoteReleaseDocs({ releaseDist, targetDist, releaseVersion: 'v1.2.3' }),
    /not rendered in latest-channel mode/,
  );
});
