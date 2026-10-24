import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseMaterialData } from '../../shared/project-schema/authoring-materials';
import {
  isSafeProjectAttachmentPath,
  parseAssetData,
} from '../../shared/project-schema/authoring-assets';
import { PROJECT_TEXT_SOURCE_LIMITS } from '../../shared/project-text-sources';
import type {
  ProjectSourceExpectedRevision,
  ProjectSourceStructuralOperation,
  ProjectSourceStructuralResponse,
  ProjectSourceWriteResponse,
} from '../../shared/project-source-files';
import {
  NodeProjectWorkspaceFileSystem,
  NodeProjectWorkspaceProcessLiveness,
} from '../../shared/project-workspace/node-project-workspace-file-system';
import {
  PROJECT_WORKSPACE_ABSENT_REVISION,
  ProjectWorkspaceMutationError,
  ProjectWorkspaceTransactionService,
  type ProjectWorkspaceTransactionTargetInput,
} from '../../shared/project-workspace/project-workspace-transaction';
import {
  projectWorkspaceFiles,
  type LoadedProjectWorkspaceSnapshot,
} from '../../shared/project-workspace/project-workspace-service';
import type { ActiveProjectWorkspaceSession } from './active-project-workspace-session';
import {
  allShaderFiles,
  projectSourceUsages,
  sourceFilesAtOrBelow,
} from './project-source-usage-reader';
import {
  mappedPath,
  materialShaderCopyPath,
  readEngineShaderSource,
  rewriteSemanticPaths,
  rewriteShaderIncludes,
  sourceTemplate,
} from './project-source-planning-helpers';

export {
  projectSourceUsages,
  sourceFilesAtOrBelow,
  allShaderFiles,
} from './project-source-usage-reader';
export {
  materialShaderCopyPath,
  readEngineShaderSource,
  rewriteSemanticPaths,
  rewriteShaderIncludes,
  sourceTemplate,
} from './project-source-planning-helpers';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function sourceRoot(value: string): 'scripts' | 'shaders' | null {
  if (value === 'scripts' || value.startsWith('scripts/')) return 'scripts';
  if (value === 'shaders' || value.startsWith('shaders/')) return 'shaders';
  return null;
}

function isSafeSourcePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('//')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function assertSourcePath(value: string, allowRoot = false): void {
  const root = sourceRoot(value);
  if (!root || !isSafeSourcePath(value) || (!allowRoot && value === root))
    throw new ProjectWorkspaceMutationError(
      'WORKSPACE_PATH_INVALID',
      `Source path '${value}' must remain beneath scripts/ or shaders/.`,
      value,
    );
}

export function recreatableProjectSourcePhysicalPath(
  project: AuthoringProject,
  sourceId: string,
): string | null {
  const root = sourceRoot(sourceId);
  if (root && isSafeSourcePath(sourceId) && sourceId !== root) {
    if (root === 'scripts' && !sourceId.endsWith('.lua')) return null;
    return sourceId;
  }
  for (const [layoutId, record] of Object.entries(project.layouts)) {
    const data = record.data as unknown as Record<string, { sourceMode?: string }>;
    for (const channel of ['rml', 'rcss', 'lua'] as const) {
      if (
        sourceId === `layouts/${layoutId}/layout.${channel}` &&
        data[channel]?.sourceMode === 'inline'
      )
        return `records/layouts/${layoutId}/layout.${channel}`;
    }
  }
  return null;
}

function validateFileKind(pathValue: string, kind: 'lua' | 'shader'): void {
  assertSourcePath(pathValue);
  if (kind === 'lua' && (!pathValue.startsWith('scripts/') || !pathValue.endsWith('.lua')))
    throw new ProjectWorkspaceMutationError(
      'WORKSPACE_PATH_INVALID',
      'Lua source files must use a .lua path beneath scripts/.',
      pathValue,
    );
  if (kind === 'shader' && (!pathValue.startsWith('shaders/') || !pathValue.endsWith('.sc')))
    throw new ProjectWorkspaceMutationError(
      'WORKSPACE_PATH_INVALID',
      'Shader source files must use a .sc path beneath shaders/.',
      pathValue,
    );
}

