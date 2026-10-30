import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseMaterialData } from '../../shared/project-schema/authoring-materials';
import type {
  ProjectSourceExpectedRevision,
  ProjectSourceStructuralOperation,
  ProjectSourceStructuralResponse,
} from '../../shared/project-source-files';
import type { NativeAssetTransition } from './native-authoring-worker-contract';
import {
  allShaderFiles,
  projectSourceUsages,
  sourceFilesAtOrBelow,
} from './project-source-usage-reader';
import {
  materialShaderCopyPath,
  materialShaderSourceText,
  rewriteSemanticPaths,
  rewriteShaderIncludes,
  sourceTemplate,
} from './project-source-planning-helpers';
import { diffJsonDocuments } from '../../renderer/project/project-external-reconciliation';
import type { JsonPatchOperation } from '../../renderer/project/json-patch';
import type { JsonValue } from '../../renderer/project/json-value';

type FileEntry = { path: string; expectedRevision: string; contents: string | null };

export interface NativeSourcePlan {
  transition: NonNullable<NativeAssetTransition> | null;
  patches: JsonPatchOperation[];
  savePaths: Record<string, string[]>;
  response: ProjectSourceStructuralResponse;
  /** Empty-directory operations have no journal targets and are handled separately. */
  emptyDirectory?: { kind: 'create' | 'move' | 'delete'; from: string; to?: string };
  /** Source folders that should be pruned after their byte targets commit. */
  cleanupDirectories?: string[];
}

function sourcePath(value: string): boolean {
  if (!/^(?:scripts|shaders)\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/u.test(value)) return false;
  return !value.split('/').some((part) => part === '.' || part === '..');
}

function validFilePath(value: string): boolean {
  return (
    sourcePath(value) &&
    (value.startsWith('scripts/') ? value.endsWith('.lua') : value.endsWith('.sc'))
  );
}

