import { randomUUID } from 'node:crypto';
import { promises as nodeFileSystem } from 'node:fs';
import path from 'node:path';
import type { CompilerStageReport } from '../shared/authoring-compiler';
import { publishCompiledArtifact } from '../shared/compiled-artifact-publication';
import type { CompiledDiagnostic } from '../shared/project-schema/compiled-project';

export const compileProjectUsage = `Usage: pnpm project:compile -- --project <file> --output <file> [--json]\n\nOptions:\n  --project <file>  Saved NovelTea project JSON file.\n  --output <file>   Destination for canonical compiled project JSON.\n  --json            Emit a structured command report as JSON.\n  --help            Print this help and exit successfully.\n`;

export const compileProjectExitCodes = {
  success: 0,
  arguments: 2,
  input: 3,
  compiler: 4,
  output: 5,
} as const;

export type CompileProjectExitCode =
  (typeof compileProjectExitCodes)[keyof typeof compileProjectExitCodes];

export type CompileProjectCommandDiagnosticCode =
  | 'PROJECT_COMPILE_ARGUMENTS'
  | 'PROJECT_COMPILE_INPUT_READ'
  | 'PROJECT_COMPILE_INPUT_JSON'
  | 'PROJECT_COMPILE_OUTPUT_CONFLICT'
  | 'PROJECT_COMPILE_OUTPUT_WRITE';

export type CompileProjectArguments =
  | Readonly<{
      help: true;
      json: boolean;
    }>
  | Readonly<{
      help: false;
      json: boolean;
      projectPath: string;
      outputPath: string;
    }>;

export interface CompileProjectCommandReport {
  success: boolean;
  projectPath: string;
  outputPath: string;
  bytesWritten?: number;
  diagnostics: readonly CompiledDiagnostic[];
  stages: readonly CompilerStageReport[];
}

export interface CompileProjectCommandResult {
  exitCode: CompileProjectExitCode;
  report: CompileProjectCommandReport;
  stdout: string;
  stderr: string;
}

export interface CompileProjectFileSystem {
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  stat(filePath: string): Promise<{ isFile(): boolean }>;
  mkdir(directoryPath: string, options: { recursive: true }): Promise<unknown>;
  writeFile(
    filePath: string,
    data: string,
    options: { encoding: 'utf8'; flag: 'wx' },
  ): Promise<unknown>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(filePath: string, options: { force: true }): Promise<void>;
}

export interface RunCompileProjectCommandOptions {
  cwd?: string;
  fileSystem?: CompileProjectFileSystem;
  temporaryPathFactory?: (outputPath: string) => string;
}

export class CompileProjectArgumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileProjectArgumentsError';
  }
}

function optionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new CompileProjectArgumentsError(`${option} requires a value.`);
  }
  return value;
}

