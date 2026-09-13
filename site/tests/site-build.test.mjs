import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const routes = [
  ['index.html', 'Build worlds that respond.'],
  ['docs/index.html', 'NovelTea documentation'],
  ['docs/dev/index.html', 'NovelTea documentation'],
  ['docs/dev/reference/index.html', 'Project workspace manifest'],
  ['examples/dev/index.html', 'Examples are coming online.'],
  [
    'download/index.html',
    process.env.NOVELTEA_RELEASE_MANIFEST_PATH ? 'Start building with NovelTea.' : 'NovelTea is under active development.',
  ],
];

for (const [path, marker] of routes) {
  test(`static build emits ${path}`, async () => {
    const html = await readFile(new URL(`../dist/${path}`, import.meta.url), 'utf8');
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

test('unqualified docs resolve to the active public channel', async () => {
  const html = await readFile(new URL('../dist/docs/index.html', import.meta.url), 'utf8');
  assert.match(html, /NovelTea documentation/);
  if (process.env.NOVELTEA_DOCS_RELEASE_VERSION) {
    assert.match(html, /Released/);
    assert.match(html, new RegExp(process.env.NOVELTEA_DOCS_RELEASE_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(html, /Unreleased development channel/);
  } else {
    assert.match(html, /Unreleased/);
    assert.match(html, /href="\/docs\/dev\//);
  }
});

test('development docs expose persistent channel navigation', async () => {
  const html = await readFile(new URL('../dist/docs/dev/index.html', import.meta.url), 'utf8');
  assert.match(html, /Docs channel/);
  assert.match(html, /Latest/);
  assert.match(html, /Dev/);
  assert.match(html, /Unreleased/);
});

test('generated development schema reference exposes human and raw canonical output', async () => {
  const html = await readFile(new URL('../dist/docs/dev/reference/index.html', import.meta.url), 'utf8');
  assert.match(html, /Unreleased development channel/);
  assert.match(html, /Raw JSON Schema/);
  assert.match(html, /\/docs\/dev\/reference\/raw\/project\.schema\.json/);

  const raw = JSON.parse(
    await readFile(
      new URL('../dist/docs/dev/reference/raw/project.schema.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(raw.type, 'object');
  assert.ok(raw.properties.project);
  assert.ok(raw.properties.schemaVersion);
});

if (process.env.NOVELTEA_DOCS_RELEASE_VERSION) {
  test('latest reference is composed from release-rendered output', async () => {
    const html = await readFile(new URL('../dist/docs/reference/index.html', import.meta.url), 'utf8');
    assert.match(html, /Latest release/);
    assert.match(html, /\/docs\/reference\/raw\/project\.schema\.json/);
    assert.doesNotMatch(html, /Unreleased development channel/);
  });
}

test('download page reflects the supported release state without exposing source-repository release URLs', async () => {
  const html = await readFile(new URL('../dist/download/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /github\.com\/Cruel\/nt\/releases\/download/);
  if (process.env.NOVELTEA_RELEASE_MANIFEST_PATH) {
    assert.match(html, /Latest release/);
    assert.match(html, /Desktop editor/);
    assert.match(html, /Standalone CLI/);
    assert.match(html, /data-platform="windows"/);
    assert.match(html, /data-platform="linux"/);
    assert.match(html, /github\.com\/Cruel\/noveltea-releases\/releases\/download/);
    assert.match(html, /data-detected-label/);
  } else {
    assert.match(html, /There is not a supported public release yet/);
    assert.match(html, /Development builds from/);
    assert.doesNotMatch(html, /github\.com\/Cruel\/noveltea-releases\/releases\/download/);
  }
});

test('Cloudflare Pages headers isolate only the development example surface', async () => {
  const headers = await readFile(new URL('../dist/_headers', import.meta.url), 'utf8');
  assert.match(headers, /^\/examples\/dev$/m);
  assert.match(headers, /^\/examples\/dev\/\*$/m);
  assert.match(headers, /Cross-Origin-Opener-Policy: same-origin/);
  assert.match(headers, /Cross-Origin-Embedder-Policy: require-corp/);
  assert.match(headers, /Cross-Origin-Resource-Policy: same-origin/);
  assert.doesNotMatch(headers, /^\/\*$/m);
});
