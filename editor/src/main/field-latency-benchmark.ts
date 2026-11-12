import type { BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Only entered with the explicit packaged benchmark flag and an isolated fixture. */
export const FIELD_BENCHMARK_FLAG = '--noveltea-field-benchmark';
export const FIELD_BENCHMARK_PREFIX = 'NOVELTEA_FIELD_BENCHMARK_RESULT=';

interface BenchmarkControls {
  setAcknowledgmentDelay: (milliseconds: number) => void;
  patchCalls: () => number;
}

interface SampleSummary {
  count: number;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

interface RunResult {
  delayMs: number;
  idleFrame: SampleSummary;
  input: SampleSummary;
  acknowledgment: SampleSummary;
  patchCalls: number;
  exactPresentation: boolean;
}

export interface FieldBenchmarkResult {
  success: boolean;
  fixture: 'feature-lab-copy';
  host: string;
  environment: {
    node: string;
    electron: string;
    chromium: string;
    cpu: string;
    display: 'xvfb-software' | 'desktop';
  };
  cases: RunResult[];
  savedReadback: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function evaluate<T>(window: BrowserWindow, expression: string): Promise<T> {
  return (await window.webContents.executeJavaScript(expression, true)) as T;
}

async function waitUntil(
  window: BrowserWindow,
  expression: string,
  description: string,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate<boolean>(window, expression)) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function summarize(milliseconds: number[]): SampleSummary {
  const sorted = milliseconds.toSorted((a, b) => a - b);
  const round = (value: number | undefined) =>
    value === undefined ? null : Math.round(value * 100) / 100;
  return {
    count: sorted.length,
    medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    maxMs: round(sorted.at(-1)),
  };
}

/**
 * Real packaged BrowserWindow, Chromium text input events, React and native
 * ProjectSession. The metric is the first post-commit rAF, not physical scanout.
 * The fixture is copied by the launch script; never modify the source Project.
 */
export async function runPackagedFieldBenchmark(
  window: BrowserWindow,
  controls: BenchmarkControls,
): Promise<FieldBenchmarkResult> {
  const result: FieldBenchmarkResult = {
    success: false,
    fixture: 'feature-lab-copy',
    host: `${process.platform}-${process.arch}`,
    environment: {
      node: process.versions.node,
      electron: process.versions.electron ?? '',
      chromium: process.versions.chrome ?? '',
      cpu: os.cpus()[0]?.model ?? 'unknown',
      display: process.platform === 'linux' ? 'xvfb-software' : 'desktop',
    },
    cases: [],
    savedReadback: false,
  };
  const fixture = process.env.NOVELTEA_FIELD_BENCHMARK_PROJECT;
  if (!fixture || !path.isAbsolute(fixture)) {
    result.error = 'Isolated absolute fixture path required.';
    return result;
  }

  try {
    await waitUntil(window, "document.querySelector('#root') !== null", 'renderer root');
    await evaluate(
      window,
      `window.dispatchEvent(new CustomEvent('noveltea-workspace-toolbar-command', { detail: {
        command: 'open-project', projectPath: ${JSON.stringify(fixture)}
      } })); true`,
    );
    // This is the production UI command path, not a direct native test mutation.
    await waitUntil(
      window,
      "document.body.textContent?.includes('Project loaded') === true",
      'Project admission',
    );
    await evaluate(
      window,
      "window.dispatchEvent(new CustomEvent('noveltea-workspace-toolbar-command', { detail: 'project-settings' })); true",
    );
    await waitUntil(
      window,
      "document.querySelector('#project-title') !== null",
      'Project Settings input',
    );

    const prefix = await evaluate<string>(
      window,
      "(document.querySelector('#project-title'))?.value",
    );
    if (typeof prefix !== 'string' || prefix.length === 0) {
      throw new Error('Project Settings title is not an editable input.');
    }
    let expected = prefix;

    for (const delayMs of [0, 500, 1000]) {
      controls.setAcknowledgmentDelay(delayMs);
      const beforeCalls = controls.patchCalls();
      // Separate the host's idle compositor/virtual-display cadence from the
      // editing path. Under Xvfb, frames can miss 16-ms slots without input.
      const idleFrame = await evaluate<number[]>(
        window,
        `(async () => {
          const frames = [];
          let previous = null;
          for (let i = 0; i < 33; i++) {
            const frame = await new Promise(requestAnimationFrame);
            if (previous !== null) frames.push(frame - previous);
            previous = frame;
          }
          return frames;
        })()`,
      );
      await evaluate(
        window,
        `(() => {
          performance.clearMeasures('noveltea.project-edit.input-to-paint-ready');
          performance.clearMeasures('noveltea.project-edit.flush-to-native-ack');
          const input = document.querySelector('#project-title');
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        })(); true`,
      );
      // Interleaved genuine text insertions; enough duration to cross the
      // 500-ms max wait and force multiple native acknowledgments.
      const characters = 'abcde12345fghij67890';
      for (const character of characters) {
        await window.webContents.insertText(character);
        await sleep(30);
      }
      expected += characters;
      await sleep(Math.max(2600, delayMs * 3 + 500));
      const metrics = await evaluate<{
        input: number[];
        acknowledgment: number[];
        exactPresentation: boolean;
      }>(
        window,
        `(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return {
            input: performance.getEntriesByName('noveltea.project-edit.input-to-paint-ready', 'measure')
              .map((entry) => entry.duration),
            acknowledgment: performance.getEntriesByName('noveltea.project-edit.flush-to-native-ack', 'measure')
              .map((entry) => entry.duration),
            exactPresentation: document.querySelector('#project-title')?.value === ${JSON.stringify(expected)}
          };
        })()`,
      );
      result.cases.push({
        delayMs,
        idleFrame: summarize(idleFrame),
        input: summarize(metrics.input),
        acknowledgment: summarize(metrics.acknowledgment),
        patchCalls: controls.patchCalls() - beforeCalls,
        exactPresentation: metrics.exactPresentation,
      });
      if (
        !metrics.exactPresentation ||
        metrics.input.length !== characters.length ||
        metrics.acknowledgment.length === 0 ||
        result.cases.at(-1)!.patchCalls < 1 ||
        result.cases.at(-1)!.patchCalls > 8
      ) {
        throw new Error(
          `Presentation, measured events, or bounded native requests failed at ${delayMs} ms acknowledgment delay.`,
        );
      }
    }

    controls.setAcknowledgmentDelay(0);
    await evaluate(
      window,
      "window.dispatchEvent(new CustomEvent('noveltea-workspace-toolbar-command', { detail: 'save' })); true",
    );
    const projectYaml = path.join(fixture, 'project.yaml');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if ((await readFile(projectYaml, 'utf8')).includes(expected)) {
        result.savedReadback = true;
        break;
      }
      await sleep(250);
    }
    result.success = result.savedReadback && result.cases.every((entry) => entry.exactPresentation);
    if (!result.success) result.error = 'Native saved readback did not match typed presentation.';
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    controls.setAcknowledgmentDelay(0);
    try {
      await evaluate(window, 'window.noveltea.closeActiveProject()');
    } catch {
      // A failed renderer is already reported above.
    }
  }
  return result;
}
