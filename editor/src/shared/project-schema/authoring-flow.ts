import { z } from 'zod';
import { entityIdSchema } from './authoring-common';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const typedRef = <Collection extends string>(collection: Collection) => strict({
  $ref: strict({ collection: z.literal(collection), id: entityIdSchema }),
});

export const assetRefSchema = typedRef('assets');
export const materialRefSchema = typedRef('materials');
export const characterRefSchema = typedRef('characters');
export const dialogueRefSchema = typedRef('dialogues');
export const layoutRefSchema = typedRef('layouts');
export const variableRefSchema = typedRef('variables');
export const roomRefSchema = typedRef('rooms');
export const sceneRefSchema = typedRef('scenes');
export const scriptRefSchema = typedRef('scripts');

export const runtimeScalarSchema = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
]);

export const flowTargetSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('scene'), id: entityIdSchema }),
  strict({ kind: z.literal('dialogue'), id: entityIdSchema }),
  strict({ kind: z.literal('room'), id: entityIdSchema }),
  strict({ kind: z.literal('return') }),
  strict({ kind: z.literal('end') }),
]);

export const textSourceSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inline'), text: z.string() }),
  strict({ kind: z.literal('localized'), key: entityIdSchema }),
  strict({ kind: z.literal('lua-expression'), source: z.string().min(1) }),
]);

export const textContentSchema = strict({
  source: textSourceSchema,
  markup: z.enum(['plain', 'active-text']),
});

export const conditionSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('always') }),
  strict({
    kind: z.literal('variable-comparison'),
    variable: variableRefSchema,
    operator: z.enum([
      'equal', 'not-equal', 'less', 'less-equal',
      'greater', 'greater-equal', 'truthy', 'falsy',
    ]),
    value: runtimeScalarSchema.optional(),
  }),
  strict({ kind: z.literal('lua-predicate'), source: z.string().min(1) }),
]);

export const effectSchema = z.discriminatedUnion('kind', [
  strict({
    kind: z.literal('set-variable'),
    variable: variableRefSchema,
    value: runtimeScalarSchema,
  }),
  strict({ kind: z.literal('run-lua-effect'), source: z.string().min(1) }),
]);

export type AssetRef = z.infer<typeof assetRefSchema>;
export type MaterialRef = z.infer<typeof materialRefSchema>;
export type CharacterRef = z.infer<typeof characterRefSchema>;
export type DialogueRef = z.infer<typeof dialogueRefSchema>;
export type LayoutRef = z.infer<typeof layoutRefSchema>;
export type VariableRef = z.infer<typeof variableRefSchema>;
export type RoomRef = z.infer<typeof roomRefSchema>;
export type SceneRef = z.infer<typeof sceneRefSchema>;
export type ScriptRef = z.infer<typeof scriptRefSchema>;
export type RuntimeScalar = z.infer<typeof runtimeScalarSchema>;
export type FlowTarget = z.infer<typeof flowTargetSchema>;
export type TextSource = z.infer<typeof textSourceSchema>;
export type TextContent = z.infer<typeof textContentSchema>;
export type Condition = z.infer<typeof conditionSchema>;
export type Effect = z.infer<typeof effectSchema>;

export const inlineTextContent = (text = '', markup: TextContent['markup'] = 'active-text'): TextContent => ({
  source: { kind: 'inline', text },
  markup,
});
