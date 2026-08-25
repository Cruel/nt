import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NOVELTEA_CLI_HELP,
  NOVELTEA_CLI_JSON_PROTOCOL_VERSION,
  NOVELTEA_CLI_VERSION,
} from '../src/cli/static-contracts';
import { runNovelTeaScriptcProcess } from './noveltea-scriptc-process';

declare function nativeInvokeToFile(
  operation: string,
  requestText: string,
  responsePath: string,
): void;

type HostResult = readonly [exitCode: number, stdout: string, stderr: string];

let nativeCallSequence = 0;
let nativeResponseRoot: string | null = null;

function trace(message: string): void {
  if (process.env.NOVELTEA_CLI_TRACE === '1') process.stderr.write(`[scriptc-host] ${message}\n`);
}

function getNativeResponseRoot(): string {
  if (nativeResponseRoot === null)
    nativeResponseRoot = mkdtempSync(join(tmpdir(), 'noveltea-scriptc-'));
  return nativeResponseRoot;
}

function processAlive(requestText: string): string {
  const pid = Number(requestText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'null';
  try {
    process.kill(pid, 0);
    return 'true';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? 'false' : code === 'EPERM' ? 'true' : 'null';
  }
}

function invokeHost(operation: string, requestText: string): string {
  if (operation === 'process-alive') return processAlive(requestText);
  if (operation === 'read-stdin') return readFileSync(0, 'utf8');
  if (operation === 'run-process') return runNovelTeaScriptcProcess(requestText);

  const responsePath = join(getNativeResponseRoot(), `${nativeCallSequence}.json`);
  nativeCallSequence += 1;
  try {
    nativeInvokeToFile(operation, requestText, responsePath);
    return readFileSync(responsePath, 'utf8');
  } finally {
    try {
      unlinkSync(responsePath);
    } catch {
      // The native adapter may fail before materializing a response file.
    }
  }
}

function nativeShaderc(arguments_: readonly string[]): number {
  const response = invokeHost('shaderc', JSON.stringify(arguments_));
  const prefix = '{"exitCode":';
  if (!response.startsWith(prefix) || !response.endsWith('}'))
    throw new Error(`Native shaderc returned invalid response '${response}'.`);
  const exitCode = Number(response.slice(prefix.length, -1));
  if (!Number.isSafeInteger(exitCode) || exitCode < 0)
    throw new Error(`Native shaderc returned invalid exit code '${String(exitCode)}'.`);
  return exitCode;
}

function staticNativePath(argv: readonly string[]): HostResult | null {
  let project = false;
  let index = 0;
  while (index < argv.length && argv[index]!.startsWith('--')) {
    const argument = argv[index]!;
    if (argument !== '--project' || project) return null;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) return null;
    project = true;
    index += 2;
  }
  if (argv[index] !== 'shaderc') return null;
  return [nativeShaderc(argv.slice(index + 1)), '', ''];
}

function staticFastPath(argv: readonly string[]): HostResult | null {
  let json = false;
  let help = false;
  let version = false;
  let project = false;
  let index = 0;

  while (index < argv.length) {
    const argument = argv[index]!;
    if (argument === '--json') {
      if (json) return null;
      json = true;
      index += 1;
      continue;
    }
    if (argument === '--project') {
      if (project) return null;
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return null;
      project = true;
      index += 2;
      continue;
    }
    if (argument === '--help') {
      if (help) return null;
      help = true;
      index += 1;
      continue;
    }
    if (argument === '--version') {
      if (version) return null;
      version = true;
      index += 1;
      continue;
    }
    return null;
  }

  if (!help && !version) {
    const message = 'A command is required.';
    if (json)
      return [
        2,
        `${JSON.stringify({
          success: false,
          exitCode: 2,
          diagnostics: [{ code: 'CLI_USAGE', severity: 'error', path: '/', message }],
          protocolVersion: NOVELTEA_CLI_JSON_PROTOCOL_VERSION,
        })}\n`,
        '',
      ];
    return [
      2,
      '',
      `[error] CLI_USAGE /: ${message}\n${message}\n\n${NOVELTEA_CLI_HELP.trimEnd()}\n`,
    ];
  }
  if (help === version) return null;
  if (help) {
    const stdout = json
      ? `${JSON.stringify({
          success: true,
          exitCode: 0,
          diagnostics: [],
          help: NOVELTEA_CLI_HELP,
          protocolVersion: NOVELTEA_CLI_JSON_PROTOCOL_VERSION,
        })}\n`
      : NOVELTEA_CLI_HELP;
    return [0, stdout, ''];
  }

  const stdout = json
    ? `${JSON.stringify({
        success: true,
        exitCode: 0,
        diagnostics: [],
        version: NOVELTEA_CLI_VERSION,
        protocolVersion: NOVELTEA_CLI_JSON_PROTOCOL_VERSION,
      })}\n`
    : `${NOVELTEA_CLI_VERSION}\n`;
  return [0, stdout, ''];
}

function emit(result: HostResult): void {
  const stdoutText = result[1];
  const stderrText = result[2];
  if (stdoutText.length > 0) process.stdout.write(stdoutText);
  if (stderrText.length > 0) process.stderr.write(stderrText);
}

async function main(): Promise<void> {
  let exitCode = 70;
  try {
    // scriptc's argv slice throws when the process has no user arguments.
    const argv = process.argv.length > 2 ? process.argv.slice(2) : [];
    const fastPath = staticFastPath(argv) ?? staticNativePath(argv);
    if (fastPath !== null) {
      emit(fastPath);
      exitCode = fastPath[0];
    } else {
      trace('dynamic island import starting');
      // @ts-expect-error The private island package is materialized only during release staging.
      const { runNovelTeaScriptcIsland } = await import('noveltea-scriptc-island');
      trace('dynamic island import completed');
      trace('dynamic island invocation starting');
      const responseText = await runNovelTeaScriptcIsland(JSON.stringify(argv), invokeHost);
      trace('dynamic island invocation completed');
      const response = JSON.parse(responseText) as [number, string, string];
      emit(response);
      exitCode = response[0];
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    if (nativeResponseRoot !== null) rmSync(nativeResponseRoot, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

void main();
