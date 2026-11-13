import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  validRepairModelId,
  type RepairHarness,
  type RepairModelCatalog,
} from '../../shared/repair-harness';
import {
  localRepairExecutable,
  probeRepairHarnesses,
  repairHarnessProcessCommand,
  resolveRepairExecutionEnvironment,
} from './repair-harness-service';

const exec = promisify(execFile);
const CATALOG_TIMEOUT_MS = 6_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const SUCCESS_TTL_MS = 60_000;
const FAILURE_TTL_MS = 10_000;

function normalizeModels(values: unknown[]): string[] | null {
  const models = [
    ...new Set(
      values.filter(
        (value): value is string => typeof value === 'string' && validRepairModelId(value),
      ),
    ),
  ];
  // A partial catalog is not evidence that the user's saved model vanished.
  return models.length <= 400 ? models : null;
}

/** OpenCode explicitly exposes IDs as provider/model, one per stdout line. */
export async function listOpenCodeModels(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string[] | null> {
  const command = repairHarnessProcessCommand(executable, ['models'], platform);
  try {
    const { stdout } = await exec(command.executable, command.args, {
      windowsHide: true,
      env,
      timeout: CATALOG_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    const lines = stdout.split(/\r?\n/u).filter(Boolean);
    const models = normalizeModels(lines.filter((line) => /^[a-z0-9][a-z0-9._-]*\//iu.test(line)));
    // Unexpected nonempty stdout is not a trustworthy empty catalog.
    return models === null || (lines.length && !models.length) ? null : models;
  } catch {
    return null;
  }
}

/**
 * A short-lived JSONL app-server process, never an agent thread or turn.
 * If a protocol update breaks the handshake, manual entry remains available.
 */
export function listCodexAppServerModels(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const command = repairHarnessProcessCommand(executable, ['app-server'], platform);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.executable, command.args, {
        windowsHide: true,
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    const stdin = child.stdin;
    const stdout = child.stdout;
    if (!stdin || !stdout) {
      child.kill();
      resolve(null);
      return;
    }
    let complete = false;
    let bytes = 0;
    let pending = '';
    const models: string[] = [];
    let pages = 0;
    const finish = (result: string[] | null) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const send = (message: unknown) => {
      if (!complete && stdin.writable) stdin.write(JSON.stringify(message) + '\n');
    };
    const timer = setTimeout(() => finish(null), CATALOG_TIMEOUT_MS);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    stdin.on('error', () => finish(null));
    stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) return finish(null);
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        let message: {
          id?: number;
          result?: { data?: unknown[]; nextCursor?: string | null };
          error?: unknown;
        };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          return finish(null);
        }
        if (message.id === 1) {
          if (message.error || !message.result) return finish(null);
          send({ method: 'initialized', params: {} });
          send({ method: 'model/list', id: 2, params: { limit: 100 } });
        } else if (message.id === 2) {
          if (message.error || !Array.isArray(message.result?.data)) return finish(null);
          const entries = message.result.data;
          for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            const candidate = entry as { model?: unknown; id?: unknown; hidden?: unknown };
            if (candidate.hidden === true) continue;
            const model = typeof candidate.model === 'string' ? candidate.model : candidate.id;
            if (typeof model === 'string') models.push(model);
          }
          pages++;
          if (message.result.nextCursor) {
            if (pages >= 4) return finish(null);
            send({
              method: 'model/list',
              id: 2,
              params: { limit: 100, cursor: message.result.nextCursor },
            });
          } else finish(normalizeModels(models));
        }
        if (complete) break;
      }
    });
    send({
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'noveltea', title: 'NovelTea', version: '1' } },
    });
  });
}

interface ClaudeSdkQuery {
  supportedModels(): Promise<unknown[]>;
  close(): void;
}

/**
 * Claude Code does not expose a documented 'claude models' CLI. Where the
 * locally installed Claude Agent SDK is resolvable, use its supportedModels()
 * control method with an input stream that never sends a model prompt.
 * No SDK install, login, provider API call or assistant turn is initiated
 * by NovelTea as a fallback.
 */
export async function listClaudeSdkModels(
  loader: () => Promise<{ query(options: unknown): ClaudeSdkQuery }> = async () => {
    // Only resolve from our own runtime package tree, not from an untrusted
    // Project's cwd or a renderer-provided package path. No undeclared runtime
    // import enters the packaged Electron main dependency closure.
    const packageName = '@anthropic-ai/claude-agent-sdk';
    const resolved = createRequire(__filename).resolve(packageName);
    return (await import(pathToFileURL(resolved).href)) as {
      query(options: unknown): ClaudeSdkQuery;
    };
  },
): Promise<string[] | null> {
  let query: ClaudeSdkQuery | undefined;
  let endInput: () => void = () => undefined;
  let expired = false;
  const inputDone = new Promise<void>((resolve) => {
    endInput = resolve;
  });
  async function* idleInput(): AsyncGenerator<never, void> {
    await inputDone;
    yield* [];
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const discovery = (async () => {
      const sdk = await loader();
      if (expired) return null;
      query = sdk.query({ prompt: idleInput(), options: { tools: [] } });
      return query.supportedModels();
    })();
    const available = await Promise.race([
      discovery,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Claude SDK model listing timed out.')),
          CATALOG_TIMEOUT_MS,
        );
      }),
    ]);
    if (!Array.isArray(available)) return null;
    return normalizeModels(
      available.map((item) =>
        item && typeof item === 'object'
          ? ((item as { value?: unknown; id?: unknown }).value ?? (item as { id?: unknown }).id)
          : null,
      ),
    );
  } catch {
    return null;
  } finally {
    expired = true;
    if (timeout) clearTimeout(timeout);
    endInput();
    try {
      query?.close();
    } catch {
      /* SDK teardown is best-effort. */
    }
  }
}

export async function discoverRepairModels(
  harness: RepairHarness,
  env?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<RepairModelCatalog> {
  const unavailable: RepairModelCatalog = { harness, status: 'unavailable', models: [] };
  const effectiveEnv = env ?? (await resolveRepairExecutionEnvironment());
  // Distinguish absent tools from an empty successful catalog.
  if (!(await probeRepairHarnesses(effectiveEnv, platform)).includes(harness)) return unavailable;
  const executable = localRepairExecutable(harness, effectiveEnv, platform);
  if (!executable) return unavailable;
  const models =
    harness === 'opencode'
      ? await listOpenCodeModels(executable, effectiveEnv, platform)
      : harness === 'codex'
        ? await listCodexAppServerModels(executable, effectiveEnv, platform)
        : await listClaudeSdkModels();
  return models === null ? unavailable : { harness, status: 'available', models };
}

const catalogCache = new Map<
  string,
  {
    expires: number;
    request: Promise<RepairModelCatalog>;
  }
>();

export function getRepairModelCatalog(harness: RepairHarness): Promise<RepairModelCatalog> {
  const current = catalogCache.get(harness);
  if (current && current.expires > Date.now()) return current.request;
  const request = discoverRepairModels(harness).then((result) => {
    const entry = catalogCache.get(harness);
    if (entry?.request === request)
      entry.expires =
        Date.now() + (result.status === 'available' ? SUCCESS_TTL_MS : FAILURE_TTL_MS);
    return result;
  });
  catalogCache.set(harness, { request, expires: Date.now() + CATALOG_TIMEOUT_MS + 1_000 });
  return request;
}
