import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeProjectWorkspaceFileSystem } from '../../shared/project-workspace/node-project-workspace-file-system';
import { createNodeProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';
import type {
  CompleteDesktopProjectImportRequest,
  DesktopProjectImportResult,
} from '../../shared/project-import-handoff';
import {
  importPortableProjectBundle,
  PortableProjectBundleError,
} from './portable-project-bundle-service';
import { downloadVerifiedProjectBundle } from './verified-project-bundle-download';
export { importNativeDesktopProject } from './native-desktop-project-import-service';

export async function importDesktopProject(
  input: CompleteDesktopProjectImportRequest,
): Promise<DesktopProjectImportResult> {
  const fileSystem = createNodeProjectWorkspaceFileSystem();
  const workspace = createNodeProjectWorkspaceService();
  let temporaryRoot: string | null = null;

  try {
    let bundlePath: string;
    if (input.request.source.kind === 'local') {
      bundlePath = input.request.source.bundlePath;
    } else {
      temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noveltea-project-import-'));
      bundlePath = path.join(temporaryRoot, 'download.ntproject');
      await downloadVerifiedProjectBundle(
        input.request.source.url,
        input.request.source.sha256,
        bundlePath,
      );
    }

    const imported = await importPortableProjectBundle(
      fileSystem,
      workspace,
      bundlePath,
      input.destination,
      { projectName: input.projectName },
    );
    return {
      success: true,
      projectPath: imported.projectRoot,
      projectFilePath: imported.projectFilePath,
    };
  } catch (error) {
    const message =
      error instanceof PortableProjectBundleError || error instanceof Error
        ? error.message
        : String(error);
    return { success: false, error: message };
  } finally {
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
