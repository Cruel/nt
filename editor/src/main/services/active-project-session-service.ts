import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  isSafeProjectAssetPath,
  parseAssetData,
  type AssetKind,
} from '../../shared/project-schema/authoring-assets';
import {
  parseAuthoringProject,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { editorProjectStateSchema } from '../../shared/project-schema/editor-project-state';
import {
  isSha256Digest,
  PROJECT_TEXT_SOURCE_LIMITS,
  projectTextSourceBoundaryCode,
  type ProjectTextSourceReadEntry,
  type ReadProjectTextSourcesRequest,
  type ReadProjectTextSourcesResponse,
} from '../../shared/project-text-sources';
import type {
  ListProjectSourceFilesRequest,
  ListProjectSourceFilesResponse,
  ProjectSourceFile,
  ProjectSourceStructuralRequest,
  ProjectSourceStructuralResponse,
  ProjectSourceUsageRequest,
  ProjectSourceUsageResponse,
  ProjectSourceWriteRequest,
  ProjectSourceWriteResponse,
} from '../../shared/project-source-files';
import type { LoadedProjectWorkspaceSnapshot } from '../../shared/project-workspace/project-workspace-service';
import type { ActiveProjectWorkspaceSession } from './active-project-workspace-session';

const decoder = new TextDecoder('utf-8', { fatal: true });
const readOnlyNoFollowFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

class TextSourceReadFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ActiveProjectAssetAuthorization {
  assetId: string;
  kind: AssetKind;
  sourcePath: string;
  byteSize?: number;
  contentHash?: string;
}

interface ActiveProjectSession {
  id: string;
  root: string;
  projectIdentity: { id: string; name: string } | null;
  assets: ReadonlyMap<string, ActiveProjectAssetAuthorization>;
  nativeLayoutIds?: ReadonlySet<string>;
  workspace?: ActiveProjectWorkspaceSession;
}

interface StagedNativeProjectSession {
  session: ActiveProjectSession;
  generation: number;
  previousActiveSessionId: string | null;
}

function admittedAssets(project: unknown): ReadonlyMap<string, ActiveProjectAssetAuthorization> {
  return admittedAssetsFromProject(parseAuthoringProject(project));
}

/** The native Project worker already admitted the complete schema; extracting
 * Asset authorizations must not run another whole-Project TypeScript validator. */
function admittedAssetsFromProject(
  parsed: AuthoringProject,
): ReadonlyMap<string, ActiveProjectAssetAuthorization> {
  const assets = new Map<string, ActiveProjectAssetAuthorization>();
  for (const [assetId, record] of Object.entries(parsed.assets)) {
    const data = parseAssetData(record.data);
    if (data)
      assets.set(assetId, {
        assetId,
        kind: data.kind,
        sourcePath: data.source.path,
        byteSize: data.byteSize,
        contentHash: data.contentHash,
      });
  }
  return assets;
}

export class ActiveProjectSessionService {
  private active: ActiveProjectSession | null = null;
  private stagedNative: StagedNativeProjectSession | null = null;
  private projectActivationGeneration = 0;

  beginProjectActivation(): number {
    this.projectActivationGeneration += 1;
    this.stagedNative = null;
    return this.projectActivationGeneration;
  }

  /** Distinguish a superseded in-flight open from an active Project that has
   * not yet been replaced by the newer open. The older opener must not close
   * the newer user's session merely because its native admission failed. */
  isProjectActivationCurrent(generation: number): boolean {
    return generation === this.projectActivationGeneration;
  }

  async activateProjectFile(
    projectFilePath: string,
    expectedActivationGeneration?: number,
    contentProject?: unknown,
    workspace?: ActiveProjectWorkspaceSession,
  ): Promise<string> {
    const canonicalProjectFile = await fs.realpath(path.resolve(projectFilePath));
    const projectFileStat = await fs.stat(canonicalProjectFile);
    if (!projectFileStat.isFile()) throw new Error('Project manifest is not a regular file.');
    this.assertProjectActivationCurrent(expectedActivationGeneration);
    this.stagedNative = null;
    const canonicalRoot = path.dirname(canonicalProjectFile);
    const parsedProject =
      contentProject === undefined ? null : parseAuthoringProject(contentProject);
    const assets = parsedProject === null ? new Map() : admittedAssets(parsedProject);
    const workspaceProject = workspace?.project().project;
    const identityProject = parsedProject?.project ?? workspaceProject;
    const projectIdentity = identityProject
      ? { id: identityProject.id, name: identityProject.name }
      : null;
    const current = this.active;
    if (current?.root === canonicalRoot) {
      this.active = {
        ...current,
        projectIdentity: projectIdentity ?? current.projectIdentity,
        assets,
        workspace: workspace ?? current.workspace,
      };
      return current.id;
    }
    const id = randomUUID();
    this.active = {
      id,
      root: canonicalRoot,
      projectIdentity,
      assets,
      ...(workspace ? { workspace } : {}),
    };
    return id;
  }

  /** Make an untrusted candidate root visible only to its private native
   * admission worker. The incumbent (including unsaved working state and
   * original worker) retains authority until a completed native admission
   * is atomically promoted. Never share this staged ID with the renderer. */
  async stageNativeProjectFile(
    projectFilePath: string,
    expectedActivationGeneration: number,
  ): Promise<string> {
    const manifest = await fs.realpath(path.resolve(projectFilePath));
    const stats = await fs.stat(manifest);
    if (!stats.isFile() || path.basename(manifest) !== 'project.yaml')
      throw new Error('Native Project staging requires an ordinary project.yaml manifest.');
    this.assertProjectActivationCurrent(expectedActivationGeneration);
    const root = path.dirname(manifest);
    // Reopening the same root admits an independent candidate against the
    // durable dirty checkpoint. The incumbent remains usable until commit;
    // an invalid or conflicted recovery cannot discard its unsaved state.
    const id = randomUUID();
    this.stagedNative = {
      session: { id, root, projectIdentity: null, assets: new Map() },
      generation: expectedActivationGeneration,
      previousActiveSessionId: this.active?.id ?? null,
    };
    return id;
  }

  commitStagedNativeProject(projectSessionId: string, expectedActivationGeneration: number): void {
    const candidate = this.stagedNative;
    this.assertProjectActivationCurrent(expectedActivationGeneration);
    if (
      !candidate ||
      candidate.session.id !== projectSessionId ||
      candidate.generation !== expectedActivationGeneration ||
      candidate.previousActiveSessionId !== (this.active?.id ?? null) ||
      !candidate.session.projectIdentity
    )
      throw new Error('Native Project candidate is not admitted or was superseded.');
    this.active = candidate.session;
    this.stagedNative = null;
  }

  discardStagedNativeProject(projectSessionId: string): void {
    if (this.stagedNative?.session.id === projectSessionId) this.stagedNative = null;
  }

  currentSessionId(): string | null {
    return this.active?.id ?? null;
  }

  currentProjectRoot(): string | null {
    return this.active?.root ?? null;
  }

  currentProjectIdentity(): { id: string; name: string } | null {
    const active = this.active;
    if (!active) return null;
    const workspaceProject = active.workspace?.project().project;
    const identity =
      active.projectIdentity ??
      (workspaceProject ? { id: workspaceProject.id, name: workspaceProject.name } : null);
    return identity ? { ...identity } : null;
  }

  requireActiveProjectRoot(projectSessionId: string): string {
    const active =
      this.active?.id === projectSessionId
        ? this.active
        : this.stagedNative?.session.id === projectSessionId
          ? this.stagedNative.session
          : null;
    if (!active || projectSessionId !== active.id) {
      throw new Error('Project session is stale or unknown.');
    }
    return active.root;
  }

  isCurrent(projectSessionId: string): boolean {
    return (
      this.active?.id === projectSessionId || this.stagedNative?.session.id === projectSessionId
    );
  }

  requireActiveWorkspace(projectSessionId: string): ActiveProjectWorkspaceSession {
    const active = this.active;
    if (!active || projectSessionId !== active.id)
      throw new Error('Project session is stale or unknown.');
    if (!active.workspace) throw new Error('Active Project session has no workspace state.');
    return active.workspace;
  }

  refreshActiveWorkspaceAssets(projectSessionId: string): void {
    const active = this.active;
    if (!active || projectSessionId !== active.id)
      throw new Error('Project session is stale or unknown.');
    if (!active.workspace) throw new Error('Active Project session has no workspace state.');
    this.active = { ...active, assets: admittedAssets(active.workspace.project()) };
  }

  requireActiveAsset(
    projectSessionId: string,
    assetId: string,
  ): { root: string; asset: ActiveProjectAssetAuthorization } {
    const active = this.active;
    if (!active || projectSessionId !== active.id) {
      throw new Error('Project session is stale or unknown.');
    }
    const asset = active.assets.get(assetId);
    if (!asset) throw new Error('Asset is not admitted by the active Project session.');
    return { root: active.root, asset };
  }

  async refreshActiveProject(
    projectSessionId: string,
    projectFilePath: string,
    contentProject?: unknown,
  ): Promise<string> {
    const active = this.active;
    if (!active || projectSessionId !== active.id) {
      throw new Error('Project session is stale or unknown.');
    }
    const canonicalProjectFile = await fs.realpath(path.resolve(projectFilePath));
    const projectFileStat = await fs.stat(canonicalProjectFile);
    if (!projectFileStat.isFile()) throw new Error('Project manifest is not a regular file.');
    const canonicalRoot = path.dirname(canonicalProjectFile);
    if (canonicalRoot !== active.root) {
      throw new Error('Project result does not belong to the active Project session.');
    }
    const parsedProject =
      contentProject === undefined ? null : parseAuthoringProject(contentProject);
    const assets = parsedProject === null ? active.assets : admittedAssets(parsedProject);
    if (this.active !== active) throw new Error('Project session is stale or unknown.');
    if (parsedProject !== null) {
      this.active = {
        ...active,
        assets,
        projectIdentity: { id: parsedProject.project.id, name: parsedProject.project.name },
      };
    }
    return active.id;
  }

  /** Publish a complete native-admitted Project identity and Asset capability
   * set, without falling back to TypeScript workspace admission. */
  async acceptNativeProject(
    projectSessionId: string,
    nativeProject: AuthoringProject,
  ): Promise<void> {
    const staged = this.stagedNative?.session.id === projectSessionId;
    const active = staged ? this.stagedNative!.session : this.active;
    if (!active || active.id !== projectSessionId)
      throw new Error('Project session is stale or unknown.');
    const assets = admittedAssetsFromProject(nativeProject);
    if ((staged ? this.stagedNative?.session : this.active) !== active)
      throw new Error('Project session changed during native Asset authorization.');
    const accepted = {
      ...active,
      assets,
      nativeLayoutIds: new Set(Object.keys(nativeProject.layouts)),
      projectIdentity: { id: nativeProject.project.id, name: nativeProject.project.name },
    };
    if (staged) this.stagedNative = { ...this.stagedNative!, session: accepted };
    else this.active = accepted;
  }

  async attachToSuccessfulResult<
    Result extends { ok?: boolean; success?: boolean; projectFilePath?: string },
  >(result: Result, activationGeneration: number): Promise<Result & { projectSessionId?: string }> {
    if (result.success !== true || result.ok === false) return result;
    if (!result.projectFilePath) {
      throw new Error('Successful Project lifecycle result omitted the Project manifest path.');
    }
    // This branch is only used by the pre-cutover legacy editor. Native
    // admission calls stage/commit directly and never imports a TS Workspace.
    const { ActiveProjectWorkspaceSession } = await import('./active-project-workspace-session');
    const raw = result as Record<string, unknown>;
    const parsedEditor = editorProjectStateSchema.safeParse(raw.editorState);
    const snapshot = raw._workspaceSnapshot as LoadedProjectWorkspaceSnapshot | undefined;
    let workspace =
      parsedEditor.success && snapshot
        ? ActiveProjectWorkspaceSession.fromSnapshot(snapshot, parsedEditor.data)
        : undefined;
    if (!workspace) {
      const { createNodeProjectWorkspaceService } =
        await import('../../shared/project-workspace/node-project-workspace-service');
      const root = path.dirname(path.resolve(result.projectFilePath));
      const opened = await createNodeProjectWorkspaceService().open(root);
      if (!opened.ok)
        throw new Error(opened.diagnostics[0]?.message ?? 'Project workspace is invalid.');
      workspace = ActiveProjectWorkspaceSession.fromOpened(opened);
    }
    const projectSessionId = await this.activateProjectFile(
      result.projectFilePath,
      activationGeneration,
      'contentProject' in result ? result.contentProject : undefined,
      workspace,
    );
    this.assertProjectActivationCurrent(activationGeneration);
    const { _workspaceSnapshot: _privateWorkspaceSnapshot, ...publicResult } = raw;
    return { ...publicResult, projectSessionId } as Result & { projectSessionId?: string };
  }

  async refreshSuccessfulSessionResult<
    Result extends { ok?: boolean; success?: boolean; projectFilePath?: string },
  >(projectSessionId: string, result: Result): Promise<Result & { projectSessionId?: string }> {
    if (result.success !== true || result.ok === false) return result;
    if (!result.projectFilePath) {
      throw new Error('Successful Project persistence result omitted the Project manifest path.');
    }
    await this.refreshActiveProject(
      projectSessionId,
      result.projectFilePath,
      'contentProject' in result ? result.contentProject : undefined,
    );
    return { ...result, projectSessionId };
  }

  closeActiveProject(): void {
    this.projectActivationGeneration += 1;
    this.active = null;
    this.stagedNative = null;
  }

  dispose(): void {
    this.closeActiveProject();
  }

  private assertProjectActivationCurrent(expectedActivationGeneration?: number): void {
    if (
      expectedActivationGeneration !== undefined &&
      expectedActivationGeneration !== this.projectActivationGeneration
    ) {
      throw new Error('Project activation was superseded.');
    }
  }

  async listProjectSourceFiles(
    request: ListProjectSourceFilesRequest,
  ): Promise<ListProjectSourceFilesResponse> {
    const active =
      this.active?.id === request.projectSessionId
        ? this.active
        : this.stagedNative?.session.id === request.projectSessionId
          ? this.stagedNative.session
          : null;
    if (!active || request.projectSessionId !== active.id) {
      throw new Error('Project session is stale or unknown.');
    }

    const files = new Map<string, ProjectSourceFile>();
    const folders = new Set<string>();
    const addTree = async (rootName: 'scripts' | 'shaders' | 'assets') => {
      const root = path.join(active.root, rootName);
      const visit = async (directory: string): Promise<void> => {
        let entries: import('node:fs').Dirent[];
        try {
          entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          const candidate = path.join(directory, entry.name);
          const real = await fs.realpath(candidate);
          const relativeReal = path.relative(active.root, real);
          if (relativeReal.startsWith('..') || path.isAbsolute(relativeReal)) continue;
          const stat = await fs.stat(real);
          if (stat.isDirectory()) {
            if (rootName !== 'assets')
              folders.add(path.relative(active.root, candidate).split(path.sep).join('/'));
            await visit(candidate);
            continue;
          }
          if (!stat.isFile()) continue;
          const projectRelativePath = path
            .relative(active.root, candidate)
            .split(path.sep)
            .join('/');
          if (rootName === 'scripts' && !projectRelativePath.endsWith('.lua')) continue;
          const kind = rootName === 'scripts' ? 'lua' : rootName === 'shaders' ? 'shader' : 'asset';
          files.set(projectRelativePath, {
            id: projectRelativePath,
            displayPath: projectRelativePath,
            projectRelativePath,
            kind,
            text: kind !== 'asset',
            ...(kind !== 'asset'
              ? {
                  contentHash: `sha256:${createHash('sha256')
                    .update(await fs.readFile(real))
                    .digest('hex')}` as const,
                }
              : {}),
          });
        }
      };
      await visit(root);
    };

    await Promise.all([addTree('scripts'), addTree('shaders'), addTree('assets')]);
    if (
      (this.active?.id === request.projectSessionId
        ? this.active
        : this.stagedNative?.session.id === request.projectSessionId
          ? this.stagedNative.session
          : null) !== active
    )
      throw new Error('Project session is stale or unknown.');

    for (const [assetId, asset] of active.assets) {
      const current = files.get(asset.sourcePath);
      if (!current) continue;
      files.set(asset.sourcePath, {
        ...current,
        assetIds: Object.freeze([...(current.assetIds ?? []), assetId].sort()),
      });
    }

    const snapshot = active.workspace?.snapshot();
    if (snapshot) {
      const canonical = new Set(snapshot.canonicalSourceFiles);
      for (const [layoutId] of Object.entries(snapshot.project.layouts)) {
        for (const channel of ['rml', 'rcss', 'lua'] as const) {
          const physicalPath = `records/layouts/${layoutId}/layout.${channel}`;
          if (!canonical.has(physicalPath)) continue;
          const displayPath = `layouts/${layoutId}/layout.${channel}`;
          files.set(displayPath, {
            id: displayPath,
            displayPath,
            projectRelativePath: physicalPath,
            kind: `layout-${channel}`,
            text: true,
            contentHash: snapshot.fileRevisions[physicalPath]?.contentHash,
            layout: { id: layoutId, channel },
          });
        }
      }
    }

    // The native candidate has no TypeScript Workspace snapshot. Derive
    // layout source identities only from native-admitted Layout records and
    // verify each physical file before exposing it to the source editor.
    if (active.nativeLayoutIds) {
      for (const layoutId of active.nativeLayoutIds) {
        for (const channel of ['rml', 'rcss', 'lua'] as const) {
          const relative = `records/layouts/${layoutId}/layout.${channel}`;
          const absolute = path.join(active.root, relative);
          let canonical: string;
          try {
            canonical = await fs.realpath(absolute);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          if (path.relative(active.root, canonical) !== relative.split('/').join(path.sep))
            throw new Error('Native Layout source identity escaped the active Project.');
          const stats = await fs.stat(canonical);
          if (!stats.isFile()) throw new Error('Native Layout source is not a regular file.');
          const displayPath = `layouts/${layoutId}/layout.${channel}`;
          files.set(displayPath, {
            id: displayPath,
            displayPath,
            projectRelativePath: relative,
            kind: `layout-${channel}`,
            text: true,
            contentHash: `sha256:${createHash('sha256')
              .update(await fs.readFile(canonical))
              .digest('hex')}`,
            layout: { id: layoutId, channel },
          });
        }
      }
    }

    return {
      files: Object.freeze(
        [...files.values()].sort((left, right) =>
          left.displayPath.localeCompare(right.displayPath),
        ),
      ),
      folders: Object.freeze([...folders].sort()),
    };
  }

  async projectSourceUsages(
    request: ProjectSourceUsageRequest,
  ): Promise<ProjectSourceUsageResponse> {
    const active = this.active;
    if (!active || request.projectSessionId !== active.id || !active.workspace)
      throw new Error('Project session is stale or unknown.');
    const { projectSourceUsages } = await import('./project-source-file-service');
    return {
      usages: await projectSourceUsages(active.root, active.workspace.snapshot(), request.path),
    };
  }

  async mutateProjectSources(
    request: ProjectSourceStructuralRequest,
  ): Promise<ProjectSourceStructuralResponse> {
    const workspace = this.requireActiveWorkspace(request.projectSessionId);
    const { mutateProjectSources } = await import('./project-source-file-service');
    const result = await mutateProjectSources(
      workspace,
      request.operation,
      request.expectedRevisions,
    );
    if (result.success) this.refreshActiveWorkspaceAssets(request.projectSessionId);
    return result;
  }

  async writeProjectSource(
    request: ProjectSourceWriteRequest,
  ): Promise<ProjectSourceWriteResponse> {
    const workspace = this.requireActiveWorkspace(request.projectSessionId);
    const { recreatableProjectSourcePhysicalPath, writeProjectSourceText } =
      await import('./project-source-file-service');
    const listed = await this.listProjectSourceFiles({
      projectSessionId: request.projectSessionId,
    });
    const source = listed.files.find((candidate) => candidate.id === request.sourceId);
    const physicalPath =
      source?.text === true
        ? source.projectRelativePath
        : request.expectedRevision === 'absent'
          ? recreatableProjectSourcePhysicalPath(workspace.project(), request.sourceId)
          : null;
    if (!physicalPath)
      return {
        ok: false,
        success: false,
        sourceId: request.sourceId,
        error: 'Source file is unavailable.',
      };
    return writeProjectSourceText(
      workspace,
      request.sourceId,
      physicalPath,
      request.expectedRevision,
      request.text,
    );
  }

  async read(request: ReadProjectTextSourcesRequest): Promise<ReadProjectTextSourcesResponse> {
    const entries = [...request.entries];
    const active = this.active;
    if (!active || request.projectSessionId !== active.id) {
      return staleSessionResponse(entries);
    }
    if (entries.length > PROJECT_TEXT_SOURCE_LIMITS.maxEntries) {
      return {
        entries: entries.map((entry) =>
          unavailable(entry, 'request-limit', 'Text source batch exceeds the entry limit.'),
        ),
      };
    }

    let aggregateBytes = 0;
    const results: ProjectTextSourceReadEntry[] = [];
    for (const entry of entries) {
      if (this.active !== active) return staleSessionResponse(entries);
      if (
        !entry.readKey ||
        (entry.expectedContentHash !== null && !isSha256Digest(entry.expectedContentHash))
      ) {
        results.push(unavailable(entry, 'invalid-request', 'Text source request is malformed.'));
        continue;
      }
      if (!isSafeProjectAssetPath(entry.projectRelativePath)) {
        results.push(
          unavailable(entry, 'unsafe-path', 'Project-relative text source path is unsafe.'),
        );
        continue;
      }
      try {
        const candidate = path.resolve(active.root, entry.projectRelativePath);
        const relative = path.relative(active.root, candidate);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          results.push(
            unavailable(entry, 'unsafe-path', 'Text source escapes the active Project root.'),
          );
          continue;
        }
        const realFile = await fs.realpath(candidate);
        if (this.active !== active) return staleSessionResponse(entries);
        const realRelative = path.relative(active.root, realFile);
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
          results.push(
            unavailable(
              entry,
              'symlink-escape',
              'Text source resolves outside the active Project root.',
            ),
          );
          continue;
        }
        const remainingAggregateBytes =
          PROJECT_TEXT_SOURCE_LIMITS.maxAggregateBytes - aggregateBytes;
        const opened = await openAndReadContainedFile(
          active.root,
          realFile,
          Math.min(PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes, remainingAggregateBytes),
        );
        if (this.active !== active) return staleSessionResponse(entries);
        if (!opened.isFile) {
          results.push(unavailable(entry, 'not-file', 'Text source is not a regular file.'));
          continue;
        }
        if (opened.size > PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes) {
          results.push(
            unavailable(entry, 'source-limit', 'Text source exceeds the per-source byte limit.'),
          );
          continue;
        }
        if (aggregateBytes + opened.size > PROJECT_TEXT_SOURCE_LIMITS.maxAggregateBytes) {
          results.push(
            unavailable(
              entry,
              'aggregate-limit',
              'Text source batch exceeds the aggregate byte limit.',
            ),
          );
          continue;
        }
        const bytes = opened.bytes;
        if (bytes.byteLength > PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes) {
          results.push(
            unavailable(entry, 'source-limit', 'Text source exceeds the per-source byte limit.'),
          );
          continue;
        }
        if (aggregateBytes + bytes.byteLength > PROJECT_TEXT_SOURCE_LIMITS.maxAggregateBytes) {
          results.push(
            unavailable(
              entry,
              'aggregate-limit',
              'Text source batch exceeds the aggregate byte limit.',
            ),
          );
          continue;
        }
        aggregateBytes += bytes.byteLength;
        const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
        if (entry.expectedContentHash !== null && digest !== entry.expectedContentHash) {
          results.push(
            unavailable(
              entry,
              'hash-mismatch',
              'Text source bytes do not match the recorded content hash.',
            ),
          );
          continue;
        }
        const hadUtf8Bom =
          bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
        const text = decoder.decode(hadUtf8Bom ? bytes.subarray(3) : bytes);
        results.push({
          status: 'ready',
          readKey: entry.readKey,
          projectRelativePath: entry.projectRelativePath,
          contentHash: digest,
          text,
          hadUtf8Bom,
        });
      } catch (error) {
        const code =
          error instanceof TextSourceReadFailure
            ? error.code
            : error instanceof TypeError
              ? 'invalid-utf8'
              : 'read-failed';
        results.push(
          unavailable(
            entry,
            code,
            error instanceof Error ? error.message : 'Text source read failed.',
          ),
        );
      }
    }
    return { entries: results };
  }
}

