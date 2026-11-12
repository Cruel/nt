import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Isolated ordinary controlled input mounted only by the packaged benchmark.
 * No Project/native draft, Save, IPC or other editor mutation participates.
 */
export function PackagedReactInputBaseline() {
  const [value, setValue] = useState('React baseline');
  const [sample, setSample] = useState<{ startedAt: number; sequence: number } | null>(null);
  const sequence = useRef(0);

  useLayoutEffect(() => {
    if (!sample) return;
    const frame = requestAnimationFrame(() => {
      performance.measure('noveltea.project-edit.baseline-input-to-paint-ready', {
        start: sample.startedAt,
        end: performance.now(),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [sample]);

  return (
    <input
      id="field-benchmark-react-baseline"
      aria-label="Packaged React controlled input baseline"
      value={value}
      onChange={(event) => {
        const startedAt = performance.now();
        setValue(event.currentTarget.value);
        setSample({ startedAt, sequence: ++sequence.current });
      }}
    />
  );
}
