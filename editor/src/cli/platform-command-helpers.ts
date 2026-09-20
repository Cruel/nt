import { CliCommandUsageError } from './commands/errors';

export type ParsedPlatformOptions = Readonly<{
  values: Readonly<Record<string, string>>;
  flags: ReadonlySet<string>;
}>;

export function parsePlatformOptions(
  arguments_: readonly string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[],
): ParsedPlatformOptions {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index]!;
    if (valueOptions.includes(option)) {
      if (values[option] !== undefined)
        throw new CliCommandUsageError(`Option '${option}' may be supplied only once.`);
      const value = arguments_[index + 1];
      if (!value || value.startsWith('--'))
        throw new CliCommandUsageError(`Option '${option}' requires a value.`);
      values[option] = value;
      index += 1;
    } else if (flagOptions.includes(option)) {
      if (flags.has(option))
        throw new CliCommandUsageError(`Option '${option}' may be supplied only once.`);
      flags.add(option);
    } else {
      throw new CliCommandUsageError(`Unknown command option '${option}'.`);
    }
  }
  return { values, flags };
}

export function parsePlatformTemplateToken(token: string): string {
  const match = /^([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+)$/.exec(token);
  if (!match)
    throw new CliCommandUsageError(`Invalid template identity '${token}'; expected <id>@<build>.`);
  return `${match[1]}/${match[2]}`;
}
