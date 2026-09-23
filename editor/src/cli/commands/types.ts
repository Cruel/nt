import type { NovelTeaCliNativeToolService } from '../native-tool-service';
import type { NovelTeaCliPlatformToolService } from '../platform-tool-service';
import type { CliSemanticResult } from '../semantic-project';
import type {
  CliProjectPreparationIntent,
  CliScopedProjectPreparation,
} from '../project-preparation';
import {
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from '../../shared/project-schema/authoring-collections';
import type {
  LoadedProjectWorkspaceSnapshot,
  ProjectWorkspaceFileSystem,
  ProjectWorkspaceSourceWork,
  ProjectWorkspaceService,
} from '../../shared/project-workspace';
import { CliCommandUsageError } from './errors';
import type { PinnedExternalAssetExpectation } from '../pinned-external-assets';
import type { RuntimeArtifactPathAdapter } from '../../shared/runtime-artifact-preparation';
import type { PinnedRuntimeBuildCacheInputs } from '../../shared/runtime-build-cache';

export { CliCommandUsageError } from './errors';

export interface CliTerminalContext {
  readonly stdin: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
  readonly columns: number | null;
  readonly rows: number | null;
}

interface CliCommandContextBase {
  readonly cwd: string;
  readonly terminal?: CliTerminalContext;
  readonly stdinJson?: unknown;
  readonly fileSystem: ProjectWorkspaceFileSystem;
  readonly nativeTools: NovelTeaCliNativeToolService;
  readonly platformTools: NovelTeaCliPlatformToolService;
  readonly onPlatformProgress?: (stage: string, message: string) => void;
  readonly abortSignal?: AbortSignal;
  readonly forceRuntimeCacheRebuild: boolean;
  readonly pinnedExternalAssets?: readonly PinnedExternalAssetExpectation[];
  readonly pinnedProjectTextSources?: Readonly<
    Record<string, Readonly<{ text: string; contentHash?: string }>>
  >;
  readonly runtimeArtifactPaths?: RuntimeArtifactPathAdapter;
  readonly pinnedRuntimeBuildCacheInputs?: PinnedRuntimeBuildCacheInputs | null;
}

export interface CliCommandContext extends CliCommandContextBase {
  readonly workspace: ProjectWorkspaceService;
  readonly snapshot: LoadedProjectWorkspaceSnapshot;
  readonly sourceWork: ProjectWorkspaceSourceWork;
}

export interface CliScopedCommandContext extends CliCommandContextBase {
  readonly preparation: CliScopedProjectPreparation;
}

export interface CliCommandInvocation {
  readonly dryRun: boolean;
  readonly mutation: boolean;
  readonly projectPreparation?: undefined;
  run(context: CliCommandContext): Promise<CliSemanticResult> | CliSemanticResult;
}

export interface CliScopedCommandInvocation {
  readonly dryRun: true;
  readonly mutation: false;
  readonly projectPreparation: CliProjectPreparationIntent;
  run(context: CliScopedCommandContext): Promise<CliSemanticResult> | CliSemanticResult;
}

export type CliParsedCommand = CliCommandInvocation | CliScopedCommandInvocation;

export interface CliCommandDefinition {
  readonly path: readonly string[];
  parse(arguments_: readonly string[]): CliParsedCommand;
}

export function requireAuthoringCollection(value: string): AuthoringCollectionKey {
  if (!isAuthoringCollectionKey(value))
    throw new CliCommandUsageError(`Unknown collection '${value}'.`);
  return value;
}

export function parseCommandFlags(
  arguments_: readonly string[],
  allowed: readonly string[],
): Readonly<{ positionals: readonly string[]; flags: ReadonlySet<string> }> {
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (const value of arguments_) {
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    if (!allowed.includes(value))
      throw new CliCommandUsageError(`Unknown command option '${value}'.`);
    if (flags.has(value))
      throw new CliCommandUsageError(`Option '${value}' may be supplied only once.`);
    flags.add(value);
  }
  return { positionals, flags };
}
