import path from 'node:path';
import { NodeProjectWorkspaceFileSystem } from '../../shared/project-workspace/node-project-workspace-file-system';
import type { ProjectSourceExpectedRevision } from '../../shared/project-source-files';
import { assertProjectWorkspacePathContained } from '../../shared/project-workspace/project-workspace-file-system';

export async function readProjectAssetFileRevision(
  projectRoot: string,
  projectRelativePath: string,
): Promise<ProjectSourceExpectedRevision> {
  const fileSystem = new NodeProjectWorkspaceFileSystem();
  const absolute = path.resolve(projectRoot, projectRelativePath);
  await assertProjectWorkspacePathContained(fileSystem, projectRoot, absolute);
  try {
    return (await fileSystem.readFileRevision(absolute)).contentHash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}