async function openAndReadContainedFile(
  root: string,
  filePath: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; isFile: boolean; size: number }> {
  let file;
  try {
    file = await fs.open(filePath, readOnlyNoFollowFlags);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ELOOP') {
      throw new TextSourceReadFailure(
        'symlink-escape',
        'Text source changed to a symbolic link before it could be opened.',
      );
    }
    throw error;
  }
  try {
    const openedPath = await fs.realpath(filePath);
    const relative = path.relative(root, openedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new TextSourceReadFailure(
        'symlink-escape',
        'Text source resolves outside the active Project root.',
      );
    }
    const [descriptorStat, openedPathStat] = await Promise.all([file.stat(), fs.stat(openedPath)]);
    if (descriptorStat.dev !== openedPathStat.dev || descriptorStat.ino !== openedPathStat.ino) {
      throw new TextSourceReadFailure(
        'read-failed',
        'Text source changed while it was being opened.',
      );
    }
    if (!descriptorStat.isFile() || descriptorStat.size > maxBytes) {
      return {
        bytes: Buffer.alloc(0),
        isFile: descriptorStat.isFile(),
        size: descriptorStat.size,
      };
    }
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < bytes.byteLength) {
      const result = await file.read(bytes, total, bytes.byteLength - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    return { bytes: bytes.subarray(0, total), isFile: true, size: descriptorStat.size };
  } finally {
    await file.close();
  }
}

function staleSessionResponse(
  entries: ReadProjectTextSourcesRequest['entries'],
): ReadProjectTextSourcesResponse {
  return {
    entries: entries.map((entry) =>
      unavailable(entry, 'stale-session', 'Project session is stale or unknown.'),
    ),
  };
}

function unavailable(
  entry: ReadProjectTextSourcesRequest['entries'][number],
  code: string,
  message: string,
): ProjectTextSourceReadEntry {
  return {
    status: 'unavailable',
    readKey: entry.readKey,
    projectRelativePath: entry.projectRelativePath,
    expectedContentHash: entry.expectedContentHash ?? null,
    code,
    boundaryCode: projectTextSourceBoundaryCode(code),
    message,
  };
}
