import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveNovelTeaCliPath } from '../../shared/noveltea-cli-subprocess';
import {
  NativeAuthoringSessionBridge,
  type NativeAuthoringSessionOptions,
} from './native-authoring-session-bridge';
import {
  NativeAuthoringWorkingProject,
  patchOwner,
  type NativeDirtyCheckpoint,
} from './native-authoring-working-project';
import type { ToolDiagnostic } from '../../shared/editor-tooling';

interface WorkingValidationInput {
  sourceRoot: string;
  worker: Pick<NativeAuthoringSessionOptions, 'addonPath' | 'workerScript'>;
  checkpoint: NativeDirtyCheckpoint;
}

interface NativeCliValidation {
  success: boolean;
  diagnostics: ToolDiagnostic[];
  exitCode: number;
}

async function runNativeValidation(projectRoot: string): Promise<NativeCliValidation> {
  const executable = resolveNovelTeaCliPath();
  const args = ['--no-daemon', '--json', '--project', projectRoot, 'validate'];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.on('error', reject);
    child.on('close', () => {
      try {
        if (!stdout || stdout.length > 16 * 1024 * 1024)
          throw new Error('Native validation returned an oversized or empty response. ' + stderr);
        resolve(stdout);
      } catch (error) {
        reject(error);
      }
    });
  });
  const result = JSON.parse(output) as NativeCliValidation;
  if (typeof result.success !== 'boolean' || !Array.isArray(result.diagnostics))
    throw new Error('Native working validation returned an invalid CLI result.');
  return {
    ...result,
    diagnostics: result.diagnostics.map((diagnostic) => {
      const location = diagnostic as typeof diagnostic & { sourceUrl?: string };
      // Shaderc reports absolute paths inside the disposable Project. These
      // are physical source identities, not JSON pointers or source URLs.
      const physicalRelative = path.isAbsolute(diagnostic.path)
        ? path.relative(projectRoot, diagnostic.path).split(path.sep).join('/')
        : '';
      const physicalSource =
        physicalRelative && !physicalRelative.startsWith('..') && !path.isAbsolute(physicalRelative)
          ? physicalRelative
          : null;
      const source =
        physicalSource ??
        diagnostic.sourcePath ??
        (location.sourceUrl?.startsWith('project:/')
          ? location.sourceUrl.slice('project:/'.length)
          : undefined);
      const relative =
        source && path.isAbsolute(source)
          ? path.relative(projectRoot, source).split(path.sep).join('/')
          : source;
      const sourcePath =
        relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : undefined;
      return {
        ...diagnostic,
        ...(physicalSource ? { path: `/${physicalSource}` } : {}),
        message: diagnostic.message.replaceAll(projectRoot + path.sep, 'project:/'),
        ...(sourcePath ? { sourcePath } : {}),
      };
    }),
  };
}

/**
 * Exact native stage parity for the editor working generation. Nothing is
 * written to the user's Project: a disposable physical workspace is replayed
 * and saved by the same native authoring worker before the direct C++ CLI
 * checks shaderc, font coverage, distribution notices and portable sources.
 * The caller must fence the original source generation before/after this call.
 */
export async function validateNativeWorkingStages(
  input: WorkingValidationInput,
): Promise<NativeCliValidation> {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'noveltea-native-working-validation-'));
  const root = path.join(sandbox, 'project');
  const sessionId = 'native-validation-shadow';
  const authority = {
    requireActiveProjectRoot: (id: string) => {
      if (id !== sessionId) throw new Error('Invalid native validation shadow identity.');
      return root;
    },
    isCurrent: (id: string) => id === sessionId,
  };
  const bridge = new NativeAuthoringSessionBridge(authority, {
    ...input.worker,
    pollIntervalMs: 0,
  });
  const working = new NativeAuthoringWorkingProject(bridge);
  try {
    await cp(input.sourceRoot, root, {
      recursive: true,
      force: false,
      errorOnExist: true,
      // Use copy-on-write clones where the filesystem supports them, while
      // keeping validation writes isolated on ordinary filesystems as well.
      mode: constants.COPYFILE_FICLONE,
      filter: async (entry) => {
        const relative = path.relative(input.sourceRoot, entry);
        if (!relative) return true;
        const segments = relative.split(path.sep);
        const recoveryTrash =
          segments[0] === '.noveltea' &&
          (segments.length === 1 ||
            (segments[1] === 'trash' &&
              (segments.length === 2 || ['assets', 'layouts'].includes(segments[2]!))));
        if (
          segments.includes('.git') ||
          (segments.includes('.noveltea') && !recoveryTrash) ||
          ['node_modules', 'build', 'dist', '.cache'].includes(segments[0]!)
        )
          return false;
        const stat = await lstat(entry);
        if (stat.isSymbolicLink())
          throw new Error('Native validation source contains a symbolic link: ' + relative);
        return stat.isDirectory() || stat.isFile();
      },
    });
    await working.open(sessionId);
    if (input.checkpoint.batches.length || Object.keys(input.checkpoint.textSources).length)
      await working.restoreDirtyCheckpoint(sessionId, input.checkpoint);
    const snapshot = working.snapshot();
    if (!snapshot) throw new Error('Native shadow Project did not open.');
    const owners = [
      ...(snapshot.dirty ? ['project'] : []),
      ...Object.entries(snapshot.recordSnapshots ?? {})
        .filter(([, value]) => value.dirty)
        .map(([owner]) => owner),
      ...input.checkpoint.batches.flatMap((batch) =>
        batch.patches.map((patch) => patchOwner(patch.path)),
      ),
    ];
    const textPaths = Object.keys(input.checkpoint.textSources);
    const textContents = Object.fromEntries(
      Object.entries(input.checkpoint.textSources).map(([relative, value]) => [
        relative,
        value.text,
      ]),
    );
    if (owners.length || textPaths.length) {
      const saved = await working.saveOwners([...new Set(owners)].sort(), {
        textPaths,
        textContents,
      });
      if (!saved.accepted)
        throw new Error('Native shadow generation could not be materialized: ' + saved.error);
    }
    return await runNativeValidation(root);
  } finally {
    bridge.close();
    await rm(sandbox, { recursive: true, force: true });
  }
}
