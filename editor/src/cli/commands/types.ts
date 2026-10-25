import {
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from '../../shared/project-schema/authoring-collections';
import { CliCommandUsageError } from './errors';
export { CliCommandUsageError } from './errors';

export interface CliTerminalContext {
  readonly stdin: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
  readonly columns: number | null;
  readonly rows: number | null;
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
