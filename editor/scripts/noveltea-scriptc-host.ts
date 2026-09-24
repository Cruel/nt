/* oxlint-disable typescript/no-explicit-any -- ScriptC static lowering requires erased native JSON boundary shapes here; unknown/union forms force this fast path into the dynamic island. */
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  NOVELTEA_CLI_BUILD_IDENTITY,
  NOVELTEA_CLI_HELP,
  NOVELTEA_CLI_JSON_PROTOCOL_VERSION,
  NOVELTEA_CLI_VERSION,
  NOVELTEA_DAEMON_PROTOCOL_VERSION,
  NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY,
} from '../src/cli/static-contracts';
import { classifyNovelTeaCliCommand, type CliCommandRouting } from '../src/cli/command-routing';
import { runNovelTeaScriptcProcess } from './noveltea-scriptc-process';

declare function nativeInvokeToFile(
  operation: string,
  requestText: string,
  responsePath: string,
): void;
declare function nativeRunQuickJsGc(): void;
declare function nativeSetQuickJsGcThreshold(thresholdBytes: number): void;

type HostResult = readonly [exitCode: number, stdout: string, stderr: string];
type RequestOutputCapture = { stdout: string; stderr: string };
type DaemonProjectDiscoveryScope = Readonly<{
  root: string;
  extensions: readonly string[];
  excludedPrefixes: readonly string[];
}>;
type DaemonProjectAuthorityConfiguration = Readonly<{
  projectRoot: string;
  authoritativePaths: readonly string[];
  discoveryScopes: readonly DaemonProjectDiscoveryScope[];
}>;
type CapturedNativeEnvelope = Readonly<{
  captureOk: boolean;
  response: string;
  stdout: string;
  stderr: string;
}>;

let nativeCallSequence = 0;
let nativeResponseRoot: string | null = null;
let cachedStdin: string | null = null;
let forceRuntimeCacheRebuild = false;
let daemonRequestSequence = 0;
// QuickJS defaults to a tiny automatic-GC threshold that can put a full collection on a
// foreground owner request. This is an emergency trigger, not reserved memory: active owners
// collect explicitly after 200 ms of real idle, while a sustained no-idle burst still falls back
// to automatic GC once allocation pressure reaches this threshold.
const residentQuickJsGcThresholdBytes = 1024 * 1024 * 1024;
const residentProjectAuthorityRequests = new Map<string, DaemonProjectAuthorityConfiguration>();

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

