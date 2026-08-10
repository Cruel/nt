import type { NovelTeaCliNativeToolService } from '../native-tool-service';
import type { CliSemanticResult } from '../semantic-project';
import {
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from '../../shared/project-schema/authoring-collections';
import type {
  LoadedProjectWorkspaceSnapshot,
  ProjectWorkspaceService,
} from '../../shared/project-workspace';

export class CliCommandUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliCommandUsageError';
  }
}

export interface CliCommandContext {
  readonly cwd: string;
  readonly stdinJson?: unknown;
  readonly workspace: ProjectWorkspaceService;
  readonly snapshot: LoadedProjectWorkspaceSnapshot;
  readonly nativeTools: NovelTeaCliNativeToolService;
}

export interface CliCommandInvocation {
  readonly dryRun: boolean;
  readonly mutation: boolean;
  run(context: CliCommandContext): Promise<CliSemanticResult> | CliSemanticResult;
}

export interface CliCommandDefinition {
  readonly path: readonly string[];
  parse(arguments_: readonly string[]): CliCommandInvocation;
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