function hash(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Only the native worker publishes these plans. This module performs no filesystem writes. */
export async function planNativeProjectSourceTransaction(
  root: string,
  project: AuthoringProject,
  operation: ProjectSourceStructuralOperation,
  expectedRevisions: Readonly<Record<string, ProjectSourceExpectedRevision>>,
  admittedRevisions: Readonly<Record<string, string>>,
): Promise<NativeSourcePlan> {
  const candidate = structuredClone(project);
  const fileEntries = new Map<string, FileEntry>();
  const remap = new Map<string, string>();
  let createdSourceIds: string[] | undefined;
  let emptyDirectory: NativeSourcePlan['emptyDirectory'];
  let cleanupDirectories: string[] | undefined;

  const canonicalRoot = await fs.realpath(root);
  const verifyExisting = async (relative: string): Promise<void> => {
    const requested = path.resolve(root, relative);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.includes('\\') ||
      relative.split('/').some((part) => part === '.' || part === '..')
    )
      throw new Error('Invalid native source path.');
    const canonical = await fs.realpath(requested);
    if (canonical !== path.join(canonicalRoot, relative))
      throw new Error('Native source path traverses a symbolic link: ' + relative);
  };
  const readSource = async (relative: string): Promise<{ bytes: Buffer; revision: string }> => {
    if (!validFilePath(relative)) throw new Error('Invalid Project source path: ' + relative);
    await verifyExisting(relative);
    const bytes = await fs.readFile(path.join(root, relative));
    if (bytes.byteLength > 4 * 1024 * 1024)
      throw new Error('Source file is too large: ' + relative);
    const revision = hash(bytes);
    const requested = expectedRevisions[relative] ?? admittedRevisions[relative];
    if (requested && requested !== revision)
      throw new Error('WORKSPACE_REVISION_CONFLICT: ' + relative);
    return { bytes, revision };
  };
  const absent = async (relative: string): Promise<void> => {
    if (!validFilePath(relative)) throw new Error('Invalid Project source path: ' + relative);
    try {
      await fs.lstat(path.join(root, relative));
      throw new Error('WORKSPACE_REVISION_CONFLICT: destination already exists: ' + relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  const write = (relative: string, revision: string, contents: string | null): void => {
    if (fileEntries.has(relative)) throw new Error('Duplicate native source transaction path.');
    fileEntries.set(relative, { path: relative, expectedRevision: revision, contents });
  };
  const scriptPaths = Object.fromEntries(
    Object.entries(candidate.scripts).flatMap(([id, record]) =>
      record.data.source.kind === 'project-file' ? [[id, record.data.source.path]] : [],
    ),
  );
  const moveReferences = (paths: ReadonlyMap<string, string>): void => {
    rewriteSemanticPaths(candidate, scriptPaths, paths);
  };
  if (operation.kind === 'create-folder') {
    if (!sourcePath(operation.path)) throw new Error('Invalid Project source folder.');
    emptyDirectory = { kind: 'create', from: operation.path };
  } else if (operation.kind === 'create-file') {
    if (
      !validFilePath(operation.path) ||
      (operation.fileKind === 'lua') !== operation.path.startsWith('scripts/')
    )
      throw new Error('Invalid Project source file kind.');
    await absent(operation.path);
    write(operation.path, 'absent', sourceTemplate(operation.fileKind));
    createdSourceIds = [operation.path];
  } else if (operation.kind === 'material-shader-copy') {
    const material = candidate.materials[operation.materialId];
    const data = parseMaterialData(material?.data);
    if (!material || !data) throw new Error('Material is unavailable.');
    const text = await materialShaderSourceText(root, operation.sourceIdentity);
    if (text === null) throw new Error('Material shader source is unavailable.');
    const preferred = materialShaderCopyPath(operation.materialId, operation.stage);
    let destination = preferred;
    for (let index = 2; index < 1000; index++) {
      try {
        await fs.lstat(path.join(root, destination));
        destination = preferred.replace(/\.sc$/u, `-${index}.sc`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    await absent(destination);
    const shaderFiles = new Set(await allShaderFiles(root));
    const contents = operation.sourceIdentity.startsWith('project:/')
      ? rewriteShaderIncludes(
          text,
          operation.sourceIdentity.slice('project:/'.length),
          destination,
          new Map(),
          shaderFiles,
        )
      : text;
    write(destination, 'absent', contents);
    const shader = data.shader as Record<string, unknown>;
    shader[operation.stage] = { kind: 'project', path: destination };
    material.data = data;
    createdSourceIds = [destination];
  } else if (operation.kind === 'move-attachment') {
    const { fromPath, toPath } = operation;
    if (
      !/^(?:assets|support)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u.test(fromPath) ||
      !/^(?:assets|support)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u.test(toPath) ||
      !(fromPath.startsWith('assets/') || fromPath.startsWith('support/'))
    )
      throw new Error('Invalid Asset attachment move.');
    if (fromPath === toPath) throw new Error('Attachment destination must be different.');
    await verifyExisting(fromPath);
    const bytes = await fs.readFile(path.join(root, fromPath));
    if (expectedRevisions[fromPath] && expectedRevisions[fromPath] !== hash(bytes))
      throw new Error('WORKSPACE_REVISION_CONFLICT: ' + fromPath);
    try {
      await fs.lstat(path.join(root, toPath));
      throw new Error('WORKSPACE_REVISION_CONFLICT: attachment destination exists.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    remap.set(fromPath, toPath);
    moveReferences(remap);
    if (JSON.stringify(candidate) === JSON.stringify(project))
      throw new Error('Only files referenced by native Project records can be moved.');
  } else {
    const source = operation.kind === 'move' ? operation.fromPath : operation.path;
    if (!sourcePath(source)) throw new Error('Invalid Project source path.');
    await verifyExisting(source);
    const files = await sourceFilesAtOrBelow(root, source);
    if (files.length && !files.includes(source)) {
      cleanupDirectories = [
        ...new Set(
          files.flatMap((file) => {
            const folders: string[] = [];
            for (
              let current = path.posix.dirname(file);
              current === source || current.startsWith(`${source}/`);
              current = path.posix.dirname(current)
            )
              folders.push(current);
            return folders;
          }),
        ),
      ].sort((a, b) => b.length - a.length);
    }
    if (!files.length) {
      if (operation.kind === 'move') {
        if (
          !sourcePath(operation.toPath) ||
          source.split('/')[0] !== operation.toPath.split('/')[0]
        )
          throw new Error('Source folders cannot cross source roots.');
        emptyDirectory = { kind: 'move', from: source, to: operation.toPath };
      } else {
        emptyDirectory = { kind: 'delete', from: source };
      }
    } else if (operation.kind === 'delete') {
      const usages = await projectSourceUsages(
        root,
        {
          project: candidate,
          scriptSourcePaths: scriptPaths,
        } as never,
        source,
      );
      if (usages.length)
        return {
          transition: null,
          patches: [],
          savePaths: {},
          response: { ok: false, success: false, usages, error: 'Source is still referenced.' },
        };
      for (const file of files) {
        const { revision } = await readSource(file);
        write(file, revision, null);
      }
    } else {
      const dest = operation.toPath;
      if (
        !sourcePath(dest) ||
        source.split('/')[0] !== dest.split('/')[0] ||
        dest.startsWith(`${source}/`)
      )
        throw new Error('Invalid source relocation.');
      for (const file of files) {
        const next = file === source ? dest : `${dest}${file.slice(source.length)}`;
        if (!validFilePath(next)) throw new Error('Invalid relocated source path.');
        remap.set(file, next);
        await absent(next);
      }
      moveReferences(remap);
      const shaderFiles = new Set(await allShaderFiles(root));
      const affectedFiles = new Set([
        ...files,
        ...(source.startsWith('shaders/') ? shaderFiles : []),
      ]);
      for (const file of affectedFiles) {
        const { bytes, revision } = await readSource(file);
        const next = remap.get(file) ?? file;
        const sourceText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const text = file.startsWith('shaders/')
          ? rewriteShaderIncludes(sourceText, file, next, remap, shaderFiles)
          : sourceText;
        if (next !== file) {
          write(file, revision, null);
          write(next, 'absent', text);
        } else if (text !== sourceText) {
          write(file, revision, text);
        }
      }
    }
  }

  const patches = diffJsonDocuments(
    project as unknown as JsonValue,
    candidate as unknown as JsonValue,
  );
  const savePaths: Record<string, string[]> = {};
  for (const patch of patches) {
    const parts = patch.path.split('/').slice(1);
    const owner = ['assets', 'materials', 'scripts', 'layouts'].includes(parts[0] ?? '')
      ? `${parts[0]}/${parts[1]}`
      : 'project';
    const localPath = owner === 'project' ? patch.path : `/${parts.slice(2).join('/')}`;
    (savePaths[owner] ??= []).push(localPath);
  }
  const pathRemap = Object.fromEntries(remap);
  const response: ProjectSourceStructuralResponse = {
    ok: true,
    success: true,
    ...(Object.keys(pathRemap).length ? { pathRemap } : {}),
    ...(createdSourceIds ? { createdSourceIds } : {}),
    changedPaths: [...new Set([...fileEntries.keys(), ...remap.keys(), ...remap.values()])].sort(),
  };
  const transition: NonNullable<NativeAssetTransition> | null =
    operation.kind === 'move-attachment'
      ? { kind: 'move', moves: [{ fromPath: operation.fromPath, toPath: operation.toPath }] }
      : fileEntries.size
        ? { kind: 'source-files', files: [...fileEntries.values()] }
        : null;
  return {
    transition,
    patches,
    savePaths,
    response,
    ...(emptyDirectory ? { emptyDirectory } : {}),
    ...(cleanupDirectories ? { cleanupDirectories } : {}),
  };
}
