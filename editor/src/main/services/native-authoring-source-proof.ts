import { createHash } from 'node:crypto';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';

export function nativeAssetContentHashes(project: AuthoringProject): Map<string, string> {
  return new Map(
    Object.values(project.assets).flatMap((record) =>
      record.data.contentHash ? [[record.data.source.path, record.data.contentHash] as const] : [],
    ),
  );
}

/** Native authority hashes text sources with XXH3-128, but intentionally
 * observes potentially huge binary files as physical:size:file-clock-ns.
 * The native complete-preparation pass has already rechecked its own physical
 * source baseline. The host additionally checks byte length and each admitted
 * Asset content hash before publishing preview/export/saved source consumers.
 */
export function verifyNativeSourceBytes(
  relative: string,
  revision: string,
  bytes: Uint8Array,
  assetHashes: ReadonlyMap<string, string>,
  sourceRevision?: (bytes: Uint8Array) => string,
): void {
  const sha256 = () => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const physical = /^physical:(\d+):(-?\d+)$/u.exec(revision);
  if (physical) {
    if (BigInt(bytes.byteLength) !== BigInt(physical[1]!))
      throw new Error(`Native source size changed since admission: ${relative}`);
    const trackedHash = assetHashes.get(relative);
    if (trackedHash && sha256() !== trackedHash)
      throw new Error(`Native Asset content hash does not match admitted Project: ${relative}`);
  } else if (
    (/^sha256:[a-f0-9]{64}$/u.test(revision) && sha256() !== revision) ||
    (/^xxh3-128:[a-f0-9]{32}$/u.test(revision) &&
      (!sourceRevision || sourceRevision(bytes) !== revision)) ||
    !/^(?:sha256:[a-f0-9]{64}|xxh3-128:[a-f0-9]{32})$/u.test(revision)
  ) {
    throw new Error(`Native export source changed since admission: ${relative}`);
  }
}
