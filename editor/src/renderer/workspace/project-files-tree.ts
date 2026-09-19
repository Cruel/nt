import type { ProjectSourceFile } from '../../shared/project-source-files';
import { searchProjectSourceFiles } from '../../shared/project-search/project-source-search';

export interface ProjectFilesNode {
  id: string;
  label: string;
  path: string;
  kind: 'folder' | 'file';
  source?: ProjectSourceFile;
  children?: ProjectFilesNode[];
}

interface MutableProjectFilesNode extends Omit<ProjectFilesNode, 'children'> {
  children: MutableProjectFilesNode[];
}

const ROOT_ORDER = new Map([
  ['scripts', 0],
  ['shaders', 1],
  ['assets', 2],
  ['layouts', 3],
]);

function compareNodes(left: ProjectFilesNode, right: ProjectFilesNode): number {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  const leftRoot = ROOT_ORDER.get(left.path) ?? Number.MAX_SAFE_INTEGER;
  const rightRoot = ROOT_ORDER.get(right.path) ?? Number.MAX_SAFE_INTEGER;
  if (leftRoot !== rightRoot) return leftRoot - rightRoot;
  return left.label.localeCompare(right.label);
}

export function buildProjectFilesTree(
  files: readonly ProjectSourceFile[],
  explicitFolders: readonly string[] = [],
): ProjectFilesNode[] {
  const roots: MutableProjectFilesNode[] = [];
  const folders = new Map<string, MutableProjectFilesNode>();
  for (const rootName of ['scripts', 'shaders', 'assets', 'layouts']) {
    const root: MutableProjectFilesNode = {
      id: `folder:${rootName}`,
      label: rootName,
      path: rootName,
      kind: 'folder',
      children: [],
    };
    roots.push(root);
    folders.set(rootName, root);
  }

  for (const explicitFolder of explicitFolders) {
    const parts = explicitFolder.split('/').filter(Boolean);
    let parent: MutableProjectFilesNode | null = null;
    let accumulated = '';
    for (const part of parts) {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      let folder = folders.get(accumulated);
      if (!folder) {
        folder = {
          id: `folder:${accumulated}`,
          label: part,
          path: accumulated,
          kind: 'folder',
          children: [],
        };
        folders.set(accumulated, folder);
        if (parent) parent.children.push(folder);
        else roots.push(folder);
      }
      parent = folder;
    }
  }

  for (const source of files) {
    const parts = source.displayPath.split('/').filter(Boolean);
    if (parts.length < 2) continue;
    let parent: MutableProjectFilesNode | null = null;
    let accumulated = '';
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index]!;
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      let folder = folders.get(accumulated);
      if (!folder) {
        folder = {
          id: `folder:${accumulated}`,
          label: part,
          path: accumulated,
          kind: 'folder',
          children: [],
        };
        folders.set(accumulated, folder);
        if (parent) parent.children.push(folder);
        else roots.push(folder);
      }
      parent = folder;
    }
    const label = parts.at(-1)!;
    const fileNode: MutableProjectFilesNode = {
      id: `file:${source.id}`,
      label,
      path: source.displayPath,
      kind: 'file',
      source,
      children: [],
    };
    if (parent) parent.children.push(fileNode);
    else roots.push(fileNode);
  }

  const freeze = (nodes: MutableProjectFilesNode[]): ProjectFilesNode[] =>
    [...nodes].sort(compareNodes).map((node) => ({
      id: node.id,
      label: node.label,
      path: node.path,
      kind: node.kind,
      ...(node.source ? { source: node.source } : {}),
      ...(node.children.length ? { children: freeze(node.children) } : {}),
    }));
  return freeze(roots);
}

export function filterProjectFiles(
  files: readonly ProjectSourceFile[],
  textById: Readonly<Record<string, string>>,
  query: string,
  exactMatch: boolean,
): readonly ProjectSourceFile[] {
  const needle = query.trim();
  if (!needle) return files;
  const sourceByDocumentId = new Map(files.map((file) => [`source:${file.id}`, file]));
  return searchProjectSourceFiles(files, textById, needle, exactMatch).results.flatMap((result) => {
    const source = sourceByDocumentId.get(result.document.id);
    return source ? [source] : [];
  });
}

export function projectFilesPlacementForSource(
  tree: readonly ProjectFilesNode[],
  sourceId: string,
): { node: ProjectFilesNode; ancestorIds: string[] } | null {
  const visit = (
    nodes: readonly ProjectFilesNode[],
    ancestors: string[],
  ): { node: ProjectFilesNode; ancestorIds: string[] } | null => {
    for (const node of nodes) {
      if (node.kind === 'file' && node.source?.id === sourceId)
        return { node, ancestorIds: ancestors };
      const result = node.children ? visit(node.children, [...ancestors, node.id]) : null;
      if (result) return result;
    }
    return null;
  };
  return visit(tree, []);
}
