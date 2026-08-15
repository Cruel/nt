function windowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

export function hostPathSeparator(value: string): '/' | '\\' {
  return windowsStylePath(value) || (value.includes('\\') && !value.startsWith('/')) ? '\\' : '/';
}

export function hostPathDirname(value: string | null): string | null {
  if (!value) return null;
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (slash < 0) return null;
  if (slash === 0) return value.slice(0, 1);
  if (slash === 2 && /^[A-Za-z]:[\\/]/.test(value)) return value.slice(0, 3);
  return value.slice(0, slash);
}

export function joinHostPath(root: string, ...parts: string[]): string {
  const separator = hostPathSeparator(root);
  const normalizedRoot = windowsStylePath(root) ? root.replaceAll('/', '\\') : root;
  const trimmedRoot = normalizedRoot.replace(/[\\/]+$/, '');
  const cleanParts = parts.flatMap((part) => part.split(/[\\/]+/).filter(Boolean));
  if (cleanParts.length === 0) return trimmedRoot || (root ? separator : '');
  if (!trimmedRoot)
    return root ? `${separator}${cleanParts.join(separator)}` : cleanParts.join(separator);
  return [trimmedRoot, ...cleanParts].join(separator);
}
