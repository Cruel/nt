export type CandidateFormatRisk = 'current' | 'older' | 'newer' | 'unknown';

export function candidateFormatRisk(manifest: string | undefined): CandidateFormatRisk {
  if (manifest === undefined) return 'unknown';
  // An unambiguous top-level scalar is still readable when other YAML is broken.
  const versions = [...manifest.matchAll(/^schemaVersion:\s*([0-9]+)\s*(?:#.*)?$/gmu)];
  if (versions.length !== 1) return 'unknown';
  const version = Number(versions[0]![1]);
  if (!Number.isSafeInteger(version)) return 'unknown';
  if (version > 1) return 'newer';
  if (version < 1) return 'older';
  return 'current';
}
