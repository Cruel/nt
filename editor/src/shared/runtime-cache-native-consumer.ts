export function compiledProjectAdmissionRejected(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).compiledProjectAdmissionRejected === true
  );
}

export async function executeCachedRuntimeArtifactWithRecovery<T>(options: {
  readonly cached: boolean;
  readonly execute: () => Promise<T>;
  readonly rebuild: () => Promise<(() => Promise<T>) | null>;
}): Promise<T> {
  const first = await options.execute();
  if (!options.cached || !compiledProjectAdmissionRejected(first)) return first;
  const retry = await options.rebuild();
  return retry ? retry() : first;
}
