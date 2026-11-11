/**
 * Low-overhead browser Performance entries for packaged editor acceptance.
 *
 * Inspect in Electron DevTools with
 * performance.getEntriesByType('measure').filter((entry) =>
 *   entry.name.startsWith('noveltea.project-edit.'))
 *
 * input-to-paint-ready is measured at the next animation frame after React
 * commits the controlled field value; it is a rendering latency proxy, not
 * proof that pixels were scanned out by the display.
 */
export type ProjectEditTimingPhase = 'input-to-paint-ready' | 'flush-to-native-ack';

export function measureProjectEdit(
  phase: ProjectEditTimingPhase,
  startedAt: number,
  detail: { path: string; sequence: number; ok?: boolean },
): void {
  if (!Number.isFinite(startedAt)) return;
  const clock = globalThis.performance;
  if (typeof clock?.measure !== 'function') return;
  const name = `noveltea.project-edit.${phase}`;
  try {
    // The detail is intentionally limited to path and sequence: do not record
    // typed values, source text or other user content in the timeline.
    clock.measure(name, { start: startedAt, end: clock.now(), detail });
    if (clock.getEntriesByName(name, 'measure').length > 256) clock.clearMeasures(name);
  } catch {
    // Performance API implementations in test hosts may not support options.
    // Metrics must never affect an authoring mutation.
  }
}
