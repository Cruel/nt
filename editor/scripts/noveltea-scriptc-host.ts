/* oxlint-disable typescript/no-explicit-any -- ScriptC static lowering requires erased native JSON boundary shapes here; unknown/union forms force this fast path into the dynamic island. */
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  NOVELTEA_CLI_BUILD_IDENTITY,
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
let cachedStdin: string | null = null;
let forceRuntimeCacheRebuild = false;

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
  if (operation === 'read-stdin') {
    if (cachedStdin === null) cachedStdin = readFileSync(0, 'utf8');
    return cachedStdin;
  }
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

function nativeTexturec(arguments_: readonly string[]): number {
  const response = invokeHost('texturec', JSON.stringify(arguments_));
  const prefix = '{"exitCode":';
  if (!response.startsWith(prefix) || !response.endsWith('}'))
    throw new Error(`Native texturec returned invalid response '${response}'.`);
  const exitCode = Number(response.slice(prefix.length, -1));
  if (!Number.isSafeInteger(exitCode) || exitCode < 0)
    throw new Error(`Native texturec returned invalid exit code '${String(exitCode)}'.`);
  return exitCode;
}

type StaticDiagnostic = Readonly<{
  code: string;
  severity: 'info' | 'warning' | 'error';
  path: string;
  message: string;
  sourceUrl?: string;
  line?: number;
  column?: number;
}>;

function staticRuntimeCacheObservation(probe: any): Readonly<Record<string, unknown>> {
  const observation: Record<string, unknown> = {
    status: 'hit',
    reason: typeof probe?.reason === 'string' ? probe.reason : 'current-generation-valid',
  };
  if (typeof probe?.testCatalogStatus === 'string')
    observation.testCatalogStatus = probe.testCatalogStatus;
  if (typeof probe?.testCatalogReason === 'string')
    observation.testCatalogReason = probe.testCatalogReason;
  return observation;
}

function staticAuthoringDiagnostics(probe: any): StaticDiagnostic[] {
  const source: any = probe?.diagnostics;
  const diagnostics: StaticDiagnostic[] = [];
  if (!source || typeof source.length !== 'number') return diagnostics;
  for (const value of source) {
    if (!value || typeof value !== 'object') continue;
    if (
      typeof value.code !== 'string' ||
      typeof value.path !== 'string' ||
      typeof value.message !== 'string'
    )
      continue;
    diagnostics.push({
      code: value.code,
      severity:
        value.severity === 'warning' || value.severity === 'info' ? value.severity : 'error',
      path: value.path,
      message: value.message,
    });
  }
  return diagnostics;
}

function formatStaticUsageError(json: boolean, message: string): HostResult {
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
  return [2, '', `[error] CLI_USAGE /: ${message}\n${message}\n\n${NOVELTEA_CLI_HELP.trimEnd()}\n`];
}

function compareStaticText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareStaticDiagnostic(left: StaticDiagnostic, right: StaticDiagnostic): number {
  return (
    compareStaticText(left.code, right.code) ||
    compareStaticText(left.path, right.path) ||
    compareStaticText(left.sourceUrl ?? '', right.sourceUrl ?? '') ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.column ?? 0) - (right.column ?? 0) ||
    compareStaticText(left.message, right.message)
  );
}

function formatStaticCommand(
  json: boolean,
  success: boolean,
  exitCode: number,
  projectRoot: string,
  diagnostics: readonly StaticDiagnostic[],
  fields: Readonly<Record<string, unknown>>,
  successMessage: string,
  failureMessageOverride: string | null = null,
): HostResult {
  const sorted = [...diagnostics].sort(compareStaticDiagnostic);
  const envelope: any = {
    success,
    exitCode,
    diagnostics: sorted,
    projectRoot,
  };
  if (fields.native !== undefined) envelope.native = fields.native;
  if (fields.runtimeCache !== undefined) envelope.runtimeCache = fields.runtimeCache;
  envelope.protocolVersion = NOVELTEA_CLI_JSON_PROTOCOL_VERSION;
  if (json) return [exitCode, `${JSON.stringify(envelope)}\n`, ''];
  const diagnosticText = sorted
    .map((item) => `[${item.severity}] ${item.code} ${item.path}: ${item.message}`)
    .join('\n');
  if (success)
    return [
      exitCode,
      successMessage ? `${successMessage}\n` : '',
      diagnosticText ? `${diagnosticText}\n` : '',
    ];
  const defaultFailureMessage =
    sorted.find((item) => item.severity === 'error')?.message ?? 'Command failed.';
  const failureMessage = failureMessageOverride ?? defaultFailureMessage;
  return [exitCode, '', `${[diagnosticText, failureMessage].filter(Boolean).join('\n')}\n`];
}

