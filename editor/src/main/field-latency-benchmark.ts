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
  surface: string;
  field: string;
  delayMs: number;
  baseline: boolean;
  idleFrame: SampleSummary;
  input: SampleSummary;
  acknowledgment: SampleSummary;
  patchCalls: number;
  exactPresentation: boolean;
}

export interface FieldBenchmarkResult {
  success: boolean;
  diagnosticOnly: boolean;
  fixture: 'feature-lab-copy';
  host: string;
  environment: {
    node: string;
    electron: string;
    chromium: string;
    cpu: string;
    display: 'xvfb-software' | 'ci-headless' | 'desktop';
  };
  measurement: 'next-frame-after-React-commit-proxy';
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
    diagnosticOnly: process.env.NOVELTEA_FIELD_BENCHMARK_DIAGNOSTIC === 'records',
    fixture: 'feature-lab-copy',
    host: `${process.platform}-${process.arch}`,
    environment: {
      node: process.versions.node,
      electron: process.versions.electron ?? '',
      chromium: process.versions.chrome ?? '',
      cpu: os.cpus()[0]?.model ?? 'unknown',
      display:
        process.platform === 'linux' ? 'xvfb-software' : process.env.CI ? 'ci-headless' : 'desktop',
    },
    measurement: 'next-frame-after-React-commit-proxy',
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
    // Opt into an isolated, ordinary React controlled input in the same
    // packaged renderer. It intentionally has no Project/native work.
    await evaluate(
      window,
      "sessionStorage.setItem('noveltea-field-benchmark-baseline', 'enabled'); true",
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

    const expectedByField = new Map<string, string>();
    async function sampleInput({
      surface,
      field,
      selector,
      path: fieldPath,
      delayMs,
      baseline = false,
    }: {
      surface: string;
      field: string;
      selector: string;
      path?: string;
      delayMs: number;
      baseline?: boolean;
    }) {
      controls.setAcknowledgmentDelay(delayMs);
      const beforeCalls = controls.patchCalls();
      // Separate the host's idle compositor/virtual-display cadence from the
      // editing path. Under Xvfb, frames can miss 16-ms slots without input.
      const idleFrame = await evaluate<number[]>(
        window,
        `(async () => {
          const frames = [];
          let previous = null;
          for (let i = 0; i < 25; i++) {
            const frame = await new Promise(requestAnimationFrame);
            if (previous !== null) frames.push(frame - previous);
            previous = frame;
          }
          return frames;
        })()`,
      );
      const beforeValue = await evaluate<string>(
        window,
        `document.querySelector(${JSON.stringify(selector)})?.value`,
      );
      if (typeof beforeValue !== 'string') throw new Error(`Missing editable ${surface} ${field}`);
      await evaluate(
        window,
        `(() => {
          performance.clearMeasures('noveltea.project-edit.input-to-paint-ready');
          performance.clearMeasures('noveltea.project-edit.baseline-input-to-paint-ready');
          performance.clearMeasures('noveltea.project-edit.flush-to-native-ack');
          const input = document.querySelector(${JSON.stringify(selector)});
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
      const expected = beforeValue + characters;
      await sleep(baseline ? 150 : Math.max(2600, delayMs * 3 + 500));
      const metrics = await evaluate<{
        input: number[];
        acknowledgment: number[];
        exactPresentation: boolean;
      }>(
        window,
        `(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return {
            input: performance.getEntriesByName(${JSON.stringify(
              baseline
                ? 'noveltea.project-edit.baseline-input-to-paint-ready'
                : 'noveltea.project-edit.input-to-paint-ready',
            )}, 'measure')
              .filter((entry) => ${baseline ? 'true' : `entry.detail?.path === ${JSON.stringify(fieldPath)}`})
              .map((entry) => entry.duration),
            acknowledgment: performance.getEntriesByName('noveltea.project-edit.flush-to-native-ack', 'measure')
              .filter((entry) => entry.detail?.path === ${JSON.stringify(fieldPath)})
              .map((entry) => entry.duration),
            exactPresentation: document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(expected)}
          };
        })()`,
      );
      const entry: RunResult = {
        surface,
        field,
        delayMs,
        baseline,
        idleFrame: summarize(idleFrame),
        input: summarize(metrics.input),
        acknowledgment: summarize(metrics.acknowledgment),
        patchCalls: controls.patchCalls() - beforeCalls,
        exactPresentation: metrics.exactPresentation,
      };
      result.cases.push(entry);
      if (
        !metrics.exactPresentation ||
        metrics.input.length !== characters.length ||
        (!baseline && metrics.acknowledgment.length === 0) ||
        (baseline ? entry.patchCalls !== 0 : entry.patchCalls < 1 || entry.patchCalls > 8)
      ) {
        throw new Error(
          `${surface}/${field}: presentation, measured events, or bounded native requests failed at ${delayMs} ms delay: ${JSON.stringify(entry)}`,
        );
      }
      if (!baseline) expectedByField.set(field, expected);
    }

    if (!result.diagnosticOnly) {
      await waitUntil(
        window,
        "document.querySelector('#field-benchmark-react-baseline') !== null",
        'controlled React baseline',
      );
      await sampleInput({
        surface: 'baseline',
        field: 'controlled-react-input',
        selector: '#field-benchmark-react-baseline',
        delayMs: 0,
        baseline: true,
      });
      for (const [field, selector, fieldPath] of [
        ['title', '#project-title', '/project/name'],
        ['version', '#project-version', '/project/version'],
        ['author', '#project-author', '/project/author'],
        ['description', '#project-description', '/project/description'],
      ]) {
        for (const delayMs of [0, 500, 1000]) {
          await sampleInput({
            surface: 'project-settings',
            field,
            selector,
            path: fieldPath,
            delayMs,
          });
        }
      }
      controls.setAcknowledgmentDelay(0);
      await evaluate(
        window,
        "window.dispatchEvent(new CustomEvent('noveltea-workspace-toolbar-command', { detail: 'save' })); true",
      );
    }
    async function verifySaved(relativePath: string, expected: string) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if ((await readFile(path.join(fixture!, relativePath), 'utf8')).includes(expected)) return;
        await sleep(250);
      }
      throw new Error(`Native Save readback mismatch in ${relativePath}`);
    }
    if (!result.diagnosticOnly) {
      for (const field of ['title', 'version', 'author', 'description']) {
        await verifySaved('project.yaml', expectedByField.get(field)!);
      }
    }

    // Drive the actual Explorer and record editor rather than bypassing
    // native ProjectSession via a scripted patch.
    async function openRecord(
      collection: 'rooms' | 'characters' | 'interactables',
      entityId: string,
    ) {
      const selector = `button[data-explorer-node-id^="record:${collection}:${entityId}"]`;
      if (
        !(await evaluate<boolean>(
          window,
          `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
        ))
      ) {
        await evaluate(
          window,
          `(() => {
            const category = document.querySelector('button[data-explorer-node-id="collection:${collection}"]');
            if (!document.querySelector('button[data-explorer-node-id^="chapter:${collection}:"]')) category?.click();
          })(); true`,
        );
        await sleep(350);
      }
      if (
        !(await evaluate<boolean>(
          window,
          `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
        ))
      ) {
        await evaluate(
          window,
          `(() => {
            for (const chapter of document.querySelectorAll('button[data-explorer-node-id^="chapter:${collection}:"]')) chapter.click();
          })(); true`,
        );
        await sleep(350);
      }
      const available = await evaluate<{ found: boolean; nodes: string[] }>(
        window,
        `(() => ({
          found: Boolean(document.querySelector(${JSON.stringify(selector)})),
          nodes: [...document.querySelectorAll('[data-explorer-node-id]')]
            .map((element) => element.getAttribute('data-explorer-node-id')).filter(Boolean).slice(0, 35),
        }))()`,
      );
      if (!available.found) {
        throw new Error(
          `Missing Explorer record ${collection}/${entityId}; visible node IDs: ${JSON.stringify(available.nodes)}`,
        );
      }
      await evaluate(window, `document.querySelector(${JSON.stringify(selector)}).click(); true`);
    }
    for (const record of [
      {
        collection: 'rooms' as const,
        entityId: 'feature-lab-home',
        fields: [
          {
            selector: 'input[aria-label="Room display name"]',
            field: 'room-display-name',
            path: '/rooms/feature-lab-home/data/displayName',
            saveFile: 'records/rooms/feature-lab-home.yaml',
          },
        ],
      },
      {
        collection: 'characters' as const,
        entityId: 'pilot-guide',
        fields: [
          {
            selector: '[data-workbench-anchor="character.summary"] input',
            field: 'character-display-name',
            path: '/characters/pilot-guide/data/displayName',
            saveFile: 'records/characters/pilot-guide.yaml',
          },
          {
            selector: '[data-workbench-anchor="character.summary"] > div:nth-child(2) input',
            field: 'character-dialogue-name',
            path: '/characters/pilot-guide/data/dialogue/name',
            saveFile: 'records/characters/pilot-guide.yaml',
          },
        ],
      },
      {
        collection: 'interactables' as const,
        entityId: 'gate-lever',
        fields: [
          {
            selector: '[data-workbench-anchor="interactable.summary"] input',
            field: 'interactable-display-name',
            path: '/interactables/gate-lever/data/displayName',
            saveFile: 'records/interactables/gate-lever.yaml',
          },
          {
            selector: '#interactable-editor-label-gate-lever-1',
            field: 'exact-instance-editor-label',
            path: '/interactableInstances/gate-lever-1/editorLabel',
            saveFile: 'project.yaml',
          },
        ],
      },
    ]) {
      await openRecord(record.collection, record.entityId);
      if (record.collection === 'rooms') {
        // Room opens on its Composition category; the name lives under General.
        await waitUntil(
          window,
          `document.querySelector('nav[aria-label="Room editor categories"] button[aria-label="General"]') !== null`,
          'Room category navigation',
        );
        await evaluate(
          window,
          `document.querySelector('nav[aria-label="Room editor categories"] button[aria-label="General"]').click(); true`,
        );
      }
      for (const field of record.fields) {
        await waitUntil(
          window,
          `document.querySelector(${JSON.stringify(field.selector)}) !== null`,
          `${record.collection}/${field.field} editor`,
        );
        for (const delayMs of result.diagnosticOnly ? [0] : [0, 500, 1000]) {
          await sampleInput({
            surface: record.collection,
            field: field.field,
            selector: field.selector,
            path: field.path,
            delayMs,
          });
        }
      }
      if (record.collection === 'rooms' && !result.diagnosticOnly) {
        // The numeric control has a different parser and buffered-input
        // contract. Replace its selected contents with one valid numeric
        // insertion instead of sending nonsensical alphabetic characters.
        const numericSelector = 'input[aria-label="World presentation width"]';
        await evaluate(
          window,
          `document.querySelector('nav[aria-label="Room editor categories"] button[aria-label="Camera"]').click(); true`,
        );
        await waitUntil(
          window,
          `document.querySelector(${JSON.stringify(numericSelector)}) !== null`,
          'Room Camera numeric input',
        );
        for (const delayMs of [0, 1000]) {
          controls.setAcknowledgmentDelay(delayMs);
          const patchCallsBefore = controls.patchCalls();
          await evaluate(
            window,
            `(() => {
              performance.clearMeasures('noveltea.project-edit.input-to-paint-ready');
              performance.clearMeasures('noveltea.project-edit.flush-to-native-ack');
              const input = document.querySelector(${JSON.stringify(numericSelector)});
              input.focus();
            })(); true`,
          );
          // Number inputs do not support setSelectionRange/select(). Exercise
          // the actual Chromium keyboard selection path instead.
          const selectionModifier = process.platform === 'darwin' ? 'meta' : 'control';
          window.webContents.sendInputEvent({
            type: 'keyDown',
            keyCode: 'A',
            modifiers: [selectionModifier],
          });
          window.webContents.sendInputEvent({
            type: 'keyUp',
            keyCode: 'A',
            modifiers: [selectionModifier],
          });
          const next = delayMs === 0 ? '1877' : '1888';
          await window.webContents.insertText(next);
          await sleep(Math.max(2600, delayMs * 3 + 500));
          const numericPath = '/rooms/feature-lab-home/data/presentationSpace/size/width';
          const measurements = await evaluate<{
            input: number[];
            acknowledgment: number[];
            exactPresentation: boolean;
          }>(
            window,
            `(() => ({
              input: performance.getEntriesByName('noveltea.project-edit.input-to-paint-ready', 'measure')
                .filter((entry) => entry.detail?.path === ${JSON.stringify(numericPath)})
                .map((entry) => entry.duration),
              acknowledgment: performance.getEntriesByName('noveltea.project-edit.flush-to-native-ack', 'measure')
                .filter((entry) => entry.detail?.path === ${JSON.stringify(numericPath)})
                .map((entry) => entry.duration),
              exactPresentation: document.querySelector(${JSON.stringify(numericSelector)})?.value === ${JSON.stringify(next)}
            }))()`,
          );
          const entry: RunResult = {
            surface: 'rooms',
            field: 'camera-width-selection-replacement',
            delayMs,
            baseline: false,
            idleFrame: summarize([]),
            input: summarize(measurements.input),
            acknowledgment: summarize(measurements.acknowledgment),
            patchCalls: controls.patchCalls() - patchCallsBefore,
            exactPresentation: measurements.exactPresentation,
          };
          result.cases.push(entry);
          if (
            !entry.exactPresentation ||
            entry.input.count !== 1 ||
            entry.acknowledgment.count === 0 ||
            entry.patchCalls < 1 ||
            entry.patchCalls > 3
          ) {
            throw new Error(`Room numeric selection replacement failed: ${JSON.stringify(entry)}`);
          }
        }
      }
      controls.setAcknowledgmentDelay(0);
      await evaluate(
        window,
        "window.dispatchEvent(new CustomEvent('noveltea-workspace-toolbar-command', { detail: 'save' })); true",
      );
      for (const field of record.fields) {
        await verifySaved(field.saveFile, expectedByField.get(field.field)!);
      }
      if (record.collection === 'rooms' && !result.diagnosticOnly) {
        await verifySaved('records/rooms/feature-lab-home.yaml', 'width: 1888');
      }
    }
    result.savedReadback = true;
    result.success = result.cases.every((entry) => entry.exactPresentation);
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