function invokePrivateInternalHost(operation: string, requestText: string): string {
  if (operation === 'process-alive' || operation === 'read-stdin' || operation === 'run-process')
    return invokeHost(operation, requestText);

  const envelope = JSON.parse(
    invokeHost(`capture:${operation}`, requestText),
  ) as CapturedNativeEnvelope;
  if (envelope.captureOk !== true)
    throw new Error(`failed to capture private native operation '${operation}' output`);
  if (envelope.stdout) process.stderr.write(envelope.stdout);
  if (envelope.stderr) process.stderr.write(envelope.stderr);
  return envelope.response;
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
      semanticKey: NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY,
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
    const request: any = {
      project: compiledProject,
      spec: entry.spec,
      projectRoot: root,
      shaderMaterialMetadata,
    };
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
    const request: any = {
      project: compiledProject,
      spec,
      projectRoot: root,
      shaderMaterialMetadata,
    };
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

type DaemonRequestContext = Readonly<{
  argv: readonly string[];
  executionClass: CliCommandRouting['executionClass'];
  cwd: string;
  ownerProjectRoot: string | null;
  ownerProjectRootExplicit: boolean;
  environment: Readonly<Record<string, string>>;
  stdinText?: string | null;
  terminal?: Readonly<{
    stdin: boolean;
    stdout: boolean;
    stderr: boolean;
    columns: number | null;
    rows: number | null;
  }>;
  outputMode: 'json' | 'human';
  replaySafe: boolean;
  streamedEvents: boolean;
  forceRuntimeCacheRebuild: boolean;
  authoringValidationSemanticKey: string;
  internalOperation?: string;
  internalRequestText?: string;
}>;

type DaemonRetainedValidationResult = Readonly<{
  success: boolean;
  exitCode: number;
  diagnostics: readonly StaticDiagnostic[];
}>;

type DaemonNativeResponse = Readonly<{
  ok?: boolean;
  running?: boolean;
  state?: string;
  build?: string;
  protocol?: number;
  pid?: number | null;
  stopped?: boolean;
  idle?: boolean;
  prepareDisposable?: boolean;
  needsReconcile?: boolean;
  started?: boolean;
  error?: string;
  token?: number;
  requestId?: string;
  method?: string;
  payload?: DaemonRequestContext;
  result?: HostResult | null;
  retainedValidationResult?: DaemonRetainedValidationResult | null;
  active?: boolean;
  cancelled?: boolean;
  delivered?: boolean;
  allowed?: boolean;
  projectSessions?: number;
  disposableWorkers?: number;
  disposableQueuedJobs?: number;
  disposableStandbyWorkers?: number;
  disposableBusyWorkers?: number;
  authority?: string;
  previousAuthority?: string;
  unchanged?: boolean;
  fullRescan?: boolean;
  watcherPaths?: readonly string[];
  delta?: Readonly<{
    added?: readonly string[];
    changed?: readonly string[];
    removed?: readonly string[];
  }>;
  manifest?: Readonly<{
    canonicalRoot?: string;
    entries?: readonly Readonly<{
      path?: string;
      sourceIdentity?: string;
      byteSize?: number;
      mtimeNanoseconds?: string | null;
      contentHash?: string | null;
    }>[];
  }>;
  found?: boolean;
  canonicalRoot?: string;
  coldSessionEpoch?: number;
  sessionEpoch?: number;
  generation?: number;
  hasProjectSnapshot?: boolean;
  chunkCount?: number;
  ownerMetadata?: string;
  chunk?: string;
  snapshotCount?: number;
  snapshotBytes?: number;
  projectOwnerWorkers?: number;
  projectAuthorities?: number;
  projectSnapshots?: number;
  projectSnapshotBytes?: number;
  exactValidationResults?: number;
  exactValidationBytes?: number;
  engineeringOwnerPids?: readonly number[];
  engineeringOwners?: readonly Readonly<{ canonicalRoot?: string; pid?: number }>[];
  engineeringDisposablePids?: readonly number[];
  engineeringCounters?: Readonly<Record<string, number>>;
}>;

type DaemonStatusCore = Readonly<{
  running: boolean;
  state: string;
  build: string;
  protocol: number;
  pid: number | null;
  projectSessions: number;
  disposableWorkers: number;
  disposableQueuedJobs: number;
  disposableStandbyWorkers: number;
  disposableBusyWorkers: number;
}>;

type DaemonEngineeringSnapshot = Readonly<{
  projectOwnerWorkers: number;
  projectAuthorities: number;
  projectSnapshots: number;
  projectSnapshotBytes: number;
  exactValidationResults: number;
  exactValidationBytes: number;
  ownerPids: readonly number[];
  owners: readonly Readonly<{ canonicalRoot: string; pid: number }>[];
  disposablePids: readonly number[];
  counters: Readonly<Record<string, number>>;
}>;

type DaemonBrokerContext = Readonly<{
  build: string;
  protocol: number;
  daemonIdleMs?: number;
  projectSessionIdleMs?: number;
  disposableExtraIdleMs?: number;
  projectSnapshotBudgetBytes?: number;
  exactValidationBudgetBytes?: number;
  runtimeRoot?: string;
}>;

function currentTerminalContext(): DaemonRequestContext['terminal'] {
  let columns: number | null = null;
  let rows: number | null = null;
  if (process.stdout.isTTY === true) {
    const size = JSON.parse(invokeHost('terminal-size', '')) as {
      columns?: number | null;
      rows?: number | null;
    };
    if (typeof size.columns === 'number' && Number.isSafeInteger(size.columns) && size.columns > 0)
      columns = size.columns;
    if (typeof size.rows === 'number' && Number.isSafeInteger(size.rows) && size.rows > 0)
      rows = size.rows;
  }
  return {
    stdin: process.stdin.isTTY === true,
    stdout: process.stdout.isTTY === true,
    stderr: process.stderr.isTTY === true,
    columns,
    rows,
  };
}

function certificationPositiveInteger(name: string): number | undefined {
  if (process.env.NOVELTEA_CLI_CERTIFICATION !== '1') return undefined;
  const text = process.env[name];
  if (!text) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function daemonBrokerContext(): DaemonBrokerContext {
  const certification = process.env.NOVELTEA_CLI_CERTIFICATION === '1';
  const suffix = certification ? process.env.NOVELTEA_CLI_CERTIFICATION_DAEMON_ID : undefined;
  const runtimeRoot = certification
    ? process.env.NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT
    : undefined;
  return {
    build: suffix ? `${NOVELTEA_CLI_BUILD_IDENTITY}:cert:${suffix}` : NOVELTEA_CLI_BUILD_IDENTITY,
    protocol:
      certificationPositiveInteger('NOVELTEA_CLI_CERTIFICATION_DAEMON_PROTOCOL') ??
      NOVELTEA_DAEMON_PROTOCOL_VERSION,
    daemonIdleMs: certificationPositiveInteger('NOVELTEA_CLI_CERTIFICATION_DAEMON_IDLE_MS'),
    projectSessionIdleMs: certificationPositiveInteger(
      'NOVELTEA_CLI_CERTIFICATION_PROJECT_SESSION_IDLE_MS',
    ),
    disposableExtraIdleMs: certificationPositiveInteger(
      'NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_IDLE_MS',
    ),
    projectSnapshotBudgetBytes: certificationPositiveInteger(
      'NOVELTEA_CLI_CERTIFICATION_PROJECT_SNAPSHOT_BUDGET_BYTES',
    ),
    exactValidationBudgetBytes: certificationPositiveInteger(
      'NOVELTEA_CLI_CERTIFICATION_EXACT_VALIDATION_BUDGET_BYTES',
    ),
    runtimeRoot: runtimeRoot || undefined,
  };
}

function daemonNativeRequest(action: string): DaemonNativeResponse {
  const context = daemonBrokerContext();
  return JSON.parse(
    invokeHost(
      'daemon',
      JSON.stringify({
        ...context,
        action,
      }),
    ),
  ) as DaemonNativeResponse;
}

function daemonEnsureNativeRequest(): DaemonNativeResponse {
  const context = daemonBrokerContext();
  return JSON.parse(
    invokeHost(
      'daemon',
      JSON.stringify({
        ...context,
        action: 'ensure',
        startupTimeoutMs: 2000,
      }),
    ),
  ) as DaemonNativeResponse;
}

function daemonRequestNative(request: DaemonRequestContext): DaemonNativeResponse {
  daemonRequestSequence += 1;
  const context = daemonBrokerContext();
  return JSON.parse(
    invokeHost(
      'daemon',
      JSON.stringify({
        ...context,
        action: 'request',
        requestId: `cli-${String(process.pid)}-${String(Date.now())}-${String(daemonRequestSequence)}`,
        method: 'invoke',
        payload: request,
      }),
    ),
  ) as DaemonNativeResponse;
}

function daemonLogicalProjectRoot(request: DaemonRequestContext): string {
  let candidate = resolve(request.ownerProjectRoot ?? request.cwd);
  if (request.ownerProjectRootExplicit) return candidate;
  for (;;) {
    try {
      const metadata = JSON.parse(
        invokeHost('path-metadata', JSON.stringify({ path: join(candidate, 'project.json') })),
      ) as { ok?: boolean; kind?: string };
      if (metadata.ok === true && metadata.kind !== 'missing') return candidate;
    } catch {
      // The broker already completed canonical discovery. A metadata failure here only prevents
      // caller-side reformatting from walking farther upward; use the current logical nomination.
      return candidate;
    }
    const parent = resolve(candidate, '..');
    if (parent === candidate) return resolve(request.ownerProjectRoot ?? request.cwd);
    candidate = parent;
  }
}

function retainedAuthoringValidationResult(
  value: DaemonRetainedValidationResult,
  request: DaemonRequestContext,
): HostResult {
  const diagnostics: StaticDiagnostic[] = [];
  for (const item of value.diagnostics) {
    const diagnostic: StaticDiagnostic = {
      code: item.code,
      severity: item.severity === 'warning' || item.severity === 'info' ? item.severity : 'error',
      path: item.path,
      message: item.message,
      sourceUrl: item.sourceUrl,
      line: item.line,
      column: item.column,
    };
    diagnostics.push(diagnostic);
  }
  return formatStaticCommand(
    request.outputMode === 'json',
    value.success,
    value.exitCode,
    daemonLogicalProjectRoot(request),
    diagnostics,
    {},
    'NovelTea validate succeeded.',
    diagnostics[0]?.message ?? 'Command failed.',
  );
}

function daemonStatusCore(result: DaemonNativeResponse): DaemonStatusCore {
  return {
    running: result.running === true,
    state: typeof result.state === 'string' ? result.state : 'stopped',
    build: typeof result.build === 'string' ? result.build : NOVELTEA_CLI_BUILD_IDENTITY,
    protocol:
      typeof result.protocol === 'number' ? result.protocol : NOVELTEA_DAEMON_PROTOCOL_VERSION,
    pid: typeof result.pid === 'number' ? result.pid : null,
    projectSessions:
      typeof result.projectSessions === 'number' && Number.isSafeInteger(result.projectSessions)
        ? result.projectSessions
        : 0,
    disposableWorkers:
      typeof result.disposableWorkers === 'number' && Number.isSafeInteger(result.disposableWorkers)
        ? result.disposableWorkers
        : 0,
    disposableQueuedJobs:
      typeof result.disposableQueuedJobs === 'number' &&
      Number.isSafeInteger(result.disposableQueuedJobs)
        ? result.disposableQueuedJobs
        : 0,
    disposableStandbyWorkers:
      typeof result.disposableStandbyWorkers === 'number' &&
      Number.isSafeInteger(result.disposableStandbyWorkers)
        ? result.disposableStandbyWorkers
        : 0,
    disposableBusyWorkers:
      typeof result.disposableBusyWorkers === 'number' &&
      Number.isSafeInteger(result.disposableBusyWorkers)
        ? result.disposableBusyWorkers
        : 0,
  };
}

function daemonEngineeringSnapshot(result: DaemonNativeResponse): DaemonEngineeringSnapshot {
  const integer = (value: unknown): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const counters: Record<string, number> = {};
  for (const [key, value] of Object.entries(result.engineeringCounters ?? {}))
    counters[key] = integer(value);
  return {
    projectOwnerWorkers: integer(result.projectOwnerWorkers),
    projectAuthorities: integer(result.projectAuthorities),
    projectSnapshots: integer(result.projectSnapshots),
    projectSnapshotBytes: integer(result.projectSnapshotBytes),
    exactValidationResults: integer(result.exactValidationResults),
    exactValidationBytes: integer(result.exactValidationBytes),
    ownerPids: (result.engineeringOwnerPids ?? []).filter(
      (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    ),
    owners: (result.engineeringOwners ?? []).flatMap((owner) =>
      typeof owner.canonicalRoot === 'string' &&
      owner.canonicalRoot.length > 0 &&
      typeof owner.pid === 'number' &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0
        ? [{ canonicalRoot: owner.canonicalRoot, pid: owner.pid }]
        : [],
    ),
    disposablePids: (result.engineeringDisposablePids ?? []).filter(
      (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    ),
    counters,
  };
}

function daemonEngineeringDelta(
  before: DaemonEngineeringSnapshot,
  after: DaemonEngineeringSnapshot,
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before.counters), ...Object.keys(after.counters)]))
    result[key] = Math.max(0, (after.counters[key] ?? 0) - (before.counters[key] ?? 0));
  return result;
}

function staticDaemonPath(argv: readonly string[]): HostResult | null {
  let json = false;
  let project = false;
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
      if (project) return null;
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return null;
      project = true;
      index += 2;
      continue;
    }
    return null;
  }
  if (argv[index] !== 'daemon') return null;
  if (project)
    return formatStaticUsageError(json, "The 'daemon' command does not accept --project.");
  const operation = argv[index + 1];
  if ((operation !== 'status' && operation !== 'stop') || index + 2 !== argv.length)
    return formatStaticUsageError(json, 'Usage: noveltea daemon <status|stop>');

  const response = daemonNativeRequest(operation);
  if (response?.ok === false) {
    const message =
      typeof response.error === 'string'
        ? response.error
        : 'NovelTea daemon broker operation failed.';
    if (json)
      return [
        70,
        `${JSON.stringify({
          success: false,
          exitCode: 70,
          diagnostics: [{ code: 'DAEMON_BROKER', severity: 'error', path: '/', message }],
          daemon: daemonStatusCore(response),
          protocolVersion: NOVELTEA_CLI_JSON_PROTOCOL_VERSION,
        })}\n`,
        '',
      ];
    return [70, '', `[error] DAEMON_BROKER /: ${message}\n`];
  }

  const daemon = daemonStatusCore(response);
  if (json)
    return [
      0,
      `${JSON.stringify({
        success: true,
        exitCode: 0,
        diagnostics: [],
        daemon,
        protocolVersion: NOVELTEA_CLI_JSON_PROTOCOL_VERSION,
      })}\n`,
      '',
    ];
  if (operation === 'stop')
    return [
      0,
      response?.stopped === true
        ? 'NovelTea daemon stopped.\n'
        : 'NovelTea daemon is not running.\n',
      '',
    ];
  return [
    0,
    daemon.running
      ? `NovelTea daemon: ${String(daemon.state)} (pid ${String(daemon.pid)}, build ${String(daemon.build)}, protocol ${String(daemon.protocol)}).\n`
      : `NovelTea daemon: stopped (build ${String(daemon.build)}, protocol ${String(daemon.protocol)}).\n`,
    '',
  ];
}

