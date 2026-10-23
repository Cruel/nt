/** Shared CLI grammar only; importing these parsers never loads TypeScript
 * Project source readers, creation, or bundle authority. */
export function parseProjectCreate(command: readonly string[]) {
  const directory = command[2];
  let name: string | undefined;
  if (!directory || directory.startsWith('--')) throw new Error('Project directory is required.');
  for (let index = 3; index < command.length; index += 1) {
    if (command[index] !== '--name') throw new Error(`Unknown command option '${command[index]}'.`);
    const value = command[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error("Option '--name' requires a project name.");
    if (name !== undefined) throw new Error("Option '--name' may be supplied only once.");
    name = value;
    index += 1;
  }
  if (name === undefined) throw new Error("Required option '--name' was not supplied.");
  return { directory, name };
}

export function parseProjectExport(command: readonly string[]): { output: string } {
  let output: string | undefined;
  for (let index = 2; index < command.length; index += 1) {
    const argument = command[index];
    if (argument !== '--output') throw new Error(`Unknown command option '${argument}'.`);
    const value = command[index + 1];
    if (!value || value.startsWith('--')) throw new Error("Option '--output' requires a path.");
    if (output !== undefined) throw new Error("Option '--output' may be supplied only once.");
    output = value;
    index += 1;
  }
  if (output === undefined) throw new Error("Required option '--output' was not supplied.");
  return { output };
}

export function parseProjectImport(command: readonly string[]): {
  bundle: string;
  destination: string;
} {
  if (command.length !== 4)
    throw new Error('Usage: noveltea project import <bundle.ntproject> <destination-directory>.');
  const bundle = command[2];
  const destination = command[3];
  if (!bundle || bundle.startsWith('--'))
    throw new Error('Portable Project bundle path is required.');
  if (!destination || destination.startsWith('--'))
    throw new Error('Project destination directory is required.');
  return { bundle, destination };
}
