import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import { projectWorkspaceFiles } from '../../shared/project-workspace/project-workspace-service';
import { PROJECT_WORKSPACE_ABSENT_REVISION } from '../../shared/project-workspace/project-workspace-transaction';
import type { ActiveProjectWorkspaceSession } from './active-project-workspace-session';

/**
 * An external Asset-byte update can confirm a newer Authoring Source for that Asset alone.
 * Persist the association alongside the normal record, using exactly the same CAS transaction
 * and session lane as other project mutations; never modify another Asset sharing the source.
 */
export async function advanceExternallyUpdatedAssetSourceBaselines(
  session: ActiveProjectWorkspaceSession,
  assetFileRevisions: Readonly<Record<string, `sha256:${string}` | 'absent'>>,
  isCurrentSession: () => boolean = () => true,
): Promise<string[]> {
  return session.runExclusive(async () => {
    if (!isCurrentSession()) return [];
    const snapshot = session.snapshot();
    const candidate = structuredClone(snapshot.project);
    const sourceRevisions = new Map<string, `sha256:${string}` | 'absent'>();
    const revisedAssetPaths = new Map<string, `sha256:${string}`>();

    for (const record of Object.values(candidate.assets)) {
      const data = parseAssetData(record.data);
      if (!data || data.source.type !== 'project-file') continue;
      const revision = assetFileRevisions[data.source.path];
      if (!revision || revision === 'absent') continue;
      if (
        !data.attachments.some(
          (attachment) =>
            attachment.purpose === 'authoring-source' &&
            attachment.sourceBaselineHash &&
            (attachment.assetBaselineHash ?? data.contentHash) &&
            (attachment.assetBaselineHash ?? data.contentHash) !== revision,
        )
      )
        continue;

      // A raw external editor may write while the watcher is evaluating the revision.
      // Do not acknowledge an Asset unless the exact observed bytes are still on disk.
      if ((await session.readFreshRevision(data.source.path)) !== revision) return [];
      revisedAssetPaths.set(data.source.path, revision);
      const next = [];
      for (const attachment of data.attachments) {
        if (
          attachment.purpose !== 'authoring-source' ||
          !attachment.sourceBaselineHash ||
          !(attachment.assetBaselineHash ?? data.contentHash) ||
          (attachment.assetBaselineHash ?? data.contentHash) === revision
        ) {
          next.push(attachment);
          continue;
        }
        let sourceRevision = sourceRevisions.get(attachment.path);
        if (!sourceRevision) {
          sourceRevision = await session.readFreshRevision(attachment.path);
          sourceRevisions.set(attachment.path, sourceRevision);
        }
        next.push({
          ...attachment,
          assetBaselineHash: revision,
          ...(sourceRevision !== 'absent' ? { sourceBaselineHash: sourceRevision } : {}),
        });
      }
      record.data = { ...record.data, attachments: next };
    }

    if (revisedAssetPaths.size === 0) return [];
    // Recheck sources as well: a source modified during the confirmation cannot become
    // the baseline of an Asset that was produced from the previous revision.
    for (const [sourcePath, revision] of sourceRevisions) {
      if ((await session.readFreshRevision(sourcePath)) !== revision) return [];
    }
    if (!isCurrentSession()) return [];

    const before = projectWorkspaceFiles(
      snapshot.project,
      snapshot.project.editor,
      snapshot.scriptSourcePaths,
    );
    const after = projectWorkspaceFiles(candidate, candidate.editor, snapshot.scriptSourcePaths);
    const targetFiles = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((file) => before[file] !== after[file])
      .sort();
    if (targetFiles.length === 0) return [];
    const expectedFileRevisions = Object.fromEntries(
      targetFiles.map((file) => [
        file,
        snapshot.fileRevisions[file]?.contentHash ?? PROJECT_WORKSPACE_ABSENT_REVISION,
      ]),
    );
    const written = await session
      .service()
      .write(
        snapshot.projectRoot,
        snapshot.workspaceRevision,
        candidate,
        session.editorState(),
        snapshot.scriptSourcePaths,
        {
          expectedFileRevisions,
          targetFiles,
          operationLabel: 'confirm updated Asset Authoring Sources',
          preflightSnapshot: snapshot,
        },
      );
    session.adopt(written.snapshot, session.editorState());
    return targetFiles;
  });
}
