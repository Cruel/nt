/** Main-process native-session tripwire, separate from the CLI certification
 * poison. Modules may remain bundled before #521, but none can initialize
 * retired Project authority once the native editor lifecycle is admitted. */
let nativeEditorGuards = 0;

export function guardNativeEditorProjectAuthority(): () => void {
  nativeEditorGuards += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    nativeEditorGuards -= 1;
  };
}

export function assertNoLegacyProjectAuthority(owner: string): void {
  if (nativeEditorGuards)
    throw new Error(`Native editor reached retired TypeScript Project authority: ${owner}.`);
}