type HiddenDaemonBaseInvocation = Readonly<{
  build: string;
  protocol: number;
  daemonIdleMs: number;
  projectSessionIdleMs: number;
  projectSnapshotBudgetBytes?: number;
  exactValidationBudgetBytes?: number;
  runtimeRoot?: string;
}>;

type HiddenDaemonBrokerInvocation = HiddenDaemonBaseInvocation &
  Readonly<{
    projectSnapshotBudgetBytes: number;
    exactValidationBudgetBytes: number;
  }>;

type HiddenDaemonOwnerInvocation = HiddenDaemonBaseInvocation &
  Readonly<{
    ownerWorkerId: number;
  }>;

type HiddenDaemonDisposableInvocation = HiddenDaemonBaseInvocation &
  Readonly<{
    disposableWorkerId: number;
  }>;

function hiddenDaemonBrokerInvocation(
  argv: readonly string[],
): HiddenDaemonBrokerInvocation | null {
  if (argv[0] !== '__daemon-broker') return null;
  let build = '';
  let protocolText = '';
  let daemonIdleText = '';
  let projectSessionIdleText = '';
  let projectSnapshotBudgetText = '';
  let exactValidationBudgetText = '';
  let runtimeRoot = '';
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value) return null;
    if (key === '--daemon-build' && build === '') build = value;
    else if (key === '--daemon-protocol' && protocolText === '') protocolText = value;
    else if (key === '--daemon-idle-ms' && daemonIdleText === '') daemonIdleText = value;
    else if (key === '--project-session-idle-ms' && projectSessionIdleText === '')
      projectSessionIdleText = value;
    else if (key === '--project-snapshot-budget-bytes' && projectSnapshotBudgetText === '')
      projectSnapshotBudgetText = value;
    else if (key === '--exact-validation-budget-bytes' && exactValidationBudgetText === '')
      exactValidationBudgetText = value;
    else if (key === '--daemon-runtime-root' && runtimeRoot === '') runtimeRoot = value;
    else return null;
  }
  const protocol = Number(protocolText);
  const daemonIdleMs = Number(daemonIdleText);
  const projectSessionIdleMs = Number(projectSessionIdleText);
  const projectSnapshotBudgetBytes = Number(projectSnapshotBudgetText);
  const exactValidationBudgetBytes = Number(exactValidationBudgetText);
  if (
    build !== daemonBrokerContext().build ||
    protocol !== daemonBrokerContext().protocol ||
    !Number.isSafeInteger(daemonIdleMs) ||
    daemonIdleMs <= 0 ||
    !Number.isSafeInteger(projectSessionIdleMs) ||
    projectSessionIdleMs <= 0 ||
    !Number.isSafeInteger(projectSnapshotBudgetBytes) ||
    projectSnapshotBudgetBytes <= 0 ||
    !Number.isSafeInteger(exactValidationBudgetBytes) ||
    exactValidationBudgetBytes <= 0
  )
    return null;
  return {
    build,
    protocol,
    daemonIdleMs,
    projectSessionIdleMs,
    projectSnapshotBudgetBytes,
    exactValidationBudgetBytes,
    runtimeRoot: runtimeRoot || undefined,
  };
}

function hiddenDaemonOwnerInvocation(argv: readonly string[]): HiddenDaemonOwnerInvocation | null {
  if (argv[0] !== '__daemon-owner') return null;
  let build = '';
  let protocolText = '';
  let daemonIdleText = '';
  let projectSessionIdleText = '';
  let runtimeRoot = '';
  let ownerWorkerIdText = '';
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value) return null;
    if (key === '--daemon-build' && build === '') build = value;
    else if (key === '--daemon-protocol' && protocolText === '') protocolText = value;
    else if (key === '--daemon-idle-ms' && daemonIdleText === '') daemonIdleText = value;
    else if (key === '--project-session-idle-ms' && projectSessionIdleText === '')
      projectSessionIdleText = value;
    else if (key === '--daemon-runtime-root' && runtimeRoot === '') runtimeRoot = value;
    else if (key === '--owner-worker-id' && ownerWorkerIdText === '') ownerWorkerIdText = value;
    else return null;
  }
  const protocol = Number(protocolText);
  const daemonIdleMs = Number(daemonIdleText);
  const projectSessionIdleMs = Number(projectSessionIdleText);
  const ownerWorkerId = Number(ownerWorkerIdText);
  if (
    build !== daemonBrokerContext().build ||
    protocol !== daemonBrokerContext().protocol ||
    !Number.isSafeInteger(daemonIdleMs) ||
    daemonIdleMs <= 0 ||
    !Number.isSafeInteger(projectSessionIdleMs) ||
    projectSessionIdleMs <= 0 ||
    !Number.isSafeInteger(ownerWorkerId) ||
    ownerWorkerId <= 0
  )
    return null;
  return {
    build,
    protocol,
    daemonIdleMs,
    projectSessionIdleMs,
    runtimeRoot: runtimeRoot || undefined,
    ownerWorkerId,
  };
}

function hiddenDaemonDisposableInvocation(
  argv: readonly string[],
): HiddenDaemonDisposableInvocation | null {
  if (argv[0] !== '__daemon-disposable') return null;
  let build = '';
  let protocolText = '';
  let daemonIdleText = '';
  let projectSessionIdleText = '';
  let runtimeRoot = '';
  let workerIdText = '';
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value) return null;
    if (key === '--daemon-build' && build === '') build = value;
    else if (key === '--daemon-protocol' && protocolText === '') protocolText = value;
    else if (key === '--daemon-idle-ms' && daemonIdleText === '') daemonIdleText = value;
    else if (key === '--project-session-idle-ms' && projectSessionIdleText === '')
      projectSessionIdleText = value;
    else if (key === '--daemon-runtime-root' && runtimeRoot === '') runtimeRoot = value;
    else if (key === '--disposable-worker-id' && workerIdText === '') workerIdText = value;
    else return null;
  }
  const protocol = Number(protocolText);
  const daemonIdleMs = Number(daemonIdleText);
  const projectSessionIdleMs = Number(projectSessionIdleText);
  const disposableWorkerId = Number(workerIdText);
  if (
    build !== daemonBrokerContext().build ||
    protocol !== daemonBrokerContext().protocol ||
    !Number.isSafeInteger(daemonIdleMs) ||
    daemonIdleMs <= 0 ||
    !Number.isSafeInteger(projectSessionIdleMs) ||
    projectSessionIdleMs <= 0 ||
    !Number.isSafeInteger(disposableWorkerId) ||
    disposableWorkerId <= 0
  )
    return null;
  return {
    build,
    protocol,
    daemonIdleMs,
    projectSessionIdleMs,
    runtimeRoot: runtimeRoot || undefined,
    disposableWorkerId,
  };
}

function hiddenDaemonNativeRequest(
  action: string,
  invocation: HiddenDaemonBaseInvocation,
  token = 0,
  requestOk = false,
  result: HostResult | null = null,
  error = '',
  projectSessions = 0,
): DaemonNativeResponse {
  return hiddenDaemonPayloadNativeRequest(action, invocation, {
    token,
    requestOk,
    result,
    error,
    projectSessions,
  });
}

function hiddenDaemonPayloadNativeRequest(
  action: string,
  invocation: HiddenDaemonBaseInvocation,
  payload: Readonly<{
    token?: number;
    requestOk?: boolean;
    result?: HostResult | null;
    error?: string;
    projectSessions?: number;
    ownerWorkerId?: number;
    disposableWorkerId?: number;
    stagedOutputPath?: string;
    advanced?: boolean;
    event?: Readonly<Record<string, unknown>>;
    sessionEpoch?: number;
    generation?: number;
    ownerMetadata?: string;
    chunk?: string;
    index?: number;
    semanticKey?: string;
    validationResult?: Readonly<Record<string, unknown>>;
  }>,
): DaemonNativeResponse {
  return JSON.parse(
    invokeHost(
      'daemon',
      JSON.stringify({
        action,
        build: invocation.build,
        protocol: invocation.protocol,
        daemonIdleMs: invocation.daemonIdleMs,
        projectSessionIdleMs: invocation.projectSessionIdleMs,
        projectSnapshotBudgetBytes: invocation.projectSnapshotBudgetBytes,
        exactValidationBudgetBytes: invocation.exactValidationBudgetBytes,
        runtimeRoot: invocation.runtimeRoot,
        token: payload.token,
        requestOk: payload.requestOk,
        result: payload.result,
        error: payload.error,
        projectSessions: payload.projectSessions,
        ownerWorkerId: payload.ownerWorkerId,
        disposableWorkerId: payload.disposableWorkerId,
        stagedOutputPath: payload.stagedOutputPath,
        advanced: payload.advanced,
        event: payload.event,
        sessionEpoch: payload.sessionEpoch,
        generation: payload.generation,
        ownerMetadata: payload.ownerMetadata,
        chunk: payload.chunk,
        index: payload.index,
        semanticKey: payload.semanticKey,
        validationResult: payload.validationResult,
      }),
    ),
  ) as DaemonNativeResponse;
}

