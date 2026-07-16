import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { characterRefSchema, interactableRefSchema, verbRefSchema } from './authoring-flow';
import {
  defaultInteractionProgram,
  interactionContextSchema,
  interactionProgramSchema,
} from './authoring-interaction-programs';
import { parseRoomData } from './authoring-rooms';
import { parseVerbData } from './authoring-verbs';
import { validateVariableRuntimeValue } from './authoring-variable-usage';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const interactionSubjectSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('character'), character: characterRefSchema }),
  strict({ kind: z.literal('interactable'), interactable: interactableRefSchema }),
]);
export const interactionOperandSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('exact'), subject: interactionSubjectSchema }),
  strict({ kind: z.literal('any-character') }),
  strict({ kind: z.literal('any-interactable') }),
  strict({ kind: z.literal('any-subject') }),
]);

export const interactionRuleSchema = strict({
  id: entityIdSchema,
  verb: verbRefSchema,
  operands: z.array(interactionOperandSchema).max(2),
  context: interactionContextSchema,
  program: interactionProgramSchema,
});

export const interactionDataSchema = strict({
  kind: z.literal('interaction'),
  rules: z.array(interactionRuleSchema),
});

export type InteractionOperand = z.infer<typeof interactionOperandSchema>;
export type InteractionRule = z.infer<typeof interactionRuleSchema>;
export type InteractionData = z.infer<typeof interactionDataSchema>;
export interface InteractionSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

const diagnostic = (
  path: string,
  message: string,
  severity: InteractionSchemaDiagnostic['severity'] = 'error',
): InteractionSchemaDiagnostic => ({ path, message, severity, category: 'authoring-interactions' });