function staticNativeFailureDiagnostics(
  response: any,
  fallbackCode: string,
  fallbackPath: string,
): StaticDiagnostic[] {
  const diagnostics: StaticDiagnostic[] = [];
  if (response && response.diagnostics && typeof response.diagnostics.length === 'number') {
    for (const raw of response.diagnostics) {
      const value: any = raw && typeof raw === 'object' ? raw : {};
      diagnostics.push({
        code: typeof value.code === 'string' ? `native.${value.code}` : fallbackCode,
        severity:
          value.severity === 'warning' || value.severity === 'info' ? value.severity : 'error',
        path: typeof value.path === 'string' ? value.path : fallbackPath,
        message:
          typeof value.message === 'string'
            ? value.message
            : typeof response.error === 'string'
              ? response.error
              : 'Native operation failed.',
      });
    }
  }
  if (diagnostics.length === 0)
    diagnostics.push({
      code: fallbackCode,
      severity: 'error',
      path: fallbackPath,
      message: typeof response?.error === 'string' ? response.error : 'Native operation failed.',
    });
  return diagnostics;
}

function cachedPayloadAdmissionFailure(response: any, includeCatalog: boolean): boolean {
  if (response?.compiledProjectAdmissionRejected === true) return true;
  const message = typeof response?.error === 'string' ? response.error : '';
  if (
    message.startsWith('Compiled project validation failed') ||
    message.startsWith('Compiled runtime load failed') ||
    message.startsWith('Compiled runtime startup failed')
  )
    return true;
  if (!includeCatalog) return false;
  return (
    message.startsWith('Playback spec parse failed') ||
    message.startsWith('UI click playback input requires') ||
    message.startsWith('Request requires current lowered test catalog') ||
    message.startsWith('Lowered test catalog') ||
    message.startsWith('Blocked test catalog entry') ||
    message.startsWith('Runnable test catalog entry')
  );
}