function hiddenDaemonDisposableOwnerMutationRequest(
  invocation: HiddenDaemonBaseInvocation,
  disposableWorkerId: number,
  token: number,
  requestText: string,
): string {
  return invokeHost(
    'daemon',
    JSON.stringify({
      action: 'disposable-owner-mutation',
      build: invocation.build,
      protocol: invocation.protocol,
      daemonIdleMs: invocation.daemonIdleMs,
      projectSessionIdleMs: invocation.projectSessionIdleMs,
      runtimeRoot: invocation.runtimeRoot,
      disposableWorkerId,
      token,
      operation: 'comfyui-asset-publication',
      requestText,
    }),
  );
}

function hiddenDaemonOwnerInternalComplete(
  invocation: HiddenDaemonBaseInvocation,
  ownerWorkerId: number,
  token: number,
  resultText: string,
): void {
  const response = JSON.parse(
    invokeHost(
      'daemon',
      JSON.stringify({
        action: 'owner-internal-complete',
        build: invocation.build,
        protocol: invocation.protocol,
        daemonIdleMs: invocation.daemonIdleMs,
        projectSessionIdleMs: invocation.projectSessionIdleMs,
        runtimeRoot: invocation.runtimeRoot,
        ownerWorkerId,
        token,
        resultText,
      }),
    ),
  ) as { ok?: boolean; error?: string };
  if (response.ok !== true)
    throw new Error(response.error ?? 'Failed to complete internal Project-owner mutation.');
}

function hiddenDaemonProjectAuthorityNativeRequest(
  action: string,
  invocation: HiddenDaemonBaseInvocation,
  ownerWorkerId: number | undefined,
  projectRoot: string,
  authoritativePaths: readonly string[] | undefined,
  discoveryScopes: readonly DaemonProjectDiscoveryScope[] | undefined,
): DaemonNativeResponse {
  return JSON.parse(
    invokeHost(
      'daemon',
      JSON.stringify({
        action,
        build: invocation.build,
        protocol: invocation.protocol,
        daemonIdleMs: invocation.daemonIdleMs,
        projectSessionIdleMs: invocation.projectSessionIdleMs,
        runtimeRoot: invocation.runtimeRoot,
        ownerWorkerId,
        projectRoot,
        authoritativePaths,
        discoveryScopes,
      }),
    ),
  ) as DaemonNativeResponse;
}

function hiddenDaemonEventNativeRequest(
  invocation: HiddenDaemonBaseInvocation,
  token: number,
  event: Readonly<Record<string, unknown>>,
): DaemonNativeResponse {
  return JSON.parse(
    invokeHost(
      'daemon',
      JSON.stringify({
        action: 'serve-event',
        build: invocation.build,
        protocol: invocation.protocol,
        daemonIdleMs: invocation.daemonIdleMs,
        projectSessionIdleMs: invocation.projectSessionIdleMs,
        runtimeRoot: invocation.runtimeRoot,
        token,
        event,
      }),
    ),
  ) as DaemonNativeResponse;
}

function requestEnvironment(): Record<string, string> {
  // scriptc's statically lowered Record access cannot represent a missing key as `undefined`.
  // These internal scheduler/certification fields are read directly by worker code, so preserve a
  // total record shape even when the caller did not set them.
  const result: Record<string, string> = {
    NOVELTEA_CLI_CERTIFICATION: '',
    NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_CRASH: '',
    NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_DELAY_MS: '',
    NOVELTEA_CLI_CERTIFICATION_FORCE_READ_AUTHORITY_MISMATCH: '',
    NOVELTEA_CLI_CERTIFICATION_STAGED_OUTPUT_CRASH: '',
    NOVELTEA_CLI_CERTIFICATION_STAGED_OUTPUT_DELAY_MS: '',
    NOVELTEA_CLI_SCHEDULER_PROFILE: '',
  };
  for (const [key, value] of Object.entries(process.env))
    if (typeof value === 'string') result[key] = value;
  return result;
}

function daemonStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    result.push(entry);
  }
  return result;
}

function daemonProjectDiscoveryScopes(
  value: unknown,
): readonly DaemonProjectDiscoveryScope[] | null {
  if (!Array.isArray(value)) return null;
  const result: DaemonProjectDiscoveryScope[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const record = entry as Readonly<Record<string, unknown>>;
    const root = record.root;
    const extensions = daemonStringArray(record.extensions);
    const excludedPrefixes = daemonStringArray(record.excludedPrefixes);
    if (typeof root !== 'string' || extensions === null || excludedPrefixes === null) return null;
    result.push({ root, extensions, excludedPrefixes });
  }
  return result;
}

function commandStart(argv: readonly string[]): number {
  let index = 0;
  while (index < argv.length && argv[index]!.startsWith('--')) {
    if (argv[index] === '--project') index += 2;
    else index += 1;
  }
  return index;
}

function commandRouting(argv: readonly string[]): CliCommandRouting | null {
  const index = commandStart(argv);
  return classifyNovelTeaCliCommand(argv.slice(index));
}

function daemonOwnerProjectRoot(
  argv: readonly string[],
  routing: CliCommandRouting | null,
): string | null {
  if (
    routing?.projectAccess !== 'read' &&
    routing?.projectAccess !== 'transactional-write' &&
    routing?.projectAccess !== 'opaque-write'
  )
    return null;
  let projectArgument: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--project') continue;
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) projectArgument = value;
    break;
  }
  return resolve(process.cwd(), projectArgument ?? '.');
}

function daemonOwnerProjectRootExplicit(
  argv: readonly string[],
  routing: CliCommandRouting | null,
): boolean {
  if (
    routing?.projectAccess !== 'read' &&
    routing?.projectAccess !== 'transactional-write' &&
    routing?.projectAccess !== 'opaque-write'
  )
    return false;
  return argv.includes('--project');
}

function daemonRequestContext(
  argv: readonly string[],
  routing: CliCommandRouting | null,
): DaemonRequestContext {
  return {
    argv,
    executionClass: routing?.executionClass ?? 'disposable-heavy',
    cwd: process.cwd(),
    ownerProjectRoot: daemonOwnerProjectRoot(argv, routing),
    ownerProjectRootExplicit: daemonOwnerProjectRootExplicit(argv, routing),
    environment: requestEnvironment(),
    stdinText: routing?.stdin === 'json' ? invokeHost('read-stdin', '') : null,
    terminal: currentTerminalContext(),
    outputMode: argv.includes('--json') ? 'json' : 'human',
    replaySafe: routing?.replaySafe === true,
    streamedEvents: routing?.streamedEvents === true,
    forceRuntimeCacheRebuild,
    authoringValidationSemanticKey:
      routing?.staticCompletion === 'authoring-cache'
        ? NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY
        : '',
    // Hidden owner code runs through ScriptC's statically typed Record lowering, where an absent
    // optional slot cannot be observed as `undefined`. Keep the internal-operation slots total for
    // ordinary public requests; broker-generated internal requests overwrite them with real values.
    internalOperation: '',
    internalRequestText: '',
  };
}