export async function materialShaderSourceText(
  root: string,
  sourceIdentity: string,
): Promise<string | null> {
  if (sourceIdentity.startsWith('engine:/')) return readEngineShaderSource(sourceIdentity);
  if (!sourceIdentity.startsWith('project:/')) return null;
  const relative = sourceIdentity.slice('project:/'.length);
  if (!relative.startsWith('shaders/')) return null;
  assertSourcePath(relative);
  const [rootRealPath, sourceRealPath] = await Promise.all([
    fs.realpath(root),
    fs.realpath(path.join(root, relative)),
  ]);
  const relativeRealPath = path.relative(rootRealPath, sourceRealPath);
  if (relativeRealPath.startsWith('..') || path.isAbsolute(relativeRealPath))
    throw new ProjectWorkspaceMutationError(
      'WORKSPACE_PATH_INVALID',
      `Shader source '${sourceIdentity}' resolves outside the active Project.`,
      relative,
    );
  const stat = await fs.stat(sourceRealPath);
  if (!stat.isFile() || stat.size > PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes)
    throw new Error(`Shader source '${sourceIdentity}' is unavailable or too large.`);
  return fs.readFile(sourceRealPath, 'utf8');
}

function revision(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function moveRemapForFiles(
  fromPath: string,
  toPath: string,
  files: readonly string[],
): Map<string, string> {
  const remap = new Map<string, string>();
  for (const file of files) {
    if (file === fromPath) remap.set(file, toPath);
    else if (file.startsWith(`${fromPath}/`))
      remap.set(file, `${toPath}${file.slice(fromPath.length)}`);
  }
  return remap;
}

async function currentExpectedRevision(
  fileSystem: NodeProjectWorkspaceFileSystem,
  root: string,
  relative: string,
): Promise<ProjectSourceExpectedRevision> {
  try {
    return (await fileSystem.readFileRevision(fileSystem.joinPath(root, relative))).contentHash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return PROJECT_WORKSPACE_ABSENT_REVISION;
    throw error;
  }
}

function transactionService(fileSystem: NodeProjectWorkspaceFileSystem) {
  return new ProjectWorkspaceTransactionService(
    fileSystem,
    new NodeProjectWorkspaceProcessLiveness(),
    process.pid,
  );
}

function changedProjectionTargets(
  snapshot: LoadedProjectWorkspaceSnapshot,
  project: AuthoringProject,
  scriptSourcePaths: Readonly<Record<string, string>>,
): string[] {
  const before = projectWorkspaceFiles(
    snapshot.project,
    snapshot.project.editor,
    snapshot.scriptSourcePaths,
    new Set(snapshot.canonicalSourceFiles),
  );
  const after = projectWorkspaceFiles(
    project,
    project.editor,
    scriptSourcePaths,
    new Set(snapshot.canonicalSourceFiles),
  );
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((file) => before[file] !== after[file])
    .sort();
}

export async function writeProjectSourceText(
  session: ActiveProjectWorkspaceSession,
  sourceId: string,
  physicalPath: string,
  expectedRevision: ProjectSourceExpectedRevision,
  text: string,
): Promise<ProjectSourceWriteResponse> {
  return session.runExclusive(async () => {
    const root = session.projectRoot();
    const fileSystem = new NodeProjectWorkspaceFileSystem();
    const bytes = encoder.encode(text);
    try {
      await transactionService(fileSystem).commit(root, {
        operationLabel: `save source ${sourceId}`,
        targets: [{ path: physicalPath, operation: 'write', expectedRevision, bytes }],
      });
      if (session.snapshot().canonicalSourceFiles.includes(physicalPath)) {
        const opened = await session.reassemble([physicalPath]);
        if (!opened.ok)
          return {
            ok: false,
            success: false,
            sourceId,
            error: opened.diagnostics[0]?.message ?? 'Saved source could not be reconciled.',
          };
      }
      return { ok: true, success: true, sourceId, contentHash: revision(bytes) };
    } catch (error) {
      return {
        ok: false,
        success: false,
        sourceId,
        error: error instanceof Error ? error.message : 'Source save failed.',
      };
    }
  });
}

export async function mutateProjectSources(
  session: ActiveProjectWorkspaceSession,
  operation: ProjectSourceStructuralOperation,
  expectedRevisions: Readonly<Record<string, ProjectSourceExpectedRevision>> = {},
): Promise<ProjectSourceStructuralResponse> {
  return session.runExclusive(async () => {
    const root = session.projectRoot();
    const snapshot = session.snapshot();
    const fileSystem = new NodeProjectWorkspaceFileSystem();
    try {
      if (operation.kind === 'create-folder') {
        assertSourcePath(operation.path);
        const absolute = fileSystem.joinPath(root, operation.path);
        if ((await fileSystem.inspect(absolute)) !== 'missing')
          throw new ProjectWorkspaceMutationError(
            'WORKSPACE_REVISION_CONFLICT',
            `Source destination '${operation.path}' already exists.`,
            operation.path,
          );
        await fileSystem.createDirectory(absolute);
        return { ok: true, success: true, changedPaths: [operation.path] };
      }
      if (operation.kind === 'create-file') {
        validateFileKind(operation.path, operation.fileKind);
        const bytes = encoder.encode(sourceTemplate(operation.fileKind));
        await transactionService(fileSystem).commit(root, {
          operationLabel: `create source ${operation.path}`,
          targets: [
            {
              path: operation.path,
              operation: 'write',
              expectedRevision: PROJECT_WORKSPACE_ABSENT_REVISION,
              bytes,
            },
          ],
        });
        return { ok: true, success: true, changedPaths: [operation.path] };
      }
      if (operation.kind === 'material-shader-copy') {
        const material = snapshot.project.materials[operation.materialId];
        const data = parseMaterialData(material?.data);
        if (!material || !data)
          throw new Error(`Material '${operation.materialId}' is unavailable or invalid.`);
        const sourceIdentity = operation.sourceIdentity;
        const sourceText = await materialShaderSourceText(root, sourceIdentity);
        if (sourceText === null)
          throw new Error(`Shader source '${sourceIdentity}' cannot be copied.`);
        const preferredDestination = materialShaderCopyPath(operation.materialId, operation.stage);
        let destination = preferredDestination;
        let copyIndex = 2;
        while (
          sourceIdentity === `project:/${destination}` ||
          (await fileSystem.inspect(fileSystem.joinPath(root, destination))) !== 'missing'
        ) {
          destination = preferredDestination.replace(/\.sc$/u, `-${copyIndex}.sc`);
          copyIndex += 1;
        }
        assertSourcePath(destination);
        const copiedSourceText = sourceIdentity.startsWith('project:/shaders/')
          ? rewriteShaderIncludes(
              sourceText,
              sourceIdentity.slice('project:/'.length),
              destination,
              new Map(),
              new Set(await allShaderFiles(root)),
            )
          : sourceText;
        const candidate = structuredClone(snapshot.project);
        const candidateData = parseMaterialData(candidate.materials[operation.materialId]?.data);
        if (!candidateData)
          throw new Error(`Material '${operation.materialId}' is unavailable or invalid.`);
        candidateData.shader = {
          ...candidateData.shader,
          [operation.stage]: { kind: 'project', path: destination },
        };
        candidate.materials[operation.materialId]!.data = candidateData;
        const targetFiles = changedProjectionTargets(
          snapshot,
          candidate,
          snapshot.scriptSourcePaths,
        );
        const expectedFileRevisions = Object.fromEntries(
          targetFiles.map((file) => [
            file,
            snapshot.fileRevisions[file]?.contentHash ?? PROJECT_WORKSPACE_ABSENT_REVISION,
          ]),
        );
        const written = await session
          .service()
          .write(
            root,
            snapshot.workspaceRevision,
            candidate,
            session.editorState(),
            snapshot.scriptSourcePaths,
            {
              expectedFileRevisions,
              targetFiles,
              operationLabel: `customize Material shader ${operation.materialId}:${operation.stage}`,
              extraTargets: [
                {
                  path: destination,
                  operation: 'write',
                  expectedRevision: PROJECT_WORKSPACE_ABSENT_REVISION,
                  bytes: encoder.encode(copiedSourceText),
                },
              ],
              preflightSnapshot: snapshot,
            },
          );
        session.adopt(written.snapshot, session.editorState());
        return {
          ok: true,
          success: true,
          changedPaths: [...new Set([...targetFiles, destination])].sort(),
          createdSourceIds: [destination],
        };
      }
      if (operation.kind === 'move-attachment') {
        const { fromPath, toPath } = operation;
        if (
          !isSafeProjectAttachmentPath(fromPath) ||
          !isSafeProjectAttachmentPath(toPath) ||
          !/^(?:assets|support)\//u.test(fromPath) ||
          !/^(?:assets|support)\//u.test(toPath) ||
          fromPath === toPath
        )
          throw new Error('Attachment moves must use distinct paths inside assets/ or support/.');
        const sourceAbsolute = path.join(root, fromPath);
        const targetAbsolute = path.join(root, toPath);
        // Reject symlinked ancestors, including a missing destination beneath a linked folder.
        for (const relative of [fromPath, toPath]) {
          let cursor = root;
          for (const segment of relative.split('/')) {
            cursor = path.join(cursor, segment);
            try {
              if ((await fs.lstat(cursor)).isSymbolicLink())
                throw new Error('Attachment moves cannot traverse symbolic links.');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
        }
        if ((await fileSystem.inspect(sourceAbsolute)) !== 'file')
          throw new Error(`Attachment '${fromPath}' is not a regular file.`);
        if ((await fileSystem.inspect(targetAbsolute)) !== 'missing')
          throw new Error(`Attachment destination '${toPath}' already exists.`);
        const candidate = structuredClone(snapshot.project);
        let references = 0;
        const notices = candidate.settings.distributionNotices;
        if (notices.some((notice) => notice.path === fromPath)) {
          if (notices.some((notice) => notice.path === toPath))
            throw new Error(
              'Moving this file would create a duplicate Project distribution notice.',
            );
          candidate.settings.distributionNotices = notices.map((notice) =>
            notice.path === fromPath ? { ...notice, path: toPath } : notice,
          );
          references++;
        }
        for (const record of Object.values(candidate.assets)) {
          const data = parseAssetData(record.data);
          if (!data) continue;
          const hasSource = data.source.path === fromPath;
          const hasAttachment = data.attachments.some((attachment) => attachment.path === fromPath);
          if (!hasSource && !hasAttachment) continue;
          if (data.attachments.some((attachment) => attachment.path === toPath))
            throw new Error('Moving this file would create a duplicate Asset attachment.');
          record.data = {
            ...data,
            source: hasSource ? { ...data.source, path: toPath } : data.source,
            attachments: data.attachments.map((attachment) =>
              attachment.path === fromPath ? { ...attachment, path: toPath } : attachment,
            ),
          };
          references++;
        }
        if (!references)
          throw new Error('Only files referenced by saved Assets can be moved here.');
        const bytes = await fileSystem.readBytes(sourceAbsolute);
        const targets = changedProjectionTargets(snapshot, candidate, snapshot.scriptSourcePaths);
        const written = await session
          .service()
          .write(
            root,
            snapshot.workspaceRevision,
            candidate,
            session.editorState(),
            snapshot.scriptSourcePaths,
            {
              targetFiles: targets,
              expectedFileRevisions: Object.fromEntries(
                targets.map((file) => [
                  file,
                  snapshot.fileRevisions[file]?.contentHash ?? PROJECT_WORKSPACE_ABSENT_REVISION,
                ]),
              ),
              operationLabel: `move attached Project file ${fromPath}`,
              extraTargets: [
                {
                  path: toPath,
                  operation: 'write',
                  expectedRevision: PROJECT_WORKSPACE_ABSENT_REVISION,
                  bytes,
                },
                {
                  path: fromPath,
                  operation: 'delete',
                  expectedRevision: expectedRevisions[fromPath] ?? revision(bytes),
                },
              ],
              preflightSnapshot: snapshot,
            },
          );
        session.adopt(written.snapshot, session.editorState());
        return {
          ok: true,
          success: true,
          pathRemap: { [fromPath]: toPath },
          changedPaths: [fromPath, toPath, ...targets],
        };
      }
      if (operation.kind === 'delete') {
        assertSourcePath(operation.path);
        const usages = await projectSourceUsages(root, snapshot, operation.path);
        if (usages.length > 0)
          return {
            ok: false,
            success: false,
            usages,
            error: `Source '${operation.path}' is still referenced.`,
          };
        const files = await sourceFilesAtOrBelow(root, operation.path);
        if (files.length === 0) {
          await fs.rm(path.join(root, operation.path), { recursive: true, force: false });
          return { ok: true, success: true, changedPaths: [operation.path] };
        }
        const targets: ProjectWorkspaceTransactionTargetInput[] = [];
        for (const file of files) {
          const current = await currentExpectedRevision(fileSystem, root, file);
          targets.push({
            path: file,
            operation: 'delete',
            expectedRevision: expectedRevisions[file] ?? current,
          });
        }
        await transactionService(fileSystem).commit(root, {
          operationLabel: `delete source ${operation.path}`,
          targets,
        });
        await fs.rm(path.join(root, operation.path), { recursive: true, force: true });
        return { ok: true, success: true, changedPaths: files };
      }

      assertSourcePath(operation.fromPath);
      assertSourcePath(operation.toPath);
      if (sourceRoot(operation.fromPath) !== sourceRoot(operation.toPath))
        throw new ProjectWorkspaceMutationError(
          'WORKSPACE_PATH_INVALID',
          'Source moves must remain within the same scripts/ or shaders/ root.',
        );
      const sourceAbsolute = fileSystem.joinPath(root, operation.fromPath);
      const sourceKind = await fileSystem.inspect(sourceAbsolute);
      const files = await sourceFilesAtOrBelow(root, operation.fromPath);
      if (sourceKind === 'missing')
        throw new Error(`Source '${operation.fromPath}' does not exist.`);
      if ((await fileSystem.inspect(fileSystem.joinPath(root, operation.toPath))) !== 'missing')
        throw new ProjectWorkspaceMutationError(
          'WORKSPACE_REVISION_CONFLICT',
          `Source destination '${operation.toPath}' already exists.`,
          operation.toPath,
        );
      if (sourceKind === 'directory' && files.length === 0) {
        await fs.mkdir(path.dirname(path.join(root, operation.toPath)), { recursive: true });
        await fs.rename(sourceAbsolute, path.join(root, operation.toPath));
        return {
          ok: true,
          success: true,
          pathRemap: {},
          changedPaths: [operation.fromPath, operation.toPath],
        };
      }
      const remap = moveRemapForFiles(operation.fromPath, operation.toPath, files);
      for (const target of remap.values()) assertSourcePath(target);

      const candidate = structuredClone(snapshot.project);
      const scriptSourcePaths = { ...snapshot.scriptSourcePaths };
      rewriteSemanticPaths(candidate, scriptSourcePaths, remap);
      const projectionTargets = changedProjectionTargets(snapshot, candidate, scriptSourcePaths);
      const extraTargets: ProjectWorkspaceTransactionTargetInput[] = [];
      const changedPaths = new Set<string>();
      const sourceBytes = new Map<string, Uint8Array>();
      for (const source of files)
        sourceBytes.set(source, await fileSystem.readBytes(path.join(root, source)));

      if (sourceRoot(operation.fromPath) === 'shaders') {
        const shaderFiles = await allShaderFiles(root);
        const existingShaderPaths = new Set(shaderFiles);
        for (const shaderPath of shaderFiles) {
          const oldBytes =
            sourceBytes.get(shaderPath) ??
            (await fileSystem.readBytes(path.join(root, shaderPath)));
          const oldText = decoder.decode(oldBytes);
          const newPath = mappedPath(shaderPath, remap);
          const newText = rewriteShaderIncludes(
            oldText,
            shaderPath,
            newPath,
            remap,
            existingShaderPaths,
          );
          const moved = newPath !== shaderPath;
          const rewritten = newText !== oldText;
          if (!moved && !rewritten) continue;
          const expected = expectedRevisions[shaderPath] ?? revision(oldBytes);
          extraTargets.push({
            path: newPath,
            operation: 'write',
            expectedRevision: moved ? PROJECT_WORKSPACE_ABSENT_REVISION : expected,
            bytes: encoder.encode(newText),
          });
          if (moved)
            extraTargets.push({
              path: shaderPath,
              operation: 'delete',
              expectedRevision: expected,
            });
          changedPaths.add(shaderPath);
          changedPaths.add(newPath);
        }
      } else {
        for (const [source, target] of remap) {
          const bytes = sourceBytes.get(source)!;
          const expected = expectedRevisions[source] ?? revision(bytes);
          extraTargets.push({
            path: target,
            operation: 'write',
            expectedRevision: PROJECT_WORKSPACE_ABSENT_REVISION,
            bytes,
          });
          extraTargets.push({ path: source, operation: 'delete', expectedRevision: expected });
          changedPaths.add(source);
          changedPaths.add(target);
        }
      }

      const targetFiles = projectionTargets;
      const expectedFileRevisions = Object.fromEntries(
        targetFiles.map((file) => [
          file,
          snapshot.fileRevisions[file]?.contentHash ?? PROJECT_WORKSPACE_ABSENT_REVISION,
        ]),
      );
      const written = await session
        .service()
        .write(
          root,
          snapshot.workspaceRevision,
          candidate,
          session.editorState(),
          scriptSourcePaths,
          {
            expectedFileRevisions,
            targetFiles,
            operationLabel: `move source ${operation.fromPath}`,
            extraTargets,
            preflightSnapshot: snapshot,
          },
        );
      session.adopt(written.snapshot, session.editorState());
      for (const file of targetFiles) changedPaths.add(file);
      await fs
        .rm(path.join(root, operation.fromPath), { recursive: true, force: true })
        .catch(() => undefined);
      return {
        ok: true,
        success: true,
        pathRemap: Object.fromEntries(remap),
        changedPaths: [...changedPaths].sort(),
      };
    } catch (error) {
      return {
        ok: false,
        success: false,
        error: error instanceof Error ? error.message : 'Source operation failed.',
      };
    }
  });
}
