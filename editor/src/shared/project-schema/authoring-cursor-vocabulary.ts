import { z } from 'zod';

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

export const systemCursorNameSchema = z.enum(systemCursorNames);
export const cursorNamedIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Cursor ID must use lowercase kebab-case.');
export const cursorTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('system'), cursor: systemCursorNameSchema }).strict(),
  z.object({ kind: z.literal('named'), id: cursorNamedIdSchema }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
]);

export type CursorTarget = z.infer<typeof cursorTargetSchema>;
