import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  isSafeProjectAssetPath,
  isSafeProjectAttachmentPath,
} from '../../shared/project-schema/authoring-assets';

interface StagedAsset {
  projectRelativePath: string;
  stagedRelativePath: string;
  sourceRevision: string;
}

/** Only main-owned picker results can create a publication claim. The renderer
 * selects identities but never supplies a source path or file bytes to Save. */
export class NativeAssetStagingService {
  private readonly staged = new Map<string, StagedAsset>();
  private readonly staging = new Set<string>();
  private readonly root: string;
  private closed = false;

  constructor(
    projectRoot: string,
    private readonly sourceRevisionFor?: (bytes: Uint8Array) => string,
  ) {
    this.root = path.resolve(projectRoot);
  }

  async stage(projectRelativePath: string, bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('Native Asset staging session has closed.');
    if (
      !(projectRelativePath.startsWith('assets/') && isSafeProjectAssetPath(projectRelativePath)) &&
      !(
        projectRelativePath.startsWith('support/') &&
        isSafeProjectAttachmentPath(projectRelativePath)
      )
    )
      throw new Error('Unsafe native Asset publication path.');
    if (this.staged.has(projectRelativePath) || this.staging.has(projectRelativePath))
      throw new Error(`Asset publication is already pending: ${projectRelativePath}`);
    this.staging.add(projectRelativePath);
    try {
      const stateRoot = path.join(this.root, '.noveltea');
      await mkdir(stateRoot, { recursive: true });
      if ((await lstat(stateRoot)).isSymbolicLink())
        throw new Error('Native Project state directory is a symbolic link.');
      const directory = path.join(stateRoot, 'native-asset-import');
      await mkdir(directory, { recursive: true });
      if ((await lstat(directory)).isSymbolicLink())
        throw new Error('Native Asset staging directory is a symbolic link.');
      const stagedRelativePath = `.noveltea/native-asset-import/${randomUUID()}`;
      const sourceRevision = this.sourceRevisionFor
        ? this.sourceRevisionFor(bytes)
        : `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      await writeFile(path.join(this.root, stagedRelativePath), bytes, { flag: 'wx' });
      if (this.closed) {
        await rm(path.join(this.root, stagedRelativePath), { force: true });
        throw new Error('Native Asset staging session closed during import.');
      }
      this.staged.set(projectRelativePath, {
        projectRelativePath,
        stagedRelativePath,
        sourceRevision,
      });
    } finally {
      this.staging.delete(projectRelativePath);
    }
  }

  publication(paths: readonly string[]): { kind: 'publish'; files: StagedAsset[] } {
    if (!paths.length || new Set(paths).size !== paths.length)
      throw new Error('Invalid native Asset publication selection.');
    return {
      kind: 'publish',
      files: paths.map((path) => {
        const file = this.staged.get(path);
        if (!file) throw new Error(`Asset was not staged by this Project session: ${path}`);
        return file;
      }),
    };
  }

  committed(paths: readonly string[]): void {
    for (const path of paths) this.staged.delete(path);
  }

  hasAll(paths: readonly string[]): boolean {
    return paths.length > 0 && paths.every((candidate) => this.staged.has(candidate));
  }

  /** Only uncommitted staging files may be removed here. Published bytes must
   * pass through a native journaled trash/restore transaction. */
  async discard(paths: readonly string[]): Promise<void> {
    if (!this.hasAll(paths) || new Set(paths).size !== paths.length)
      throw new Error('Native Asset staging cleanup refers to an unknown publication.');
    for (const relative of paths) {
      const file = this.staged.get(relative)!;
      await rm(path.join(this.root, file.stagedRelativePath), { force: true });
      this.staged.delete(relative);
    }
  }

  close(): void {
    this.closed = true;
    for (const file of this.staged.values()) {
      void rm(path.join(this.root, file.stagedRelativePath), { force: true }).catch(
        () => undefined,
      );
    }
    this.staged.clear();
  }
}
