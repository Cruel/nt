import type { ExportPlatform } from './platform-export-contracts';

export interface TargetPathEntry { sourceId: string; targetPath: string }
export interface TargetPathDiagnostic {
  code: 'absolute-path' | 'archive-traversal' | 'invalid-segment' | 'windows-reserved-name' | 'windows-invalid-name' | 'path-too-long' | 'case-collision' | 'unicode-collision';
  severity: 'error'; sourceIds: string[]; targetPaths: string[]; message: string;
}
export interface TargetPathValidationOptions { maximumPathLength?: number }

const windowsDevices = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const isWindowsLike = (target: ExportPlatform) => target === 'windows' || target === 'android';

export function validateTargetPaths(entries: TargetPathEntry[], target: ExportPlatform, options: TargetPathValidationOptions = {}): TargetPathDiagnostic[] {
  const diagnostics: TargetPathDiagnostic[] = [];
  const maximum = options.maximumPathLength ?? (target === 'windows' ? 240 : 1024);
  const valid: TargetPathEntry[] = [];
  const add = (code: TargetPathDiagnostic['code'], entry: TargetPathEntry, message: string) => diagnostics.push({ code, severity: 'error', sourceIds: [entry.sourceId], targetPaths: [entry.targetPath], message });
  for (const entry of entries) {
    const path = entry.targetPath;
    if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(path)) { add('absolute-path', entry, `Target path '${path}' must be relative.`); continue; }
    const parts = path.split(/[\\/]/);
    if (parts.includes('..')) { add('archive-traversal', entry, `Target path '${path}' escapes the artifact root.`); continue; }
    if (!path || parts.some((part) => !part || part === '.')) { add('invalid-segment', entry, `Target path '${path}' contains an empty or dot segment.`); continue; }
    if (isWindowsLike(target)) {
      const reserved = parts.find((part) => windowsDevices.test(part));
      if (reserved) add('windows-reserved-name', entry, `Target path '${path}' contains reserved name '${reserved}'.`);
      const invalid = parts.find((part) => /[<>:"|?*]/.test(part) || /[. ]$/.test(part));
      if (invalid) add('windows-invalid-name', entry, `Target path '${path}' contains an invalid Windows segment '${invalid}'.`);
    }
    if (path.length > maximum) add('path-too-long', entry, `Target path '${path}' exceeds the ${maximum}-character target limit.`);
    valid.push(entry);
  }
  const collide = (code: 'case-collision' | 'unicode-collision', key: (path: string) => string) => {
    const groups = new Map<string, TargetPathEntry[]>();
    for (const entry of valid) groups.set(key(entry.targetPath), [...(groups.get(key(entry.targetPath)) ?? []), entry]);
    for (const group of groups.values()) if (group.length > 1 && new Set(group.map((item) => item.targetPath)).size > 1) diagnostics.push({
      code, severity: 'error', sourceIds: group.map((item) => item.sourceId).sort(), targetPaths: group.map((item) => item.targetPath).sort(),
      message: `Target paths collide after ${code === 'case-collision' ? 'case folding' : 'Unicode normalization'}.`,
    });
  };
  if (target === 'windows' || target === 'macos' || target === 'android') collide('case-collision', (path) => path.normalize('NFC').toLocaleLowerCase('en-US'));
  collide('unicode-collision', (path) => path.normalize('NFC'));
  return diagnostics.sort((a, b) => a.code.localeCompare(b.code) || a.targetPaths.join('\0').localeCompare(b.targetPaths.join('\0')));
}