export function parseCompileProjectArguments(argv: readonly string[]): CompileProjectArguments {
  let projectPath: string | undefined;
  let outputPath: string | undefined;
  let json = false;
  let help = false;
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) {
      throw new CompileProjectArgumentsError(`Unexpected positional argument '${argument}'.`);
    }
    if (!['--project', '--output', '--json', '--help'].includes(argument)) {
      throw new CompileProjectArgumentsError(`Unknown option '${argument}'.`);
    }
    if (seen.has(argument)) {
      throw new CompileProjectArgumentsError(`Option '${argument}' may be provided only once.`);
    }
    seen.add(argument);

    if (argument === '--project') {
      projectPath = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === '--output') {
      outputPath = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === '--json') {
      json = true;
    } else {
      help = true;
    }
  }

  if (help) return { help: true, json };
  if (!projectPath || !outputPath) {
    const missing = [!projectPath ? '--project' : null, !outputPath ? '--output' : null].filter(
      (value): value is string => value !== null,
    );
    throw new CompileProjectArgumentsError(
      `Missing required option${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
    );
  }
  return { help: false, json, projectPath, outputPath };
}

function commandDiagnostic(
  code: CompileProjectCommandDiagnosticCode,
  jsonPointer: string,
  message: string,
): CompiledDiagnostic {
  const sourcePath = 'project-compile';
  return {
    code,
    severity: 'error',
    sourcePath,
    jsonPointer,
    message,
    sortKey: { code, sourcePath, jsonPointer },
  };
}

function report(
  success: boolean,
  projectPath: string,
  outputPath: string,
  diagnostics: readonly CompiledDiagnostic[],
  stages: readonly CompilerStageReport[],
  bytesWritten?: number,
): CompileProjectCommandReport {
  return {
    success,
    projectPath,
    outputPath,
    ...(bytesWritten === undefined ? {} : { bytesWritten }),
    diagnostics,
    stages,
  };
}

function formatDiagnostics(diagnostics: readonly CompiledDiagnostic[]): string {
  if (diagnostics.length === 0) return '';
  return `${diagnostics
    .map(
      (diagnostic) =>
        `[${diagnostic.severity}] ${diagnostic.code} ${diagnostic.jsonPointer}: ${diagnostic.message}`,
    )
    .join('\n')}\n`;
}

function formatResult(
  resultReport: CompileProjectCommandReport,
  exitCode: CompileProjectExitCode,
  json: boolean,
  options: { help?: boolean; includeUsage?: boolean } = {},
): CompileProjectCommandResult {
  if (options.help) {
    if (json) {
      return {
        exitCode,
        report: resultReport,
        stdout: `${JSON.stringify({ ...resultReport, help: true, exitCode })}\n`,
        stderr: '',
      };
    }
    return { exitCode, report: resultReport, stdout: compileProjectUsage, stderr: '' };
  }

  if (json) {
    return {
      exitCode,
      report: resultReport,
      stdout: `${JSON.stringify({ ...resultReport, exitCode })}\n`,
      stderr: '',
    };
  }

  if (resultReport.success) {
    const bytes = resultReport.bytesWritten ?? 0;
    return {
      exitCode,
      report: resultReport,
      stdout: `Compiled project: ${resultReport.projectPath} -> ${resultReport.outputPath} (${bytes} bytes)\n`,
      stderr: formatDiagnostics(resultReport.diagnostics),
    };
  }

  return {
    exitCode,
    report: resultReport,
    stdout: '',
    stderr: `${formatDiagnostics(resultReport.diagnostics)}${options.includeUsage ? compileProjectUsage : ''}`,
  };
}

function temporaryPathFor(outputPath: string): string {
  return path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
}

async function writeCanonicalArtifact(
  fileSystem: CompileProjectFileSystem,
  outputPath: string,
  canonicalJson: string,
  temporaryPathFactory: (outputPath: string) => string,
): Promise<void> {
  const temporaryPath = temporaryPathFactory(outputPath);
  try {
    await fileSystem.mkdir(path.dirname(outputPath), { recursive: true });
    await fileSystem.writeFile(temporaryPath, canonicalJson, { encoding: 'utf8', flag: 'wx' });
    await fileSystem.rename(temporaryPath, outputPath);
  } catch (error) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runCompileProjectCommand(
  argv: readonly string[],
  options: RunCompileProjectCommandOptions = {},
): Promise<CompileProjectCommandResult> {
  const requestedJson = argv.includes('--json');
  let argumentsValue: CompileProjectArguments;
  try {
    argumentsValue = parseCompileProjectArguments(argv);
  } catch (error) {
    const diagnostic = commandDiagnostic('PROJECT_COMPILE_ARGUMENTS', '/', errorMessage(error));
    return formatResult(
      report(false, '', '', [diagnostic], []),
      compileProjectExitCodes.arguments,
      requestedJson,
      {
        includeUsage: true,
      },
    );
  }

  if (argumentsValue.help) {
    return formatResult(
      report(true, '', '', [], []),
      compileProjectExitCodes.success,
      argumentsValue.json,
      {
        help: true,
      },
    );
  }

  const cwd = options.cwd ?? process.env.INIT_CWD ?? process.cwd();
  const projectPath = path.resolve(cwd, argumentsValue.projectPath);
  const outputPath = path.resolve(cwd, argumentsValue.outputPath);
  const json = argumentsValue.json;
  if (projectPath === outputPath) {
    const diagnostic = commandDiagnostic(
      'PROJECT_COMPILE_OUTPUT_CONFLICT',
      '/output',
      'The compiled project output path must differ from the source project path.',
    );
    return formatResult(
      report(false, projectPath, outputPath, [diagnostic], []),
      compileProjectExitCodes.output,
      json,
    );
  }

  const fileSystem = options.fileSystem ?? nodeFileSystem;
  let source: string;
  try {
    const inputStat = await fileSystem.stat(projectPath);
    if (!inputStat.isFile()) throw new Error('The project path is not a file.');
    source = await fileSystem.readFile(projectPath, 'utf8');
  } catch (error) {
    const diagnostic = commandDiagnostic(
      'PROJECT_COMPILE_INPUT_READ',
      '/project',
      `Unable to read project file '${projectPath}': ${errorMessage(error)}`,
    );
    return formatResult(
      report(false, projectPath, outputPath, [diagnostic], []),
      compileProjectExitCodes.input,
      json,
    );
  }

  let project: unknown;
  try {
    project = JSON.parse(source) as unknown;
  } catch (error) {
    const diagnostic = commandDiagnostic(
      'PROJECT_COMPILE_INPUT_JSON',
      '/project',
      `Project file '${projectPath}' is not valid JSON: ${errorMessage(error)}`,
    );
    return formatResult(
      report(false, projectPath, outputPath, [diagnostic], []),
      compileProjectExitCodes.input,
      json,
    );
  }

  const published = publishCompiledArtifact(project);
  if (!published.ok) {
    return formatResult(
      report(false, projectPath, outputPath, published.diagnostics, published.stages),
      compileProjectExitCodes.compiler,
      json,
    );
  }

  const canonicalJson = published.project.gameplayJson;
  try {
    await writeCanonicalArtifact(
      fileSystem,
      outputPath,
      canonicalJson,
      options.temporaryPathFactory ?? temporaryPathFor,
    );
  } catch (error) {
    const diagnostic = commandDiagnostic(
      'PROJECT_COMPILE_OUTPUT_WRITE',
      '/output',
      `Unable to publish compiled project '${outputPath}': ${errorMessage(error)}`,
    );
    return formatResult(
      report(
        false,
        projectPath,
        outputPath,
        [...published.diagnostics, diagnostic],
        published.stages,
      ),
      compileProjectExitCodes.output,
      json,
    );
  }

  const bytesWritten = Buffer.byteLength(canonicalJson, 'utf8');
  return formatResult(
    report(true, projectPath, outputPath, published.diagnostics, published.stages, bytesWritten),
    compileProjectExitCodes.success,
    json,
  );
}