export function parseInteractionData(value: unknown): InteractionData | null {
  const parsed = interactionDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultInteractionData(): InteractionData {
  return { kind: 'interaction', rules: [] };
}

function validateRoomPlacement(
  project: AuthoringProject,
  roomId: string,
  placementId: string,
  path: string,
  diagnostics: InteractionSchemaDiagnostic[],
) {
  const room = project.rooms[roomId];
  const roomData = room ? parseRoomData(room.data) : null;
  if (!room) diagnostics.push(diagnostic(`${path}/room`, `Missing room '${roomId}'.`));
  else if (!roomData?.placements.some((placement) => placement.id === placementId)) {
    diagnostics.push(diagnostic(`${path}/placement`, `Missing placement '${placementId}' in room '${roomId}'.`));
  }
}

function validateFlowTarget(project: AuthoringProject, target: InteractionRule['program']['completion'], path: string, diagnostics: InteractionSchemaDiagnostic[]) {
  if (target.kind === 'room' && !project.rooms[target.id]) diagnostics.push(diagnostic(`${path}/id`, `Missing room '${target.id}'.`));
  if (target.kind === 'scene' && !project.scenes[target.id]) diagnostics.push(diagnostic(`${path}/id`, `Missing scene '${target.id}'.`));
  if (target.kind === 'dialogue' && !project.dialogues[target.id]) diagnostics.push(diagnostic(`${path}/id`, `Missing dialogue '${target.id}'.`));
}

export function validateInteractionProgram(project: AuthoringProject, program: InteractionRule['program'], path: string): InteractionSchemaDiagnostic[] {
  const diagnostics: InteractionSchemaDiagnostic[] = [];
  const instructionIds = new Set<string>();
  for (const [index, instruction] of program.instructions.entries()) {
    const instructionPath = `${path}/instructions/${index}`;
    if (instructionIds.has(instruction.id)) diagnostics.push(diagnostic(`${instructionPath}/id`, `Duplicate interaction instruction ID '${instruction.id}'.`));
    instructionIds.add(instruction.id);
    if ((instruction.kind === 'move-interactable' || instruction.kind === 'set-interactable-state') && !project.interactables[instruction.interactable.$ref.id]) {
      diagnostics.push(diagnostic(`${instructionPath}/interactable/$ref`, `Missing interactable '${instruction.interactable.$ref.id}'.`));
    }
    if (instruction.kind === 'set-interactable-state' && instruction.enabled === undefined && instruction.visible === undefined) {
      diagnostics.push(diagnostic(instructionPath, 'SetInteractableState must set enabled and/or visible.'));
    }
    if (instruction.kind === 'move-interactable' && instruction.target.kind === 'room-placement') {
      validateRoomPlacement(project, instruction.target.placement.room, instruction.target.placement.placement, `${instructionPath}/target/placement`, diagnostics);
    }
    if (instruction.kind === 'call-scene' && !project.scenes[instruction.scene.$ref.id]) diagnostics.push(diagnostic(`${instructionPath}/scene/$ref`, `Missing scene '${instruction.scene.$ref.id}'.`));
    if (instruction.kind === 'call-dialogue' && !project.dialogues[instruction.dialogue.$ref.id]) diagnostics.push(diagnostic(`${instructionPath}/dialogue/$ref`, `Missing dialogue '${instruction.dialogue.$ref.id}'.`));
    if (instruction.kind === 'apply-effect' && instruction.effect.kind === 'set-variable') {
      const result = validateVariableRuntimeValue(
        project,
        instruction.effect.variable.$ref.id,
        instruction.effect.value,
      );
      if (!result.ok) {
        diagnostics.push(diagnostic(
          result.kind === 'missing'
            ? `${instructionPath}/effect/variable/$ref`
            : `${instructionPath}/effect/value`,
          result.message,
        ));
      }
    }
  }
  validateFlowTarget(project, program.completion, `${path}/completion`, diagnostics);
  return diagnostics;
}

export function validateInteractionData(project: AuthoringProject, interactionId: string, record: AuthoringRecordBase): InteractionSchemaDiagnostic[] {
  const base = `/interactions/${interactionId}/data`;
  const parsed = interactionDataSchema.safeParse(record.data);
  if (!parsed.success) return parsed.error.issues.map((issue) => diagnostic(`${base}/${issue.path.join('/')}`, issue.message));
  const diagnostics: InteractionSchemaDiagnostic[] = [];
  const seen = new Set<string>();
  const matchKeys = new Map<string, number>();
  for (const [index, rule] of parsed.data.rules.entries()) {
    const path = `${base}/rules/${index}`;
    if (seen.has(rule.id)) diagnostics.push(diagnostic(`${path}/id`, `Duplicate interaction rule ID '${rule.id}'.`));
    seen.add(rule.id);
    const verb = project.verbs[rule.verb.$ref.id];
    const verbData = verb ? parseVerbData(verb.data) : null;
    if (!verbData) diagnostics.push(diagnostic(`${path}/verb/$ref`, `Missing or invalid verb '${rule.verb.$ref.id}'.`));
    else if (verbData.arity !== rule.operands.length) diagnostics.push(diagnostic(`${path}/operands`, `Interaction rule operands must match verb '${rule.verb.$ref.id}' arity ${verbData.arity}.`));
    for (const [operandIndex, operand] of rule.operands.entries()) {
      if (operand.kind === 'exact' && operand.subject.kind === 'interactable' && !project.interactables[operand.subject.interactable.$ref.id]) {
        diagnostics.push(diagnostic(`${path}/operands/${operandIndex}/subject/interactable/$ref`, `Missing interactable '${operand.subject.interactable.$ref.id}'.`));
      }
      if (operand.kind === 'exact' && operand.subject.kind === 'character' && !project.characters[operand.subject.character.$ref.id]) {
        diagnostics.push(diagnostic(`${path}/operands/${operandIndex}/subject/character/$ref`, `Missing character '${operand.subject.character.$ref.id}'.`));
      }
    }
    if (rule.context.kind === 'active-room' && !project.rooms[rule.context.room.$ref.id]) diagnostics.push(diagnostic(`${path}/context/room/$ref`, `Missing room '${rule.context.room.$ref.id}'.`));
    if (rule.context.kind === 'room-placement') validateRoomPlacement(project, rule.context.placement.room, rule.context.placement.placement, `${path}/context/placement`, diagnostics);
    if (rule.context.kind === 'predicate' && rule.context.condition.kind === 'variable-comparison') {
      const condition = rule.context.condition;
      const variableId = condition.variable.$ref.id;
      if (condition.value === undefined) {
        if (!project.variables[variableId]) diagnostics.push(diagnostic(`${path}/context/condition/variable/$ref`, `Missing variable '${variableId}'.`));
      } else {
        const result = validateVariableRuntimeValue(project, variableId, condition.value);
        if (!result.ok) diagnostics.push(diagnostic(result.kind === 'missing' ? `${path}/context/condition/variable/$ref` : `${path}/context/condition/value`, result.message));
      }
    }
    diagnostics.push(...validateInteractionProgram(project, rule.program, `${path}/program`));
    const key = JSON.stringify({
      verb: rule.verb.$ref.id,
      operands: rule.operands.map((operand) => operand.kind === 'exact' ? operand.subject : operand.kind),
      context: rule.context,
    });
    const earlier = matchKeys.get(key);
    if (earlier !== undefined) diagnostics.push(diagnostic(path, `Rule has equal matching specificity to rule '${parsed.data.rules[earlier]?.id}'. Declared order is the tie-break.`, 'warning'));
    else matchKeys.set(key, index);
  }
  return diagnostics;
}

export { defaultInteractionProgram };
