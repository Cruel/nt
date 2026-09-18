import type { AuthoringProject } from '../shared/project-schema/authoring-project';
import {
  projectIdentitySchema,
  type ProjectIdentity,
} from '../shared/project-schema/authoring-project-identity';
import { entityIdSchema } from '../shared/project-schema/authoring-common';
import { assetRecordSchema } from '../shared/project-schema/authoring-asset-record';
import {
  inferAssetKindFromExtension,
  isSafeProjectAssetPath,
  parseAssetData,
} from '../shared/project-schema/authoring-assets';
import {
  assertProjectWorkspacePathContained,
  type ProjectWorkspaceFileSystem,
} from '../shared/project-workspace/project-workspace-file-system';
import {
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
} from '../shared/project-workspace/project-workspace-contracts';
import { cliDiagnostic, type NovelTeaCliDiagnostic } from './contracts';

export type CliProjectPreparationDomain = 'project-identity' | 'assets' | 'filesystem-inventory';

export interface CliProjectPreparationIntent {
  readonly mode: 'scoped-read-only';
  readonly domains: readonly CliProjectPreparationDomain[];
  readonly validationBoundary: 'required-domains';
}

export const assetAuditProjectPreparationIntent: CliProjectPreparationIntent = Object.freeze({
  mode: 'scoped-read-only',
  domains: Object.freeze<CliProjectPreparationDomain[]>([
    'project-identity',
    'assets',
    'filesystem-inventory',
  ]),
  validationBoundary: 'required-domains',
});

export interface CliScopedProjectPreparation {
  readonly intent: CliProjectPreparationIntent;
  readonly projectRoot: string;
  readonly projectIdentity: ProjectIdentity;
  readonly assets: AuthoringProject['assets'];
  readonly assetFilesystemInventory: readonly Readonly<{
    projectRelativePath: string;
    kind: string;
  }>[];
}

export type CliProjectPreparationResult =
  | Readonly<{
      ok: true;
      preparation: CliScopedProjectPreparation;
      diagnostics: readonly NovelTeaCliDiagnostic[];
    }>
  | Readonly<{ ok: false; diagnostics: readonly NovelTeaCliDiagnostic[] }>;

const manifestKeys = Object.freeze([
  'schema',
  'schemaVersion',
  'project',
  'settings',
  'export',
  'bootstrapModule',
  'entrypoint',
  'inventories',
  'interactableInstances',
]);

function failure(code: string, path: string, message: string): CliProjectPreparationResult {
  return { ok: false, diagnostics: [cliDiagnostic(code, path, message)] };
}