function requestInvokeHost(
  context: DaemonRequestContext,
  output: RequestOutputCapture,
  invocation: HiddenDaemonBaseInvocation,
  token: number,
  ownerWorkerId?: number,
  disposableWorkerId?: number,
): typeof invokeHost {
  const emitEvent = (event: Readonly<Record<string, unknown>>) => {
    const response = ownerWorkerId
      ? hiddenDaemonPayloadNativeRequest('owner-event', invocation, { ownerWorkerId, token, event })
      : disposableWorkerId
        ? hiddenDaemonPayloadNativeRequest('disposable-event', invocation, {
            disposableWorkerId,
            token,
            event,
          })
        : hiddenDaemonEventNativeRequest(invocation, token, event);
    if (response.ok !== true)
      throw new Error(response.error ?? 'Failed to stream daemon request event.');
  };
  return (operation, requestText) => {
    if (operation === 'read-stdin') return context.stdinText ?? '';
    if (operation === 'daemon-register-staged-output') {
      const parsed = JSON.parse(requestText) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Staged output cleanup request is malformed.');
      const request = parsed as Readonly<Record<string, unknown>>;
      if (!disposableWorkerId || typeof request.path !== 'string')
        throw new Error('Staged output cleanup requires an active disposable worker.');
      return JSON.stringify(
        hiddenDaemonPayloadNativeRequest('disposable-register-staged-output', invocation, {
          disposableWorkerId,
          token,
          stagedOutputPath: request.path,
        }),
      );
    }
    if (operation === 'daemon-commit-comfyui-assets') {
      if (!disposableWorkerId)
        throw new Error('ComfyUI Asset publication requires an active disposable worker.');
      const parsed = JSON.parse(requestText) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('ComfyUI Asset publication request is malformed.');
      return hiddenDaemonDisposableOwnerMutationRequest(
        invocation,
        disposableWorkerId,
        token,
        requestText,
      );
    }
    if (operation === 'daemon-enter-critical')
      return JSON.stringify(
        ownerWorkerId
          ? hiddenDaemonPayloadNativeRequest('owner-enter-critical', invocation, { ownerWorkerId })
          : daemonNativeRequest('serve-enter-critical'),
      );
    if (operation === 'daemon-leave-critical')
      return JSON.stringify(
        ownerWorkerId
          ? hiddenDaemonPayloadNativeRequest('owner-leave-critical', invocation, { ownerWorkerId })
          : daemonNativeRequest('serve-leave-critical'),
      );
    if (operation === 'daemon-project-sessions') {
      const projectSessions = Number(requestText);
      if (!Number.isSafeInteger(projectSessions) || projectSessions < 0)
        throw new Error('Daemon Project session count is malformed.');
      const response = ownerWorkerId
        ? hiddenDaemonPayloadNativeRequest('owner-project-sessions', invocation, {
            ownerWorkerId,
            projectSessions,
          })
        : hiddenDaemonNativeRequest(
            'serve-project-sessions',
            invocation,
            0,
            false,
            null,
            '',
            projectSessions,
          );
      if (response.ok !== true)
        throw new Error(response.error ?? 'Failed to publish daemon Project session count.');
      return JSON.stringify(response);
    }
    if (operation === 'daemon-project-observe' || operation === 'daemon-project-release') {
      const parsed = requestText === '' ? {} : (JSON.parse(requestText) as unknown);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Daemon Project authority request is malformed.');
      const request = parsed as Readonly<Record<string, unknown>>;
      const projectRoot = request.projectRoot;
      if (typeof projectRoot !== 'string' || projectRoot.length === 0)
        throw new Error('Daemon Project authority request requires projectRoot.');
      let payload: DaemonProjectAuthorityConfiguration | null = null;
      if (operation === 'daemon-project-observe') {
        const hasAuthoritativePaths = request.authoritativePaths !== undefined;
        const hasDiscoveryScopes = request.discoveryScopes !== undefined;
        if (hasAuthoritativePaths !== hasDiscoveryScopes)
          throw new Error('Daemon Project authority configuration is incomplete.');
        if (hasAuthoritativePaths) {
          const authoritativePaths = daemonStringArray(request.authoritativePaths);
          const discoveryScopes = daemonProjectDiscoveryScopes(request.discoveryScopes);
          if (authoritativePaths === null || discoveryScopes === null)
            throw new Error('Daemon Project authority configuration is malformed.');
          payload = {
            projectRoot,
            authoritativePaths,
            discoveryScopes,
          };
          residentProjectAuthorityRequests.set(projectRoot, payload);
        } else {
          const configured = residentProjectAuthorityRequests.get(projectRoot);
          if (!configured)
            throw new Error('Daemon Project authority observation has no cached configuration.');
          payload = configured;
        }
      }
      const response = hiddenDaemonProjectAuthorityNativeRequest(
        operation === 'daemon-project-observe'
          ? ownerWorkerId
            ? 'owner-project-observe'
            : 'serve-project-observe'
          : ownerWorkerId
            ? 'owner-project-release'
            : 'serve-project-release',
        invocation,
        ownerWorkerId,
        projectRoot,
        payload?.authoritativePaths,
        payload?.discoveryScopes,
      );
      if (response.ok !== true)
        throw new Error(response.error ?? 'Daemon Project authority operation failed.');
      if (operation === 'daemon-project-release')
        residentProjectAuthorityRequests.delete(projectRoot);
      let responseForIsland: unknown = response;
      if (operation === 'daemon-project-observe') {
        const manifest = response.manifest;
        if (manifest) {
          const includeManifestEntries = request.includeManifestEntries === true;
          responseForIsland = {
            ok: response.ok,
            authority: response.authority,
            previousAuthority: response.previousAuthority,
            unchanged: response.unchanged,
            fullRescan: response.fullRescan,
            watcherPaths: response.watcherPaths,
            delta: response.delta,
            manifest: {
              canonicalRoot: manifest.canonicalRoot,
              entries: includeManifestEntries
                ? (manifest.entries ?? []).filter((entry) => typeof entry.path === 'string')
                : [],
            },
          };
        }
      }
      return JSON.stringify(responseForIsland);
    }
    if (operation === 'daemon-project-generation') {
      if (!ownerWorkerId)
        throw new Error(
          'Resident Project generation announcements require a dedicated Project owner.',
        );
      const parsed = requestText === '' ? {} : (JSON.parse(requestText) as unknown);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Resident Project generation announcement is malformed.');
      const request = parsed as Readonly<Record<string, unknown>>;
      if (
        typeof request.sessionEpoch !== 'number' ||
        !Number.isSafeInteger(request.sessionEpoch) ||
        request.sessionEpoch <= 0 ||
        typeof request.generation !== 'number' ||
        !Number.isSafeInteger(request.generation) ||
        request.generation <= 0
      )
        throw new Error('Resident Project generation identity is malformed.');
      const response = hiddenDaemonPayloadNativeRequest('owner-project-generation', invocation, {
        ownerWorkerId,
        sessionEpoch: request.sessionEpoch as number,
        generation: request.generation as number,
      });
      if (response.ok !== true)
        throw new Error(response.error ?? 'Resident Project generation announcement failed.');
      return JSON.stringify(response);
    }
    if (operation === 'daemon-authoring-validation-result') {
      if (!ownerWorkerId)
        throw new Error('Exact authoring validation results require a dedicated Project owner.');
      const parsed = requestText === '' ? {} : (JSON.parse(requestText) as unknown);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Exact authoring validation result is malformed.');
      const request = parsed as Readonly<Record<string, unknown>>;
      if (
        request.semanticKey !== NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY ||
        request.result === null ||
        typeof request.result !== 'object'
      )
        throw new Error('Exact authoring validation result contract is malformed.');
      const response = hiddenDaemonPayloadNativeRequest('owner-validation-result', invocation, {
        ownerWorkerId,
        token,
        semanticKey: request.semanticKey,
        validationResult: request.result as Readonly<Record<string, unknown>>,
      });
      if (response.ok !== true)
        throw new Error(response.error ?? 'Exact authoring validation result retention failed.');
      return JSON.stringify(response);
    }
    if (
      operation === 'daemon-project-snapshot-begin' ||
      operation === 'daemon-project-snapshot-chunk' ||
      operation === 'daemon-project-snapshot-commit'
    ) {
      if (!ownerWorkerId)
        throw new Error('Portable Project snapshots require a dedicated Project owner.');
      const parsed = requestText === '' ? {} : (JSON.parse(requestText) as unknown);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Portable Project snapshot request is malformed.');
      const request = parsed as Readonly<Record<string, unknown>>;
      let response: DaemonNativeResponse;
      if (operation === 'daemon-project-snapshot-begin') {
        if (
          typeof request.sessionEpoch !== 'number' ||
          !Number.isSafeInteger(request.sessionEpoch) ||
          request.sessionEpoch <= 0 ||
          typeof request.generation !== 'number' ||
          !Number.isSafeInteger(request.generation) ||
          request.generation <= 0 ||
          typeof request.ownerMetadata !== 'string'
        )
          throw new Error('Portable Project snapshot identity is malformed.');
        response = hiddenDaemonPayloadNativeRequest('owner-snapshot-begin', invocation, {
          ownerWorkerId,
          sessionEpoch: request.sessionEpoch as number,
          generation: request.generation as number,
          ownerMetadata: request.ownerMetadata,
        });
      } else if (operation === 'daemon-project-snapshot-chunk') {
        if (typeof request.chunk !== 'string' || request.chunk.length === 0)
          throw new Error('Portable Project snapshot chunk is malformed.');
        response = hiddenDaemonPayloadNativeRequest('owner-snapshot-chunk', invocation, {
          ownerWorkerId,
          chunk: request.chunk,
        });
      } else {
        response = hiddenDaemonPayloadNativeRequest('owner-snapshot-commit', invocation, {
          ownerWorkerId,
        });
      }
      if (response.ok !== true)
        throw new Error(response.error ?? 'Portable Project snapshot operation failed.');
      return JSON.stringify(response);
    }
    if (operation === 'emit-progress') {
      if (!context.streamedEvents || context.outputMode === 'json') return '';
      const event = JSON.parse(requestText) as { stage: string; message: string };
      emitEvent({ type: 'progress', message: `[${event.stage}] ${event.message}` });
      return '';
    }
    if (
      operation === 'process-alive' ||
      operation === 'run-process' ||
      operation === 'font-coverage'
    )
      return invokeHost(operation, requestText);
    const envelope = JSON.parse(
      invokeHost(`capture:${operation}`, requestText),
    ) as CapturedNativeEnvelope;
    if (envelope.captureOk !== true) throw new Error('failed to capture daemon native output');
    if (context.streamedEvents && context.outputMode === 'human') {
      if (envelope.stdout) emitEvent({ type: 'stdout', text: envelope.stdout });
      if (envelope.stderr) emitEvent({ type: 'stderr', text: envelope.stderr });
    } else {
      output.stdout += envelope.stdout;
      output.stderr += envelope.stderr;
    }
    if (
      operation === 'export-package' &&
      disposableWorkerId &&
      context.environment.NOVELTEA_CLI_CERTIFICATION === '1'
    ) {
      if (context.environment.NOVELTEA_CLI_CERTIFICATION_STAGED_OUTPUT_CRASH === '1')
        process.exit(97);
      const delayMs = Number(
        context.environment.NOVELTEA_CLI_CERTIFICATION_STAGED_OUTPUT_DELAY_MS || '0',
      );
      if (Number.isSafeInteger(delayMs) && delayMs > 0 && delayMs <= 10_000) {
        const deadline = Date.now() + delayMs;
        while (Date.now() < deadline)
          hiddenDaemonPayloadNativeRequest('disposable-cancelled', invocation, {
            disposableWorkerId,
            token,
          });
      }
    }
    return envelope.response;
  };
}

