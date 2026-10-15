/** True only when constant-rate sampling selects a source presentation sample more than once.
 * Uses real source PTS (including irregular VFR gaps), never nominal/average source FPS.
 * FFmpeg fps uses nearest input presentation timestamps for round=near.
 */
export function targetFpsDuplicatesSource(
  sourceTimesMs: readonly number[],
  endpointMs: number,
  fps: { numerator: number; denominator: number },
): boolean {
  if (
    !sourceTimesMs.length ||
    !Number.isFinite(endpointMs) ||
    endpointMs <= 0 ||
    !Number.isSafeInteger(fps.numerator) ||
    fps.numerator <= 0 ||
    !Number.isSafeInteger(fps.denominator) ||
    fps.denominator <= 0
  )
    throw new Error('Invalid source timeline or target frame rate.');
  const periodMs = (fps.denominator * 1000) / fps.numerator;
  if (!Number.isFinite(periodMs) || periodMs <= 0)
    throw new Error('Invalid target frame interval.');
  const slots = Math.ceil(endpointMs / periodMs);
  if (slots > sourceTimesMs.length) return true;
  let nearest = 0;
  let previous = -1;
  for (let slot = 0; slot < slots; slot += 1) {
    const time = slot * periodMs;
    while (
      nearest + 1 < sourceTimesMs.length &&
      sourceTimesMs[nearest + 1]! - time <= time - sourceTimesMs[nearest]!
    )
      nearest += 1;
    if (nearest === previous) return true;
    previous = nearest;
  }
  return false;
}
