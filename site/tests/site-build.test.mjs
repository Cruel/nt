import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const routes = [
  ['index.html', 'Build worlds that respond.'],
  ['docs/index.html', 'NovelTea documentation'],
  ['docs/dev/index.html', 'NovelTea documentation'],
  ['docs/dev/reference/index.html', 'Project workspace manifest'],
  ['examples/dev/index.html', 'See the project model in motion.'],
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

test('landing page is creator-first and exposes the primary product paths', async () => {
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  assert.match(html, /Build worlds that respond\./);
  assert.match(html, /Shape the story\. Script the possibilities\./);
  assert.match(html, /Built for narrative creators/);
  assert.match(html, /Active development/);
  assert.match(html, /href="\/docs\//);
  assert.match(html, /href="\/examples\/dev\//);
  assert.match(html, /href="\/download\//);
});

test('marketing and Starlight share the NovelTea wordmark treatment', async () => {
  const home = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  const docs = await readFile(new URL('../dist/docs/dev/index.html', import.meta.url), 'utf8');
  assert.match(home, /nt-wordmark__mark/);
  assert.match(docs, /nt-wordmark__mark/);
});

test('landing page motion has a reduced-motion fallback in the emitted stylesheet', async () => {
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  const stylesheetHref = html.match(/<link rel="stylesheet" href="([^\"]+\.css)"/)?.[1];
  assert.ok(stylesheetHref, 'expected the landing page to emit a stylesheet');
  const css = await readFile(new URL(`../dist${stylesheetHref}`, import.meta.url), 'utf8');
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

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

test('development showcase exposes the pinned examples and handoff actions', async () => {
  const html = await readFile(new URL('../dist/examples/dev/index.html', import.meta.url), 'utf8');
  assert.match(html, /Materials/);
  assert.match(html, /Verbs/);
  assert.match(html, /Open in NovelTea/);
  assert.match(html, /Download Project/);
  assert.match(html, /View Source/);
  assert.match(html, /noveltea:\/\/import/);
  assert.match(html, /data-example-player/);

  const catalog = JSON.parse(
    await readFile(new URL('../dist/examples/dev/catalog.json', import.meta.url), 'utf8'),
  );
  assert.equal(catalog.format, 'noveltea.site-example-catalog');
  assert.deepEqual(catalog.examples.map((example) => example.id), ['materials', 'verbs']);
  assert.match(catalog.examples[0].projectUrl, /\.ntproject$/);
  assert.match(catalog.examples[0].projectSha256, /^[0-9a-f]{64}$/);
});

test('development showcase exposes only explicit immutable PR preview mode', async () => {
  const html = await readFile(new URL('../dist/examples/dev/index.html', import.meta.url), 'utf8');
  assert.match(html, /\.get\('preview'\)/);
  assert.match(html, /examples\/dev\/preview-assets/);
  assert.match(html, /\^pr-\(\[1-9\]\[0-9\]\*\)\\\/\(\[0-9a-f\]\{40\}\)\$/);
  assert.match(html, /preview\.examples\.some/);
  assert.match(html, /projectUrl\?\.startsWith\(prefix\)/);
  assert.match(html, /playerUrl\?\.startsWith\(prefix\)/);
});

test('Cloudflare Pages headers isolate only the development example surface', async () => {
  const headers = await readFile(new URL('../dist/_headers', import.meta.url), 'utf8');
  assert.match(headers, /^\/examples\/dev$/m);
  assert.match(headers, /^\/examples\/dev\/\*$/m);
  assert.match(headers, /Cross-Origin-Opener-Policy: same-origin/);
  assert.match(headers, /Cross-Origin-Embedder-Policy: require-corp/);
  assert.match(headers, /Cross-Origin-Resource-Policy: same-origin/);
  assert.match(headers, /Permissions-Policy: cross-origin-isolated=\(self "https:\/\/noveltea\.pages\.dev"\)/);
  assert.doesNotMatch(headers, /^\/\*$/m);
});
