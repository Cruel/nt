import type { NovelTeaCliDiagnostic } from './contracts';
import { cliDiagnostic } from './contracts';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace';

export interface PinnedExternalAssetExpectation {
  readonly path: string;
  readonly sourceIdentity?: string;
  readonly byteSize?: number;
  readonly mtimeNanoseconds?: string | null;
  readonly contentHash?: string | null;
}

function normalizedHash(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}

export async function verifyPinnedExternalAssets(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  expectations: readonly PinnedExternalAssetExpectation[],
): Promise<readonly NovelTeaCliDiagnostic[]> {
  const diagnostics: NovelTeaCliDiagnostic[] = [];
  for (const expected of expectations) {
    const absolute = fileSystem.joinPath(projectRoot, expected.path);
    const metadata = await fileSystem.readPathMetadata?.(absolute);
    if (!metadata || metadata.kind !== 'file') {
      diagnostics.push(
        cliDiagnostic(
          'export.pinned_input_changed',
          `/assets/${expected.path}`,
          `Pinned external Asset '${expected.path}' is no longer the same regular file.`,
        ),
      );
      continue;
    }
    const metadataMatches =
      (expected.sourceIdentity === undefined ||
        metadata.sourceIdentity === expected.sourceIdentity) &&
      (expected.byteSize === undefined || metadata.byteSize === expected.byteSize) &&
      (expected.mtimeNanoseconds == null ||
        metadata.mtimeNanoseconds === expected.mtimeNanoseconds);
    if (!metadataMatches) {
      diagnostics.push(
        cliDiagnostic(
          'export.pinned_input_changed',
          `/assets/${expected.path}`,
          `Pinned external Asset '${expected.path}' changed while export work was running.`,
        ),
      );
      continue;
    }
    if (expected.mtimeNanoseconds == null && expected.contentHash) {
      const revision = await fileSystem.readFileRevision(absolute);
      if (normalizedHash(revision.contentHash) !== normalizedHash(expected.contentHash))
        diagnostics.push(
          cliDiagnostic(
            'export.pinned_input_changed',
            `/assets/${expected.path}`,
            `Pinned external Asset '${expected.path}' changed while export work was running.`,
          ),
        );
    }
  }
  return diagnostics;
}
