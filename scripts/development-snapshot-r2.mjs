// R2's REST object API uses the provisioned Cloudflare bearer token, as Wrangler does.
export function r2Store({ accountId, token, apiOrigin = 'https://api.cloudflare.com' }) {
  if (!/^[0-9a-f]{32}$/.test(accountId) || !token)
    throw new Error('Missing Cloudflare publication credentials');
  const root = `${apiOrigin}/client/v4/accounts/${accountId}/r2/buckets/noveltea-artifacts/objects`;
  const objectUrl = (key) => `${root}/${key.split('/').map(encodeURIComponent).join('/')}`;
  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(120_000),
      redirect: 'error',
    });
    if (response.status === 404 && options.method === 'GET') return null;
    if (!response.ok) throw new Error(`R2 ${options.method} failed (${response.status})`);
    return response;
  }
  return {
    async get(key) {
      const response = await request(objectUrl(key), { method: 'GET' });
      return response ? Buffer.from(await response.arrayBuffer()) : null;
    },
    async put(key, body) {
      await request(objectUrl(key), {
        method: 'PUT',
        body,
        headers: {
          'Content-Type': key.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          'Cache-Control': key.endsWith('/current.json')
            ? 'no-store'
            : 'public, max-age=604800, immutable',
        },
      });
    },
    async delete(key) {
      await request(objectUrl(key), { method: 'DELETE' });
    },
    async list(prefix) {
      const objects = [];
      let cursor;
      const seen = new Set();
      do {
        const query = new URLSearchParams({
          prefix,
          per_page: '1000',
          ...(cursor ? { cursor } : {}),
        });
        const response = await request(`${root}?${query}`, { method: 'GET' });
        if (!response) throw new Error('Snapshot bucket not found');
        const page = await response.json();
        if (page.success !== true || !Array.isArray(page.result))
          throw new Error('Invalid R2 listing');
        objects.push(...page.result);
        const truncated = page.result_info?.is_truncated === true;
        cursor = truncated ? page.result_info.cursor : undefined;
        if (truncated && (!cursor || seen.has(cursor)))
          throw new Error('Invalid R2 pagination cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return objects;
    },
  };
}
