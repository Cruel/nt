export const systemCursorNames = [
  'default',
  'pointer',
  'text',
  'wait',
  'progress',
  'crosshair',
  'move',
  'not-allowed',
  'ns-resize',
  'ew-resize',
  'nesw-resize',
  'nwse-resize',
] as const;

export type SystemCursorName = (typeof systemCursorNames)[number];
