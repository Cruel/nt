import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CompleteDesktopProjectImportRequest,
  DesktopProjectImportResult,
} from '../../shared/project-import-handoff';
import { invokeNovelTeaNativeOperation } from '../../shared/noveltea-cli-subprocess';
import { downloadVerifiedProjectBundle } from './verified-project-bundle-download';

/** Native Project import never constructs a TypeScript Workspace or writer.
 * The native filesystem transaction admits the archive before publishing it. */
export async function importNativeDesktopProject(
  input: CompleteDesktopProjectImportRequest,
  invoke: typeof invokeNovelTeaNativeOperation = invokeNovelTeaNativeOperation,
): Promise<DesktopProjectImportResult> {
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
    const destination = path.resolve(input.destination);
    const raw = await invoke('native-project-commands', {
      action: 'project-import',
      bundlePath: path.resolve(bundlePath),
      destination,
      projectName: input.projectName,
    });
    if (!raw || typeof raw !== 'object' || !('ok' in raw) || raw.ok !== true) {
      const failure = raw as { error?: unknown } | null;
      throw new Error(
        typeof failure?.error === 'string' ? failure.error : 'Native Project import failed.',
      );
    }
    if (
      !('projectRoot' in raw) ||
      raw.projectRoot !== destination ||
      !('projectFilePath' in raw) ||
      raw.projectFilePath !== path.join(destination, 'project.yaml')
    )
      throw new Error('Native Project import returned an invalid destination.');
    return { success: true, projectPath: destination, projectFilePath: raw.projectFilePath };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