async function runHiddenDaemonBroker(invocation: HiddenDaemonBrokerInvocation): Promise<number> {
  const started = hiddenDaemonNativeRequest('serve-start', invocation);
  if (started.ok !== true) {
    const message =
      typeof started.error === 'string' ? started.error : 'Failed to start NovelTea daemon broker.';
    throw new Error(message);
  }
  trace('daemon broker reachable in starting state');
  try {
    const ready = hiddenDaemonNativeRequest('serve-ready', invocation);
    if (ready.ok !== true) {
      const message =
        typeof ready.error === 'string' ? ready.error : 'Failed to mark NovelTea daemon ready.';
      throw new Error(message);
    }
    const waited = hiddenDaemonNativeRequest('serve-wait', invocation);
    if (waited.ok !== true) {
      const message =
        typeof waited.error === 'string' ? waited.error : 'NovelTea daemon broker failed.';
      throw new Error(message);
    }
    return 0;
  } catch (error) {
    hiddenDaemonNativeRequest('serve-abort', invocation);
    throw error;
  }
}

function ownerProjectStartupState(invocation: HiddenDaemonOwnerInvocation): Readonly<{
  coldSessionEpoch: number;
  retainedSnapshot?: Readonly<{
    projectRoot: string;
    snapshotText: string;
    ownerMetadataText: string;
  }>;
}> {
  const descriptor = hiddenDaemonPayloadNativeRequest('owner-snapshot-describe', invocation, {
    ownerWorkerId: invocation.ownerWorkerId,
  });
  if (descriptor.ok !== true)
    throw new Error(descriptor.error ?? 'Failed to inspect retained portable Project snapshot.');
  if (
    !Number.isSafeInteger(descriptor.coldSessionEpoch) ||
    (descriptor.coldSessionEpoch as number) <= 0
  )
    throw new Error('Portable Project owner cold session epoch is malformed.');
  const coldSessionEpoch = descriptor.coldSessionEpoch as number;
  if (descriptor.found !== true) return { coldSessionEpoch };
  if (
    typeof descriptor.canonicalRoot !== 'string' ||
    descriptor.canonicalRoot.length === 0 ||
    !Number.isSafeInteger(descriptor.sessionEpoch) ||
    (descriptor.sessionEpoch as number) <= 0 ||
    !Number.isSafeInteger(descriptor.generation) ||
    (descriptor.generation as number) <= 0 ||
    !Number.isSafeInteger(descriptor.chunkCount) ||
    (descriptor.chunkCount as number) <= 0 ||
    typeof descriptor.ownerMetadata !== 'string'
  )
    throw new Error('Retained portable Project snapshot descriptor is malformed.');
  const chunks: string[] = [];
  for (let index = 0; index < (descriptor.chunkCount as number); index += 1) {
    const response = hiddenDaemonPayloadNativeRequest('owner-snapshot-read', invocation, {
      ownerWorkerId: invocation.ownerWorkerId,
      sessionEpoch: descriptor.sessionEpoch as number,
      generation: descriptor.generation as number,
      index,
    });
    if (response.ok !== true || typeof response.chunk !== 'string')
      throw new Error(response.error ?? 'Failed to read retained portable Project snapshot.');
    chunks.push(response.chunk);
  }
  return {
    coldSessionEpoch,
    retainedSnapshot: {
      projectRoot: descriptor.canonicalRoot,
      snapshotText: chunks.join(''),
      ownerMetadataText: descriptor.ownerMetadata,
    },
  };
}

