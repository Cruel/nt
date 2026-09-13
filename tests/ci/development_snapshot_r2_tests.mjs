import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { r2Store } from '../../scripts/development-snapshot-r2.mjs';

async function server(t, handler) {
  const instance = createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => instance.close());
  return r2Store({
    accountId: 'a'.repeat(32),
    token: 'test-token',
    apiOrigin: `http://127.0.0.1:${instance.address().port}`,
  });
}

test('R2 transport preserves bytes and cache policy, lists every page, and deletes objects', async (t) => {
  const objects = new Map();
  const store = await server(t, async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-token');
    const url = new URL(request.url, 'http://localhost');
    const key = url.pathname.split('/objects/')[1];
    if (!key) {
      assert.equal(url.searchParams.get('prefix'), 'development/toolchains/');
      const second = url.searchParams.get('cursor') === 'next';
      response.end(
        JSON.stringify({
          success: true,
          result: [{ key: second ? 'second' : 'first', last_modified: '2026-09-12T00:00:00Z' }],
          result_info: { is_truncated: !second, ...(!second ? { cursor: 'next' } : {}) },
        }),
      );
    } else if (request.method === 'PUT') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks));
      assert.equal(
        request.headers['cache-control'],
        key.endsWith('current.json') ? 'no-store' : 'public, max-age=604800, immutable',
      );
      response.end(JSON.stringify({ success: true }));
    } else if (request.method === 'DELETE') {
      objects.delete(key);
      response.end(JSON.stringify({ success: true }));
    } else if (objects.has(key)) response.end(objects.get(key));
    else {
      response.statusCode = 404;
      response.end();
    }
  });
  const key = 'development/toolchains/current.json';
  assert.equal(await store.get(key), null);
  await store.put(key, Buffer.from('{}'));
  await store.put('development/toolchains/abc/file', Buffer.from([0, 255, 13]));
  assert.deepEqual(await store.get('development/toolchains/abc/file'), Buffer.from([0, 255, 13]));
  assert.deepEqual(
    (await store.list('development/toolchains/')).map((item) => item.key),
    ['first', 'second'],
  );
  await store.delete(key);
  assert.equal(await store.get(key), null);
});

test('R2 listing accepts a complete single page without pagination metadata', async (t) => {
  const store = await server(t, (_request, response) => {
    response.end(JSON.stringify({ success: true, result: [{ key: 'only' }] }));
  });
  assert.deepEqual(await store.list('development/toolchains/'), [{ key: 'only' }]);
});

test('R2 errors and incomplete pagination fail closed', async (t) => {
  let fail = true;
  const store = await server(t, (_request, response) => {
    if (fail) {
      response.statusCode = 403;
      response.end('credential detail must not escape');
    } else
      response.end(
        JSON.stringify({ success: true, result: [], result_info: { is_truncated: true } }),
      );
  });
  await assert.rejects(store.get('current.json'), /^Error: R2 GET failed \(403\)$/);
  fail = false;
  await assert.rejects(store.list('development/toolchains/'), /pagination/);
});
