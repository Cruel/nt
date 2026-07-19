/**
 * Resolves signing configuration at the last possible moment.  Project export
 * profiles intentionally cannot contain any of these values.  `env:NAME` is
 * useful for CI and keeps secret values out of Electron preferences as well.
 */
export function resolveSigningSecret(reference: string, label: string): string {
  const environment = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference.trim());
  if (!environment) {
    throw new Error(
      `${label} must be an environment secret reference such as 'env:NOVELTEA_ANDROID_STORE_PASSWORD'.`,
    );
  }
  const value = process.env[environment[1]!];
  if (!value) throw new Error(`${label} environment secret '${environment[1]}' is not available.`);
  return value;
}

export function signingFailure(code: string, message: string) {
  return { severity: 'error' as const, code, path: '/localState/signing', message };
}