function exactManifestShape(value: Readonly<Record<string, unknown>>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...manifestKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isIgnoredAssetInventoryPath(value: string): boolean {
  const base = value.replaceAll('\\', '/').split('/').pop() ?? value;
  if (base === '.DS_Store' || base === 'Thumbs.db') return true;
  if (base.startsWith('.') || base.startsWith('~')) return true;
  const dot = base.lastIndexOf('.');
  const extension = dot >= 0 ? base.slice(dot).toLowerCase() : '';
  return (
    extension === '.tmp' ||
    extension === '.part' ||
    extension === '.crdownload' ||
    extension === '.download'
  );
}

function isContainedRelativePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return (
    normalized === '' ||
    (!normalized.startsWith('../') &&
      normalized !== '..' &&
      !normalized.startsWith('/') &&
      !/^[A-Za-z]:\//.test(normalized))
  );
}

async function collectAssetFilesystemInventory(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
): Promise<
  | Readonly<{
      ok: true;
      inventory: readonly Readonly<{ projectRelativePath: string; kind: string }>[];
    }>
  | Readonly<{ ok: false; result: CliProjectPreparationResult }>
> {
  const assetsRoot = fileSystem.joinPath(projectRoot, 'assets');
  const assetsKind = await fileSystem.inspect(assetsRoot);
  if (assetsKind === 'missing') return { ok: true, inventory: [] };
  if (assetsKind !== 'directory')
    return {
      ok: false,
      result: failure(
        'asset.audit.invalid_assets_directory',
        '/assets',
        'Project assets path is not a directory.',
      ),
    };

  const assetsReal = await fileSystem.realpath(assetsRoot);
  const inventory: Array<Readonly<{ projectRelativePath: string; kind: string }>> = [];
  const diagnostics: NovelTeaCliDiagnostic[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of [...(await fileSystem.listDirectory(directory))].sort()) {
      const absolute = fileSystem.joinPath(directory, name);
      if (isIgnoredAssetInventoryPath(absolute)) continue;
      const kind = await fileSystem.inspect(absolute);
      if (kind === 'missing') continue;
      const real = await fileSystem.realpath(absolute);
      if (!isContainedRelativePath(fileSystem.relativePath(assetsReal, real))) {
        const projectRelativePath = fileSystem
          .relativePath(projectRoot, absolute)
          .replaceAll('\\', '/');
        diagnostics.push(
          cliDiagnostic(
            'asset.audit.path_escape',
            projectRelativePath,
            'Asset path resolves outside the project assets directory.',
          ),
        );
        continue;
      }
      if (kind === 'directory') {
        await visit(absolute);
        continue;
      }
      if (kind !== 'file') continue;
      const projectRelativePath = fileSystem
        .relativePath(projectRoot, absolute)
        .replaceAll('\\', '/');
      inventory.push({
        projectRelativePath,
        kind: inferAssetKindFromExtension(projectRelativePath),
      });
    }
  };
  await visit(assetsRoot);
  if (diagnostics.length > 0) return { ok: false, result: { ok: false, diagnostics } };
  inventory.sort((left, right) =>
    left.projectRelativePath.localeCompare(right.projectRelativePath),
  );
  return { ok: true, inventory };
}

