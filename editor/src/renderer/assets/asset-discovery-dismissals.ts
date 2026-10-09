import type { ProjectAssetAuditFile } from '../../shared/project-asset-audit';

const STORAGE_PREFIX = 'noveltea:asset-discovery-dismissals:v1:';

type Dismissal = { path: string; revision: string };

function load(projectFilePath: string): Dismissal[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${projectFilePath}`);
    if (!raw) return [];
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    return values.filter(
      (value): value is Dismissal =>
        value !== null &&
        typeof value === 'object' &&
        typeof value.path === 'string' &&
        typeof value.revision === 'string',
    );
  } catch {
    return [];
  }
}

export function undisclosedAssetCandidates(
  projectFilePath: string,
  files: ProjectAssetAuditFile[],
): ProjectAssetAuditFile[] {
  const seen = new Map(load(projectFilePath).map((value) => [value.path, value.revision]));
  return files.filter(
    (file) => file.importable && seen.get(file.projectRelativePath) !== file.revision,
  );
}

export function dismissAssetCandidates(
  projectFilePath: string,
  files: ProjectAssetAuditFile[],
): void {
  const revisions = new Map(load(projectFilePath).map((value) => [value.path, value.revision]));
  for (const file of files) revisions.set(file.projectRelativePath, file.revision);
  try {
    localStorage.setItem(
      `${STORAGE_PREFIX}${projectFilePath}`,
      JSON.stringify([...revisions].map(([path, revision]) => ({ path, revision }))),
    );
  } catch {
    // Disabled/quota-constrained storage still permits one-session discovery.
  }
}
