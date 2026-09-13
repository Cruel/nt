import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const routes = [
  ['index.html', 'Build worlds that respond.'],
  ['docs/index.html', 'NovelTea documentation'],
  ['docs/dev/index.html', 'NovelTea documentation'],
  ['docs/dev/reference/index.html', 'Project workspace manifest'],
  ['examples/dev/index.html', 'Examples are coming online.'],
  ['download/index.html', 'Downloads will follow the first public builds.'],
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

test('Cloudflare Pages headers isolate only the development example surface', async () => {
  const headers = await readFile(new URL('../dist/_headers', import.meta.url), 'utf8');
  assert.match(headers, /^\/examples\/dev$/m);
  assert.match(headers, /^\/examples\/dev\/\*$/m);
  assert.match(headers, /Cross-Origin-Opener-Policy: same-origin/);
  assert.match(headers, /Cross-Origin-Embedder-Policy: require-corp/);
  assert.match(headers, /Cross-Origin-Resource-Policy: same-origin/);
  assert.doesNotMatch(headers, /^\/\*$/m);
});
