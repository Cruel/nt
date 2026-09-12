import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const routes = [
  ['index.html', 'Build worlds that respond.'],
  ['docs/dev/index.html', 'Development documentation'],
  ['examples/dev/index.html', 'Examples are coming online.'],
  ['download/index.html', 'Downloads will follow the first public builds.'],
];

for (const [path, marker] of routes) {
  test(`static build emits ${path}`, async () => {
    const html = await readFile(new URL(`../dist/${path}`, import.meta.url), 'utf8');
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
