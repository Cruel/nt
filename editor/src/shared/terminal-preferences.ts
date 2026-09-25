export interface TerminalPreferences {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fallbackCwd: string | null;
  scrollback: number;
  desktopNotifications: boolean;
}

export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 13,
  lineHeight: 1,
  fallbackCwd: null,
  scrollback: 10_000,
  desktopNotifications: true,
};

export function normalizeTerminalPreferences(value: unknown): TerminalPreferences {
  const candidate =
    value && typeof value === 'object' ? (value as Partial<TerminalPreferences>) : {};
  const fontFamily =
    typeof candidate.fontFamily === 'string' && candidate.fontFamily.trim().length > 0
      ? candidate.fontFamily.trim()
      : DEFAULT_TERMINAL_PREFERENCES.fontFamily;
  const fontSize = Number(candidate.fontSize);
  const lineHeight = Number(candidate.lineHeight);
  const scrollback = Number(candidate.scrollback);
  return {
    fontFamily,
    fontSize: Number.isFinite(fontSize) ? Math.min(32, Math.max(8, Math.round(fontSize))) : 13,
    lineHeight: Number.isFinite(lineHeight) ? Math.min(3, Math.max(1, lineHeight)) : 1,
    fallbackCwd:
      candidate.fallbackCwd === null
        ? null
        : typeof candidate.fallbackCwd === 'string' && candidate.fallbackCwd.trim().length > 0
          ? candidate.fallbackCwd
          : null,
    scrollback: Number.isFinite(scrollback)
      ? Math.min(100_000, Math.max(100, Math.round(scrollback)))
      : 10_000,
    desktopNotifications:
      typeof candidate.desktopNotifications === 'boolean'
        ? candidate.desktopNotifications
        : DEFAULT_TERMINAL_PREFERENCES.desktopNotifications,
  };
}
