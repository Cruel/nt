import type { AuthoringValidationContribution } from './authoring-validation-contributions';

/** Conservative exact-input proof for reuse after a pure Project transformation. */
export function unchangedValidationContributionInputs(
  before: unknown,
  after: unknown,
  contributions: readonly AuthoringValidationContribution[],
): ReadonlyMap<string, AuthoringValidationContribution['sourceRevisions']> {
  const at = (root: unknown, pointer: string): { present: boolean; value: unknown } => {
    let value = root;
    for (const encoded of pointer.slice(1).split('/')) {
      const segment = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment))
        return { present: false, value: undefined };
      value = (value as Record<string, unknown>)[segment];
    }
    return { present: true, value };
  };
  const same = (path: string): boolean => {
    if (!path.startsWith('/') || path === '/' || /~(?![01])/u.test(path)) return false;
    const prior = at(before, path);
    const current = at(after, path);
    return (
      prior.present === current.present &&
      JSON.stringify(prior.value) === JSON.stringify(current.value)
    );
  };
  const reusable = new Map<string, AuthoringValidationContribution['sourceRevisions']>();
  for (const contribution of contributions) {
    if (!contribution.unresolvedInputs && contribution.inputPaths.every(same))
      reusable.set(JSON.stringify(contribution.inputPaths), contribution.sourceRevisions);
  }
  return reusable;
}
