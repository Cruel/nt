import type { ProjectWorkspaceFileSystem } from './project-workspace-file-system';
import {
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
} from './project-workspace-contracts';

export type ProjectWorkspaceDiscoveryCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_MANIFEST_READ'
  | 'WORKSPACE_MANIFEST_INVALID'
  | 'WORKSPACE_VERSION_UNSUPPORTED';

export type ProjectWorkspaceDiscoveryResult =
  | Readonly<{ ok: true; projectRoot: string; manifestPath: string }>
  | Readonly<{
      ok: false;
      code: ProjectWorkspaceDiscoveryCode;
      projectRoot?: string;
      manifestPath?: string;
      message: string;
      path: string;
    }>;

function parentDirectory(fileSystem: ProjectWorkspaceFileSystem, directory: string): string {
  return fileSystem.resolvePath(fileSystem.joinPath(directory, '..'));
}

async function validateManifestAt(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
): Promise<ProjectWorkspaceDiscoveryResult> {
  const root = fileSystem.resolvePath(projectRoot);
  const manifestPath = fileSystem.joinPath(root, 'project.json');
  let text: string;
  try {
    text = await fileSystem.readText(manifestPath);
  } catch {
    return {
      ok: false,
      code: 'WORKSPACE_MANIFEST_READ',
      projectRoot: root,
      manifestPath,
      message: 'project.json could not be read.',
      path: '/project.json',
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      code: 'WORKSPACE_MANIFEST_INVALID',
      projectRoot: root,
      manifestPath,
      message: 'project.json is not valid JSON.',
      path: '/project.json',
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      code: 'WORKSPACE_MANIFEST_INVALID',
      projectRoot: root,
      manifestPath,
      message: 'project.json must be an object.',
      path: '/project.json',
    };
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schema !== PROJECT_WORKSPACE_SCHEMA) {
    return {
      ok: false,
      code: 'WORKSPACE_MANIFEST_INVALID',
      projectRoot: root,
      manifestPath,
      message: `project.json must use schema '${PROJECT_WORKSPACE_SCHEMA}'.`,
      path: '/schema',
    };
  }
  if (manifest.schemaVersion !== PROJECT_WORKSPACE_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'WORKSPACE_VERSION_UNSUPPORTED',
      projectRoot: root,
      manifestPath,
      message: `Workspace version '${String(manifest.schemaVersion)}' is unsupported; expected ${PROJECT_WORKSPACE_SCHEMA_VERSION}.`,
      path: '/schemaVersion',
    };
  }
  return { ok: true, projectRoot: root, manifestPath };
}

export async function validateExplicitProjectRoot(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
): Promise<ProjectWorkspaceDiscoveryResult> {
  const root = fileSystem.resolvePath(projectRoot);
  if ((await fileSystem.inspect(root)) !== 'directory') {
    return {
      ok: false,
      code: 'WORKSPACE_NOT_FOUND',
      projectRoot: root,
      manifestPath: fileSystem.joinPath(root, 'project.json'),
      message: 'The requested project directory does not exist.',
      path: '/project.json',
    };
  }
  const manifestPath = fileSystem.joinPath(root, 'project.json');
  if ((await fileSystem.inspect(manifestPath)) === 'missing') {
    return {
      ok: false,
      code: 'WORKSPACE_NOT_FOUND',
      projectRoot: root,
      manifestPath,
      message: 'The requested directory does not contain project.json.',
      path: '/project.json',
    };
  }
  return validateManifestAt(fileSystem, root);
}

export function discoverProjectRoot(
  fileSystem: ProjectWorkspaceFileSystem,
  startPath: string,
): Promise<ProjectWorkspaceDiscoveryResult> {
  return new Promise((resolve, reject) => {
    void (async () => {
      let current = fileSystem.resolvePath(startPath);
      if ((await fileSystem.inspect(current)) === 'file')
        current = parentDirectory(fileSystem, current);
      for (;;) {
        const manifestPath = fileSystem.joinPath(current, 'project.json');
        if ((await fileSystem.inspect(manifestPath)) !== 'missing') {
          resolve(await validateManifestAt(fileSystem, current));
          return;
        }
        const parent = parentDirectory(fileSystem, current);
        if (parent === current) break;
        current = parent;
      }
      resolve({
        ok: false,
        code: 'WORKSPACE_NOT_FOUND',
        message: 'No NovelTea project.json was found from the current directory upward.',
        path: '/project.json',
      });
    })().catch(reject);
  });
}