async function runHiddenDaemonOwner(invocation: HiddenDaemonOwnerInvocation): Promise<number> {
  trace(`daemon Project owner ${String(invocation.ownerWorkerId)} QuickJS initialization starting`);
  // @ts-expect-error The private island package is materialized only during release staging.
  const island = await import('noveltea-scriptc-island');
  const {
    commitNovelTeaResidentComfyUiAssetPublication,
    runNovelTeaScriptcIsland,
    reconcileNovelTeaResidentProjects,
    prepareNovelTeaResidentProjectSnapshots,
    novelTeaResidentProjectSessionCount,
  } = island;
  trace(
    `daemon Project owner ${String(invocation.ownerWorkerId)} QuickJS initialization completed`,
  );
  const startupState = ownerProjectStartupState(invocation);
  let retainedSnapshotPending = startupState.retainedSnapshot;
  let foregroundWorkSinceGc = false;
  nativeSetQuickJsGcThreshold(residentQuickJsGcThresholdBytes);
  for (;;) {
    const next = hiddenDaemonPayloadNativeRequest('owner-next', invocation, {
      ownerWorkerId: invocation.ownerWorkerId,
    });
    if (next.ok !== true) {
      const message =
        typeof next.error === 'string' ? next.error : 'NovelTea daemon Project owner failed.';
      throw new Error(message);
    }
    if (next.stopped === true) break;
    if (next.idle === true) {
      const status = hiddenDaemonPayloadNativeRequest('owner-needs-reconcile', invocation, {
        ownerWorkerId: invocation.ownerWorkerId,
      });
      if (status.ok === true && status.needsReconcile === true) {
        let advanced = false;
        try {
          advanced = (await reconcileNovelTeaResidentProjects()) > 0;
          if (advanced) foregroundWorkSinceGc = true;
        } finally {
          hiddenDaemonPayloadNativeRequest('owner-reconcile-complete', invocation, {
            ownerWorkerId: invocation.ownerWorkerId,
            advanced,
          });
        }
      }
      if (foregroundWorkSinceGc) {
        if (novelTeaResidentProjectSessionCount() === 0) {
          foregroundWorkSinceGc = false;
        } else {
          const permit = hiddenDaemonPayloadNativeRequest('owner-maintenance-permit', invocation, {
            ownerWorkerId: invocation.ownerWorkerId,
          });
          if (permit.ok === true && permit.allowed === true) {
            nativeRunQuickJsGc();
            nativeSetQuickJsGcThreshold(residentQuickJsGcThresholdBytes);
            foregroundWorkSinceGc = false;
            trace(
              `daemon Project owner ${String(invocation.ownerWorkerId)} completed idle QuickJS GC`,
            );
          }
        }
      }
      // Whole-Project serialization is required handoff work only, never idle maintenance that
      // can monopolize the owner when a new short request arrives.
      continue;
    }
    const token = next.token;
    const payload = next.payload as DaemonRequestContext;
    if (
      typeof token !== 'number' ||
      !Number.isSafeInteger(token) ||
      next.method !== 'invoke' ||
      !payload ||
      !Array.isArray(payload.argv)
    ) {
      hiddenDaemonPayloadNativeRequest('owner-complete', invocation, {
        ownerWorkerId: invocation.ownerWorkerId,
        token: typeof token === 'number' ? token : 0,
        requestOk: false,
        result: null,
        error: 'invalid daemon Project-owner invocation request',
      });
      continue;
    }
    foregroundWorkSinceGc = true;
    try {
      const residentProjectSnapshot = retainedSnapshotPending;
      const prepareDisposable = next.prepareDisposable === true;
      const output: RequestOutputCapture = { stdout: '', stderr: '' };
      if (payload.internalOperation === 'comfyui-asset-publication') {
        const mutationResult = await commitNovelTeaResidentComfyUiAssetPublication(
          payload.internalRequestText ?? '{}',
          requestInvokeHost(payload, output, invocation, token, invocation.ownerWorkerId),
        );
        hiddenDaemonOwnerInternalComplete(
          invocation,
          invocation.ownerWorkerId,
          token,
          JSON.stringify(mutationResult as unknown),
        );
        continue;
      }
      const responseText = await runNovelTeaScriptcIsland(
        JSON.stringify(payload.argv),
        requestInvokeHost(payload, output, invocation, token, invocation.ownerWorkerId),
        payload.forceRuntimeCacheRebuild,
        {
          cwd: payload.cwd,
          environment: payload.environment,
          terminal: payload.terminal,
          residentProjectSessions: true,
          residentProjectSessionEpoch: startupState.coldSessionEpoch,
          residentProjectSnapshot,
          prepareResidentSnapshotOnly: prepareDisposable,
          cancellationProbe: () => {
            const status = hiddenDaemonPayloadNativeRequest('owner-cancelled', invocation, {
              ownerWorkerId: invocation.ownerWorkerId,
              token,
            });
            return status.cancelled === true;
          },
        },
      );
      if (novelTeaResidentProjectSessionCount() > 0) retainedSnapshotPending = undefined;
      const response = JSON.parse(responseText) as HostResult;
      if (prepareDisposable && response[0] === 0) {
        const prepared = await prepareNovelTeaResidentProjectSnapshots();
        if (prepared > 0)
          trace(`daemon Project owner prepared ${String(prepared)} portable snapshot(s) on demand`);
      }
      const completed: HostResult = [
        response[0],
        `${output.stdout}${response[1]}`,
        `${output.stderr}${response[2]}`,
      ];
      hiddenDaemonPayloadNativeRequest('owner-complete', invocation, {
        ownerWorkerId: invocation.ownerWorkerId,
        token,
        requestOk: true,
        result: completed,
        error: '',
      });
    } catch (error) {
      hiddenDaemonPayloadNativeRequest('owner-complete', invocation, {
        ownerWorkerId: invocation.ownerWorkerId,
        token,
        requestOk: false,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return 0;
}

async function runHiddenDaemonDisposable(
  invocation: HiddenDaemonDisposableInvocation,
): Promise<number> {
  trace(
    `daemon disposable worker ${String(invocation.disposableWorkerId)} QuickJS initialization starting`,
  );
  // @ts-expect-error The private island package is materialized only during release staging.
  const { runNovelTeaScriptcIsland } = await import('noveltea-scriptc-island');
  trace(
    `daemon disposable worker ${String(invocation.disposableWorkerId)} QuickJS initialization completed`,
  );
  const ready = hiddenDaemonPayloadNativeRequest('disposable-ready', invocation, {
    disposableWorkerId: invocation.disposableWorkerId,
  });
  if (ready.ok !== true)
    throw new Error(ready.error ?? 'Failed to mark NovelTea disposable worker ready.');

  const next = hiddenDaemonPayloadNativeRequest('disposable-next', invocation, {
    disposableWorkerId: invocation.disposableWorkerId,
  });
  if (next.ok !== true)
    throw new Error(next.error ?? 'NovelTea disposable worker failed to acquire work.');
  if (next.stopped === true) return 0;
  const token = next.token;
  const payload = next.payload as DaemonRequestContext;
  if (
    typeof token !== 'number' ||
    !Number.isSafeInteger(token) ||
    next.method !== 'invoke' ||
    !payload ||
    !Array.isArray(payload.argv) ||
    typeof next.hasProjectSnapshot !== 'boolean'
  )
    throw new Error('NovelTea disposable worker received a malformed assignment.');

  const chunks: string[] = [];
  const snapshotReadStarted = Date.now();
  try {
    if (next.hasProjectSnapshot === true) {
      if (
        typeof next.canonicalRoot !== 'string' ||
        next.canonicalRoot.length === 0 ||
        !Number.isSafeInteger(next.chunkCount) ||
        (next.chunkCount as number) <= 0
      )
        throw new Error('NovelTea disposable worker received malformed Project snapshot metadata.');
      for (let index = 0; index < (next.chunkCount as number); index += 1) {
        const chunk = hiddenDaemonPayloadNativeRequest('disposable-snapshot-read', invocation, {
          disposableWorkerId: invocation.disposableWorkerId,
          token,
          index,
        });
        if (chunk.ok !== true || typeof chunk.chunk !== 'string')
          throw new Error(chunk.error ?? 'Failed to read pinned portable Project snapshot.');
        chunks.push(chunk.chunk);
      }
    }
  } catch (error) {
    hiddenDaemonPayloadNativeRequest('disposable-complete', invocation, {
      disposableWorkerId: invocation.disposableWorkerId,
      token,
      requestOk: false,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }

  try {
    if (payload.environment.NOVELTEA_CLI_CERTIFICATION === '1') {
      const delayText = payload.environment.NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_DELAY_MS;
      const delayMs = delayText ? Number(delayText) : 0;
      if (Number.isSafeInteger(delayMs) && delayMs > 0 && delayMs <= 10_000) {
        const deadline = Date.now() + delayMs;
        while (Date.now() < deadline) {
          // Deliberately remain alive after cancellation here. The certification path proves that
          // native cancellation may retire a disposable worker after the cooperative grace period.
          hiddenDaemonPayloadNativeRequest('disposable-cancelled', invocation, {
            disposableWorkerId: invocation.disposableWorkerId,
            token,
          });
        }
      }
      if (payload.environment.NOVELTEA_CLI_CERTIFICATION_DISPOSABLE_CRASH === '1') process.exit(97);
    }
    const output: RequestOutputCapture = { stdout: '', stderr: '' };
    if (payload.environment.NOVELTEA_CLI_SCHEDULER_PROFILE === '1')
      output.stderr += `[worker-profile] ${JSON.stringify({
        workerKind: 'disposable',
        hasProjectSnapshot: next.hasProjectSnapshot,
        snapshotBytes: chunks.reduce((total, chunk) => total + chunk.length, 0),
        snapshotReadMs: Date.now() - snapshotReadStarted,
      })}\n`;
    const pinnedProjectSnapshot =
      next.hasProjectSnapshot === true
        ? {
            projectRoot: next.canonicalRoot as string,
            snapshotText: chunks.join(''),
          }
        : undefined;
    const responseText = await runNovelTeaScriptcIsland(
      JSON.stringify(payload.argv),
      requestInvokeHost(
        payload,
        output,
        invocation,
        token,
        undefined,
        invocation.disposableWorkerId,
      ),
      payload.forceRuntimeCacheRebuild,
      {
        cwd: payload.cwd,
        environment: payload.environment,
        terminal: payload.terminal,
        pinnedProjectSnapshot,
        cancellationProbe: () => {
          const status = hiddenDaemonPayloadNativeRequest('disposable-cancelled', invocation, {
            disposableWorkerId: invocation.disposableWorkerId,
            token,
          });
          return status.cancelled === true;
        },
      },
    );
    const response = JSON.parse(responseText) as HostResult;
    const completed: HostResult = [
      response[0],
      `${output.stdout}${response[1]}`,
      `${output.stderr}${response[2]}`,
    ];
    hiddenDaemonPayloadNativeRequest('disposable-complete', invocation, {
      disposableWorkerId: invocation.disposableWorkerId,
      token,
      requestOk: true,
      result: completed,
      error: '',
    });
  } catch (error) {
    hiddenDaemonPayloadNativeRequest('disposable-complete', invocation, {
      disposableWorkerId: invocation.disposableWorkerId,
      token,
      requestOk: false,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // One-job workers deliberately retire instead of retaining arbitrary QuickJS state.
  return 0;
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

function staticCommandPath(
  argv: readonly string[],
  routing: CliCommandRouting | null,
): HostResult | null {
  if (!routing) return null;
  if (routing.staticCompletion === 'daemon-control') return staticDaemonPath(argv);
  if (routing.staticCompletion === 'authoring-cache') return staticValidationPath(argv);
  if (routing.staticCompletion === 'runtime-cache') return staticTestPath(argv);
  if (routing.staticCompletion === 'native-tool') return staticNativePath(argv);
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
      // Repeated static flags are idempotent so they never fall through into daemon routing.
      help = true;
      index += 1;
      continue;
    }
    if (argument === '--version') {
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

function strippedStaticArgv(argv: readonly string[]): readonly string[] {
  let seen = false;
  const result: string[] = [];
  let inGlobals = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (inGlobals && argument === '--no-daemon' && !seen) {
      seen = true;
      continue;
    }
    result.push(argument);
    if (inGlobals && argument === '--project') {
      const value = argv[index + 1];
      if (value !== undefined) {
        result.push(value);
        index += 1;
      }
      continue;
    }
    if (inGlobals && !argument.startsWith('--')) inGlobals = false;
  }
  return result;
}

function daemonDisabled(argv: readonly string[]): boolean {
  return process.env.NOVELTEA_NO_DAEMON === '1' || argv.includes('--no-daemon');
}

function privateInternalInvocation(argv: readonly string[]): boolean {
  return argv[0] === '__editor-native' || argv[0] === '__shaderc-batch';
}

async function runLocalIsland(argv: readonly string[]): Promise<HostResult> {
  trace('dynamic island import starting');
  // @ts-expect-error The private island package is materialized only during release staging.
  const { runNovelTeaScriptcIsland } = await import('noveltea-scriptc-island');
  trace('dynamic island import completed');
  trace('dynamic island invocation starting');
  const cancellation = daemonNativeRequest('local-cancel-start');
  if (cancellation.ok === false)
    throw new Error(cancellation.error ?? 'failed to initialize local cancellation handling');
  try {
    const responseText = await runNovelTeaScriptcIsland(
      JSON.stringify(argv),
      privateInternalInvocation(argv) ? invokePrivateInternalHost : invokeHost,
      forceRuntimeCacheRebuild,
      {
        terminal: currentTerminalContext(),
        cancellationProbe: () => daemonNativeRequest('local-cancelled').cancelled === true,
      },
    );
    trace('dynamic island invocation completed');
    return JSON.parse(responseText) as HostResult;
  } finally {
    daemonNativeRequest('local-cancel-stop');
  }
}

function daemonFailureResult(json: boolean, message: string): HostResult {
  if (json)
    return [
      70,
      `${JSON.stringify({
        success: false,
        exitCode: 70,
        diagnostics: [{ code: 'DAEMON_EXECUTION', severity: 'error', path: '/', message }],
        protocolVersion: NOVELTEA_CLI_JSON_PROTOCOL_VERSION,
      })}\n`,
      '',
    ];
  return [70, '', `[error] DAEMON_EXECUTION /: ${message}\n`];
}

function daemonInterruptedResult(json: boolean): HostResult {
  if (json)
    return [
      130,
      `${JSON.stringify({
        success: false,
        exitCode: 130,
        diagnostics: [
          {
            code: 'CLI_INTERRUPTED',
            severity: 'error',
            path: '/',
            message: 'Command interrupted.',
          },
        ],
        protocolVersion: NOVELTEA_CLI_JSON_PROTOCOL_VERSION,
      })}\n`,
      '',
    ];
  return [130, '', '[error] CLI_INTERRUPTED /: Command interrupted.\n'];
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
    const ownerInvocation = hiddenDaemonOwnerInvocation(argv);
    if (ownerInvocation) {
      exitCode = await runHiddenDaemonOwner(ownerInvocation);
      return;
    }
    const disposableInvocation = hiddenDaemonDisposableInvocation(argv);
    if (disposableInvocation) {
      exitCode = await runHiddenDaemonDisposable(disposableInvocation);
      return;
    }
    const daemonInvocation = hiddenDaemonBrokerInvocation(argv);
    if (daemonInvocation) {
      exitCode = await runHiddenDaemonBroker(daemonInvocation);
      return;
    }
    if (argv.length === 1 && argv[0] === '__daemon-ensure') {
      const ensured = daemonEnsureNativeRequest();
      process.stdout.write(`${JSON.stringify(ensured)}\n`);
      exitCode = ensured.ok === false ? 70 : 0;
      return;
    }
    const staticArgv = strippedStaticArgv(argv);
    const routing = commandRouting(staticArgv);
    const fastPath = staticFastPath(staticArgv) ?? staticCommandPath(staticArgv, routing);
    if (fastPath !== null) {
      emit(fastPath);
      exitCode = fastPath[0];
    } else if (privateInternalInvocation(argv) || daemonDisabled(argv)) {
      trace(
        privateInternalInvocation(argv) ? 'private internal invocation' : 'daemon routing bypassed',
      );
      const response = await runLocalIsland(argv);
      emit(response);
      exitCode = response[0];
    } else {
      const request = daemonRequestContext(argv, routing);
      const ensured = daemonEnsureNativeRequest();
      let response: HostResult | null = null;
      if (ensured.ok !== false) {
        trace('daemon invocation forwarding');
        const schedulerProfileEnabled = process.env.NOVELTEA_CLI_SCHEDULER_PROFILE === '1';
        const engineeringBefore = schedulerProfileEnabled
          ? daemonEngineeringSnapshot(daemonNativeRequest('status'))
          : null;
        const requestStarted = schedulerProfileEnabled ? Date.now() : 0;
        const daemonResponse = daemonRequestNative(request);
        if (schedulerProfileEnabled && engineeringBefore) {
          const engineeringAfter = daemonEngineeringSnapshot(daemonNativeRequest('status'));
          const delta = daemonEngineeringDelta(engineeringBefore, engineeringAfter);
          process.stderr.write(
            `[scheduler-profile] ${JSON.stringify({
              routingClass: request.executionClass,
              projectBound: request.ownerProjectRoot !== null,
              requestMs: Date.now() - requestStarted,
              ownerHit:
                request.ownerProjectRoot !== null &&
                (delta.ownerSpawns ?? 0) === 0 &&
                (delta.exactResultHits ?? 0) === 0,
              ownerColdAdmission: (delta.ownerColdAdmissions ?? 0) > 0,
              ownerRehydration: (delta.ownerRehydrations ?? 0) > 0,
              exactResultHit: (delta.exactResultHits ?? 0) > 0,
              snapshotHandoff: (delta.snapshotHandoffs ?? 0) > 0,
              changedPathCount: delta.changedPaths ?? 0,
              generationPromotions: delta.generationPromotions ?? 0,
              workerSpawns: {
                owner: delta.ownerSpawns ?? 0,
                disposable: delta.disposableSpawns ?? 0,
              },
              queuedDisposableJobs: delta.disposableQueues ?? 0,
              workerRetirements: {
                owner: delta.ownerRetirements ?? 0,
                disposable: delta.disposableRetirements ?? 0,
              },
              nativeBoundaryCalls: delta.nativeBoundaryCalls ?? 0,
              physicalFilesObserved: delta.filesObserved ?? 0,
              authorityObservations: delta.authorityObservations ?? 0,
              authorityFullRescans: delta.authorityFullRescans ?? 0,
              snapshotPublications: delta.snapshotPublications ?? 0,
              resident: {
                projectOwners: engineeringAfter.projectOwnerWorkers,
                projectAuthorities: engineeringAfter.projectAuthorities,
                snapshots: engineeringAfter.projectSnapshots,
                snapshotBytes: engineeringAfter.projectSnapshotBytes,
                exactValidationResults: engineeringAfter.exactValidationResults,
                exactValidationBytes: engineeringAfter.exactValidationBytes,
                ownerPids: engineeringAfter.ownerPids,
                owners: engineeringAfter.owners,
                disposablePids: engineeringAfter.disposablePids,
              },
            })}\n`,
          );
        }
        if (
          daemonResponse.ok === true &&
          daemonResponse.retainedValidationResult !== undefined &&
          daemonResponse.retainedValidationResult !== null
        ) {
          response = retainedAuthoringValidationResult(
            daemonResponse.retainedValidationResult,
            request,
          );
        } else if (
          daemonResponse.ok === true &&
          daemonResponse.result !== undefined &&
          daemonResponse.result !== null
        ) {
          response = daemonResponse.result;
        } else if (daemonResponse.cancelled === true) {
          response = daemonInterruptedResult(request.outputMode === 'json');
        } else {
          const message =
            typeof daemonResponse?.error === 'string'
              ? daemonResponse.error
              : 'Resident daemon execution failed.';
          const unavailableBeforeDispatch = message === 'daemon broker is not reachable';
          const brokerLostMidRequest = message === 'daemon broker closed without a result';
          const replayDisallowed =
            !request.replaySafe ||
            (request.executionClass === 'disposable-heavy' && !brokerLostMidRequest);
          if (replayDisallowed && !unavailableBeforeDispatch)
            response = daemonFailureResult(request.outputMode === 'json', message);
        }
      } else trace(`daemon ensure failed: ${ensured.error ?? 'unknown daemon startup failure'}`);
      if (response === null) {
        trace('daemon acceleration unavailable; using local island fallback');
        response = await runLocalIsland(argv);
      }
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