function parseNativeResponse(operation: string, request: any): any {
  const parsed: any = JSON.parse(invokeHost(operation, JSON.stringify(request)));
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function staticProjectCommand(argv: readonly string[]): any {
  let json = false;
  let projectRoot: string | null = null;
  let index = 0;
  while (index < argv.length && argv[index]!.startsWith('--')) {
    const argument = argv[index]!;
    if (argument === '--json') {
      if (json) return null;
      json = true;
      index += 1;
      continue;
    }
    if (argument === '--project') {
      if (projectRoot !== null) return null;
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return null;
      projectRoot = resolve(process.cwd(), value);
      index += 2;
      continue;
    }
    return null;
  }
  return { json, root: projectRoot ?? process.cwd(), index };
}

function staticValidationPath(argv: readonly string[]): HostResult | null {
  const parsed: any = staticProjectCommand(argv);
  if (!parsed) return null;
  const index: number = parsed.index;
  if (argv[index] !== 'validate' || argv.length !== index + 1) return null;
  try {
    const probe: any = parseNativeResponse('authoring-cache-probe', {
      projectRoot: parsed.root,
      buildIdentity: `${NOVELTEA_CLI_VERSION}:${NOVELTEA_CLI_BUILD_IDENTITY}`,
    });
    trace(`authoring cache ${probe?.status ?? 'unusable'}: ${probe?.reason ?? 'probe-failed'}`);
    if (!probe || probe.ok !== true || probe.status !== 'hit') return null;
    const result: any = probe.result;
    const diagnostics: StaticDiagnostic[] = [];
    for (const item of result.diagnostics) {
      const diagnostic: any = {
        code: item.code,
        severity: item.severity,
        path: item.path,
        message: item.message,
      };
      if (item.sourceUrl !== undefined) diagnostic.sourceUrl = item.sourceUrl;
      if (item.line !== undefined) diagnostic.line = item.line;
      if (item.column !== undefined) diagnostic.column = item.column;
      diagnostics.push(diagnostic);
    }
    trace('authoring cache hit: static/native validate path admitted');
    return formatStaticCommand(
      parsed.json,
      result.success,
      result.exitCode,
      parsed.root,
      diagnostics,
      {},
      'NovelTea validate succeeded.',
      diagnostics[0]?.message ?? 'Command failed.',
    );
  } catch {
    trace('authoring cache unusable: probe-failed');
    return null;
  }
}

function staticTestPath(argv: readonly string[]): HostResult | null {
  const parsed: any = staticProjectCommand(argv);
  if (!parsed) return null;
  const index: number = parsed.index;
  const json: boolean = parsed.json;
  if (argv[index] !== 'test') return null;
  const operation = argv[index + 1];
  const trailing = argv.slice(index + 2);
  const single = operation === 'run' && trailing.length === 1;
  const suite = operation === 'run' && trailing.length === 0;
  const stdinRuntime = operation === 'run-spec' && trailing.length === 0;
  const stdinUi = operation === 'run-ui-spec' && trailing.length === 0;
  if (!single && !suite && !stdinRuntime && !stdinUi) return null;

  // Implicit native discovery is deliberately root-only. Upward discovery remains owned by the
  // canonical TypeScript workspace path whenever cwd is not itself the intended Project root.
  const root: string = parsed.root;
  const compilerIdentity = `${NOVELTEA_CLI_VERSION}:${NOVELTEA_CLI_BUILD_IDENTITY}`;
  trace(`runtime cache probe compiler identity: ${compilerIdentity}`);
  const probe: any = parseNativeResponse('runtime-cache-probe', {
    projectRoot: root,
    compilerIdentity,
  });
  if (!probe || probe.ok !== true || probe.status !== 'hit') {
    trace(`runtime cache ${probe?.status ?? 'unusable'}: ${probe?.reason ?? 'probe-failed'}`);
    return null;
  }
  const compiledProject: any = probe.artifact?.compiledProject;
  if (!compiledProject) {
    trace('runtime cache unusable: admitted runtime artifact missing');
    return null;
  }
  const needsCatalog = single || suite;
  if (
    needsCatalog &&
    (probe.testCatalogStatus !== 'hit' ||
      !probe.catalog ||
      !probe.catalog.entries ||
      typeof probe.catalog.entries.length !== 'number')
  ) {
    trace(
      `runtime cache hit but test catalog ${probe.testCatalogStatus ?? 'unusable'}: ${probe.testCatalogReason ?? 'catalog-unavailable'}`,
    );
    return null;
  }
  const entries: any[] = needsCatalog ? probe.catalog.entries : [];
  const shaderMaterialMetadata: any = probe.artifact?.shaderMaterialMetadata ?? null;
  const authoringDiagnostics = staticAuthoringDiagnostics(probe);
  trace('runtime cache hit: static/native test path admitted');

  let nativeResponse: any = null;
  let successMessage = '';
  let cachedCatalogPayload = false;
  const fields: any = { runtimeCache: staticRuntimeCacheObservation(probe) };

  if (single) {
    const testId = trailing[0]!;
    let entry: any = null;
    for (const candidate of entries) {
      if (candidate && typeof candidate === 'object' && candidate.id === testId) {
        entry = candidate;
        break;
      }
    }
    if (!entry)
      return formatStaticCommand(
        json,
        false,
        6,
        root,
        [
          ...authoringDiagnostics,
          {
            code: 'native.test.spec',
            severity: 'error',
            path: `/tests/${testId}`,
            message: 'Test record does not exist.',
          },
        ],
        {},
        '',
      );
    if (entry.status === 'blocked') {
      const source: any[] = entry.diagnostics ?? [];
      const diagnostics: StaticDiagnostic[] = [...authoringDiagnostics];
      for (const value of source) {
        diagnostics.push({
          code: 'native.test.spec',
          severity:
            value?.severity === 'warning' || value?.severity === 'info' ? value.severity : 'error',
          path: typeof value?.path === 'string' ? value.path : `/tests/${testId}`,
          message: typeof value?.message === 'string' ? value.message : 'Test is blocked.',
        });
      }
      return formatStaticCommand(json, false, 6, root, diagnostics, fields, '');
    }
    if (
      entry.status !== 'runnable' ||
      (entry.runner !== 'runtime' && entry.runner !== 'runtime-ui') ||
      entry.spec === undefined
    )
      return null;
    const request: any = { project: compiledProject, spec: entry.spec };
    if (entry.runner === 'runtime-ui') {
      request.projectRoot = root;
      request.shaderMaterialMetadata = shaderMaterialMetadata;
    }
    nativeResponse = parseNativeResponse(
      entry.runner === 'runtime-ui' ? 'run-ui-test' : 'run-test',
      request,
    );
    cachedCatalogPayload = true;
    successMessage = `NovelTea test run ${testId} succeeded.`;
  } else if (suite) {
    nativeResponse = parseNativeResponse('run-test-suite', {
      project: compiledProject,
      catalog: probe.catalog,
      projectRoot: root,
      shaderMaterialMetadata,
    });
  } else {
    const stdinText = invokeHost('read-stdin', '');
    if (!stdinText || stdinText.trim() === '')
      return formatStaticUsageError(json, 'Command requires one UTF-8 JSON value on stdin.');
    let spec: any;
    try {
      spec = JSON.parse(stdinText);
    } catch {
      return null;
    }
    const request: any = { project: compiledProject, spec };
    if (stdinUi) {
      request.projectRoot = root;
      request.shaderMaterialMetadata = shaderMaterialMetadata;
    }
    nativeResponse = parseNativeResponse(stdinUi ? 'run-ui-test' : 'run-test', request);
    successMessage = `NovelTea test ${stdinUi ? 'run-ui-spec' : 'run-spec'} succeeded.`;
  }

  if (!nativeResponse || nativeResponse.ok !== true) {
    if (suite || cachedPayloadAdmissionFailure(nativeResponse, cachedCatalogPayload)) {
      forceRuntimeCacheRebuild = true;
      trace('cached payload rejected; forced canonical retry');
      return null;
    }
    const diagnostics = [
      ...authoringDiagnostics,
      ...staticNativeFailureDiagnostics(nativeResponse, 'native.operation', '/'),
    ];
    return formatStaticCommand(json, false, 6, root, diagnostics, fields, '');
  }
  fields.native = nativeResponse;

  if (!suite)
    return formatStaticCommand(json, true, 0, root, authoringDiagnostics, fields, successMessage);

  const report: any =
    nativeResponse.report && typeof nativeResponse.report === 'object'
      ? nativeResponse.report
      : null;
  if (!report || !report.entries) {
    forceRuntimeCacheRebuild = true;
    trace('cached payload rejected; forced canonical retry');
    return null;
  }
  const diagnostics: StaticDiagnostic[] = [...authoringDiagnostics];
  for (const raw of report.entries) {
    if (!raw || typeof raw !== 'object') continue;
    const entry: any = raw;
    const id = typeof entry.id === 'string' ? entry.id : 'unknown';
    if (entry.status === 'failed')
      diagnostics.push({
        code: 'native.test.failed',
        severity: 'error',
        path: `/tests/${id}`,
        message: `Test '${id}' failed.`,
      });
    else if (entry.status === 'blocked') {
      const nested: any[] = entry.diagnostics ?? [];
      let promoted = false;
      for (const item of nested) {
        if (!item || typeof item !== 'object' || typeof item.message !== 'string') continue;
        diagnostics.push({
          code: 'native.test.blocked',
          severity: 'warning',
          path: typeof item.path === 'string' ? item.path : `/tests/${id}`,
          message: item.message,
        });
        promoted = true;
      }
      if (!promoted)
        diagnostics.push({
          code: 'native.test.blocked',
          severity: 'warning',
          path: `/tests/${id}`,
          message: `Test '${id}' is blocked and was not executed.`,
        });
    } else if (entry.status === 'error') {
      const nested: any[] = entry.diagnostics ?? [];
      let promoted = false;
      for (const item of nested) {
        if (!item || typeof item !== 'object' || typeof item.message !== 'string') continue;
        diagnostics.push({
          code: 'native.test.error',
          severity: 'error',
          path: typeof item.path === 'string' ? item.path : `/tests/${id}`,
          message: item.message,
        });
        promoted = true;
      }
      if (!promoted)
        diagnostics.push({
          code: 'native.test.error',
          severity: 'error',
          path: `/tests/${id}`,
          message: `Test '${id}' could not execute.`,
        });
    }
  }
  const counts: any = report.counts && typeof report.counts === 'object' ? report.counts : {};
  const count = (key: string) =>
    typeof counts[key] === 'number' && Number.isInteger(counts[key]) ? counts[key] : 0;
  const summary =
    `Test suite: ${count('passed')} passed, ${count('failed')} failed, ` +
    `${count('blocked')} blocked, ${count('error')} errors.`;
  const success = nativeResponse.success !== false;
  if (!success)
    diagnostics.push({
      code: 'native.test.suite.summary',
      severity: 'error',
      path: '/tests',
      message: summary,
    });
  return formatStaticCommand(
    json,
    success,
    success ? 0 : 6,
    root,
    diagnostics,
    fields,
    success ? summary : '',
  );
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
  if (argv[index] === 'shaderc') return [nativeShaderc(argv.slice(index + 1)), '', ''];
  if (argv[index] === 'texturec') return [nativeTexturec(argv.slice(index + 1)), '', ''];
  return null;
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
    const fastPath =
      staticFastPath(argv) ??
      staticValidationPath(argv) ??
      staticTestPath(argv) ??
      staticNativePath(argv);
    if (fastPath !== null) {
      emit(fastPath);
      exitCode = fastPath[0];
    } else {
      trace('dynamic island import starting');
      // @ts-expect-error The private island package is materialized only during release staging.
      const { runNovelTeaScriptcIsland } = await import('noveltea-scriptc-island');
      trace('dynamic island import completed');
      trace('dynamic island invocation starting');
      const responseText = await runNovelTeaScriptcIsland(
        JSON.stringify(argv),
        invokeHost,
        forceRuntimeCacheRebuild,
      );
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