export async function prepareCliProject(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  intent: CliProjectPreparationIntent,
): Promise<CliProjectPreparationResult> {
  if (intent.mode !== 'scoped-read-only' || intent.validationBoundary !== 'required-domains')
    return failure(
      'WORKSPACE_SOURCE_READ',
      '/project.json',
      'Unsupported Project preparation intent.',
    );

  const transactionRoot = fileSystem.joinPath(projectRoot, '.noveltea/transactions');
  const pendingTransactions = (await fileSystem.listDirectory(transactionRoot)).filter(
    (entry) => entry !== '.writer-lock',
  );
  if (pendingTransactions.length > 0)
    return failure(
      'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT',
      '/.noveltea/transactions',
      'The workspace has a pending transaction that requires recovery before a read-only dry run.',
    );

  let manifest: Readonly<Record<string, unknown>>;
  try {
    const manifestPath = fileSystem.joinPath(projectRoot, 'project.json');
    await assertProjectWorkspacePathContained(fileSystem, projectRoot, manifestPath);
    const parsed = JSON.parse(await fileSystem.readText(manifestPath)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return failure(
        'WORKSPACE_MANIFEST_INVALID',
        '/project.json',
        'project.json must be an object.',
      );
    manifest = parsed as Readonly<Record<string, unknown>>;
  } catch {
    return failure(
      'WORKSPACE_MANIFEST_READ',
      '/project.json',
      'Current project discovery requires a readable workspace-v1 project.json.',
    );
  }

  if (
    manifest.schema !== PROJECT_WORKSPACE_SCHEMA ||
    manifest.schemaVersion !== PROJECT_WORKSPACE_SCHEMA_VERSION
  )
    return failure(
      'WORKSPACE_VERSION_UNSUPPORTED',
      '/schema',
      'Project must use the current NovelTea workspace schema.',
    );
  if (!exactManifestShape(manifest))
    return failure(
      'WORKSPACE_MANIFEST_INVALID',
      '/project.json',
      'project.json has an unsupported workspace-v1 shape.',
    );

  const projectIdentity = projectIdentitySchema.safeParse(manifest.project);
  if (!projectIdentity.success)
    return failure('WORKSPACE_SOURCE_READ', '/project', 'Project identity is malformed.');

  const assets: AuthoringProject['assets'] = {};
  if (intent.domains.includes('assets')) {
    const recordsRoot = fileSystem.joinPath(projectRoot, 'records');
    const assetsRoot = fileSystem.joinPath(recordsRoot, 'assets');
    try {
      if ((await fileSystem.inspect(recordsRoot)) !== 'missing')
        await assertProjectWorkspacePathContained(fileSystem, projectRoot, recordsRoot);
      const assetsKind = await fileSystem.inspect(assetsRoot);
      if (assetsKind !== 'missing') {
        if (assetsKind !== 'directory')
          return failure(
            'WORKSPACE_SOURCE_READ',
            '/records/assets',
            'Asset records path is not a directory.',
          );
        await assertProjectWorkspacePathContained(fileSystem, projectRoot, assetsRoot);
        for (const entry of [...(await fileSystem.listDirectory(assetsRoot))].sort()) {
          const diagnosticPath = `/records/assets/${entry}`;
          if (!entry.endsWith('.json'))
            return failure(
              'WORKSPACE_SOURCE_READ',
              diagnosticPath,
              'Record files must use canonical .json names.',
            );
          const id = entry.slice(0, -5);
          if (!entityIdSchema.safeParse(id).success)
            return failure(
              'WORKSPACE_SOURCE_READ',
              diagnosticPath,
              'Record path does not contain a valid ID.',
            );
          const absolute = fileSystem.joinPath(assetsRoot, entry);
          let raw: unknown;
          try {
            await assertProjectWorkspacePathContained(fileSystem, projectRoot, absolute);
            raw = JSON.parse(await fileSystem.readText(absolute)) as unknown;
          } catch {
            return failure('WORKSPACE_SOURCE_READ', diagnosticPath, 'Record is malformed.');
          }
          if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return failure('WORKSPACE_SOURCE_READ', diagnosticPath, 'Record is malformed.');
          if ((raw as { id?: unknown }).id !== id)
            return failure(
              'WORKSPACE_RECORD_ID_PATH_MISMATCH',
              diagnosticPath,
              'Record ID does not match its path.',
            );
          const parsedRecord = assetRecordSchema.safeParse(raw);
          if (!parsedRecord.success)
            return failure('WORKSPACE_SOURCE_READ', diagnosticPath, 'Asset record is malformed.');
          const asset = parseAssetData(parsedRecord.data.data);
          if (!asset || !isSafeProjectAssetPath(asset.source.path))
            return failure(
              'WORKSPACE_PATH_INVALID',
              `/assets/${id}/data/source/path`,
              'Asset source path is not a safe project-relative path.',
            );
          try {
            await assertProjectWorkspacePathContained(
              fileSystem,
              projectRoot,
              fileSystem.joinPath(projectRoot, asset.source.path),
            );
          } catch {
            return failure(
              'WORKSPACE_PATH_INVALID',
              `/assets/${id}/data/source/path`,
              'Asset source path escapes the project root.',
            );
          }
          assets[id] = parsedRecord.data;
        }
      }
    } catch (error) {
      return failure(
        'WORKSPACE_SOURCE_READ',
        '/records/assets',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  let assetFilesystemInventory: readonly Readonly<{ projectRelativePath: string; kind: string }>[] =
    [];
  if (intent.domains.includes('filesystem-inventory')) {
    const inventory = await collectAssetFilesystemInventory(fileSystem, projectRoot);
    if (!inventory.ok) return inventory.result;
    assetFilesystemInventory = inventory.inventory;
  }

  return {
    ok: true,
    diagnostics: [],
    preparation: {
      intent,
      projectRoot,
      projectIdentity: projectIdentity.data,
      assets,
      assetFilesystemInventory,
    },
  };
}
