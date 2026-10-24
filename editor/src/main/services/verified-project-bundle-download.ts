import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

const MAX_REMOTE_PROJECT_BYTES = 512 * 1024 * 1024;

/** Transport-only helper. Archive and Project admission belong to the
 * native importer or the explicitly isolated pre-cutover legacy importer. */
export async function downloadVerifiedProjectBundle(
  url: string,
  expectedSha256: string,
  destination: string,
): Promise<void> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Project download failed with HTTP ${response.status}.`);

  const finalUrl = new URL(response.url || url);
  if (finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password)
    throw new Error('Project download redirected to an unsupported URL.');

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_PROJECT_BYTES)
    throw new Error('Remote Project bundle exceeds the 512 MiB import limit.');

  const handle = await fs.open(destination, 'wx');
  const digest = createHash('sha256');
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REMOTE_PROJECT_BYTES) {
        await reader.cancel();
        throw new Error('Remote Project bundle exceeds the 512 MiB import limit.');
      }
      const bytes = Buffer.from(value);
      digest.update(bytes);
      await handle.write(bytes);
    }
  } finally {
    reader.releaseLock();
    await handle.close();
  }

  const actualSha256 = digest.digest('hex');
  if (actualSha256 !== expectedSha256.toLocaleLowerCase('en-US'))
    throw new Error('Remote Project bundle SHA-256 does not match the expected digest.');
}
