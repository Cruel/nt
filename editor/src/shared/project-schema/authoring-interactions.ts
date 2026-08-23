import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { verbRefSchema } from './authoring-flow';
import type { FeatureRefData } from './authoring-features';
import {
  defaultInteractionProgram,
  interactionContextSchema,
  interactionProgramSchema,
} from './authoring-interaction-programs';
import { parseInteractableData } from './authoring-interactables';
import { parseRoomData } from './authoring-rooms';
import { parseVerbData, subjectSelectorSchema } from './authoring-verbs';
import { validateVariableRuntimeValue } from './authoring-variable-usage';
import { validateInventoryReference } from './authoring-inventory-validation';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export { interactionSubjectSchema } from './authoring-features';
export const interactionSlotSelectorSchema = strict({
  slotId: entityIdSchema,
  selectors: z.array(subjectSelectorSchema).min(1),
});

export const interactionRuleSchema = strict({
  id: entityIdSchema,
  verb: verbRefSchema,
  slots: z.array(interactionSlotSelectorSchema),
  context: interactionContextSchema,
  program: interactionProgramSchema,
});

export const interactionDataSchema = strict({
  kind: z.literal('interaction'),
  rules: z.array(interactionRuleSchema),
});

export type InteractionSlotSelector = z.infer<typeof interactionSlotSelectorSchema>;
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
): InteractionSchemaDiagnostic => ({ path, message, severity, category: 'Interactions' });

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
    diagnostics.push(
      diagnostic(`${path}/placement`, `Missing placement '${placementId}' in room '${roomId}'.`),
    );
  }
}

function validateFeatureRef(
  project: AuthoringProject,
  feature: FeatureRefData,
  path: string,
  diagnostics: InteractionSchemaDiagnostic[],
) {
  if (feature.ownerKind === 'room') {
    const roomId = feature.room.$ref.id;
    const room = parseRoomData(project.rooms[roomId]?.data);
    if (!room)
      diagnostics.push(diagnostic(`${path}/room/$ref`, `Missing or invalid Room '${roomId}'.`));
    else if (!room.features.some((candidate) => candidate.id === feature.featureId))
      diagnostics.push(
        diagnostic(
          `${path}/featureId`,
          `Missing Feature '${feature.featureId}' on Room '${roomId}'.`,
        ),
      );
    return;
  }
  const interactableId = feature.interactable.$ref.id;
  const interactable = parseInteractableData(project.interactables[interactableId]?.data);
  if (!interactable)
    diagnostics.push(
      diagnostic(
        `${path}/interactable/$ref`,
        `Missing or invalid Interactable '${interactableId}'.`,
      ),
    );
  else if (!interactable.features.some((candidate) => candidate.id === feature.featureId))
    diagnostics.push(
      diagnostic(
        `${path}/featureId`,
        `Missing Feature '${feature.featureId}' on Interactable '${interactableId}'.`,
      ),
    );
}

function validateFlowTarget(
  project: AuthoringProject,
  target: InteractionRule['program']['completion'],
  path: string,
  diagnostics: InteractionSchemaDiagnostic[],
) {
  if (target.kind === 'room' && !project.rooms[target.id])
    diagnostics.push(diagnostic(`${path}/id`, `Missing room '${target.id}'.`));
  if (target.kind === 'scene' && !project.scenes[target.id])
    diagnostics.push(diagnostic(`${path}/id`, `Missing scene '${target.id}'.`));
  if (target.kind === 'dialogue' && !project.dialogues[target.id])
    diagnostics.push(diagnostic(`${path}/id`, `Missing dialogue '${target.id}'.`));
}

export function validateInteractionProgram(
  project: AuthoringProject,
  program: InteractionRule['program'],
  path: string,
): InteractionSchemaDiagnostic[] {
  const diagnostics: InteractionSchemaDiagnostic[] = [];
  const instructionIds = new Set<string>();
  for (const [index, instruction] of program.instructions.entries()) {
    const instructionPath = `${path}/instructions/${index}`;
    if (instructionIds.has(instruction.id))
      diagnostics.push(
        diagnostic(
          `${instructionPath}/id`,
          `Duplicate interaction instruction ID '${instruction.id}'.`,
        ),
      );
    instructionIds.add(instruction.id);
    if (
      (instruction.kind === 'move-interactable' || instruction.kind === 'set-interactable-state') &&
      !project.interactables[instruction.interactable.$ref.id]
    ) {
      diagnostics.push(
        diagnostic(
          `${instructionPath}/interactable/$ref`,
          `Missing interactable '${instruction.interactable.$ref.id}'.`,
        ),
      );
    }
    if (
      instruction.kind === 'set-interactable-state' &&
      instruction.enabled === undefined &&
      instruction.visible === undefined
    ) {
      diagnostics.push(
        diagnostic(instructionPath, 'SetInteractableState must set enabled and/or visible.'),
      );
    }
    if (
      instruction.kind === 'move-interactable' &&
      instruction.target.kind === 'room' &&
      !project.rooms[instruction.target.room.$ref.id]
    )
      diagnostics.push(
        diagnostic(
          `${instructionPath}/target/room/$ref`,
          `Missing room '${instruction.target.room.$ref.id}'.`,
        ),
      );
    if (instruction.kind === 'move-interactable' && instruction.target.kind === 'inventory')
      diagnostics.push(
        ...validateInventoryReference(
          project,
          instruction.target.inventory,
          `${instructionPath}/target/inventory`,
        ),
      );
    if (instruction.kind === 'call-scene' && !project.scenes[instruction.scene.$ref.id])
      diagnostics.push(
        diagnostic(
          `${instructionPath}/scene/$ref`,
          `Missing scene '${instruction.scene.$ref.id}'.`,
        ),
      );
    if (instruction.kind === 'call-dialogue' && !project.dialogues[instruction.dialogue.$ref.id])
      diagnostics.push(
        diagnostic(
          `${instructionPath}/dialogue/$ref`,
          `Missing dialogue '${instruction.dialogue.$ref.id}'.`,
        ),
      );
    if (instruction.kind === 'apply-effect' && instruction.effect.kind === 'set-variable') {
      const result = validateVariableRuntimeValue(
        project,
        instruction.effect.variable.$ref.id,
        instruction.effect.value,
      );
      if (!result.ok) {
        diagnostics.push(
          diagnostic(
            result.kind === 'missing'
              ? `${instructionPath}/effect/variable/$ref`
              : `${instructionPath}/effect/value`,
            result.message,
          ),
        );
      }
    }
  }
  validateFlowTarget(project, program.completion, `${path}/completion`, diagnostics);
  return diagnostics;
}

function validateSubjectSelector(
  project: AuthoringProject,
  selector: InteractionRule['slots'][number]['selectors'][number],
  path: string,
  diagnostics: InteractionSchemaDiagnostic[],
) {
  if (selector.kind === 'trait') {
    if (!project.traits[selector.trait.$ref.id])
      diagnostics.push(
        diagnostic(`${path}/trait/$ref`, `Missing Trait '${selector.trait.$ref.id}'.`),
      );
    return;
  }
  if (selector.kind === 'item-definition') {
    if (!project.itemDefinitions[selector.itemDefinition.$ref.id])
      diagnostics.push(
        diagnostic(
          `${path}/itemDefinition/$ref`,
          `Missing Item Definition '${selector.itemDefinition.$ref.id}'.`,
        ),
      );
    return;
  }
  if (selector.kind !== 'exact') return;
  const subject = selector.subject;
  if (subject.kind === 'interactable' && !project.interactables[subject.interactable.$ref.id])
    diagnostics.push(
      diagnostic(
        `${path}/subject/interactable/$ref`,
        `Missing interactable '${subject.interactable.$ref.id}'.`,
      ),
    );
  else if (subject.kind === 'item-stack' && !project.itemStacks[subject.itemStack.$ref.id])
    diagnostics.push(
      diagnostic(
        `${path}/subject/itemStack/$ref`,
        `Missing Item Stack '${subject.itemStack.$ref.id}'.`,
      ),
    );
  else if (subject.kind === 'character' && !project.characters[subject.character.$ref.id])
    diagnostics.push(
      diagnostic(
        `${path}/subject/character/$ref`,
        `Missing character '${subject.character.$ref.id}'.`,
      ),
    );
  else if (subject.kind === 'feature')
    validateFeatureRef(project, subject.feature, `${path}/subject/feature`, diagnostics);
}

export function validateInteractionData(
  project: AuthoringProject,
  interactionId: string,
  record: AuthoringRecordBase,
): InteractionSchemaDiagnostic[] {
  const base = `/interactions/${interactionId}/data`;
  const parsed = interactionDataSchema.safeParse(record.data);
  if (!parsed.success)
    return parsed.error.issues.map((issue) =>
      diagnostic(`${base}/${issue.path.join('/')}`, issue.message),
    );
  const diagnostics: InteractionSchemaDiagnostic[] = [];
  const seen = new Set<string>();
  const matchKeys = new Map<string, number>();
  for (const [index, rule] of parsed.data.rules.entries()) {
    const path = `${base}/rules/${index}`;
    if (seen.has(rule.id))
      diagnostics.push(diagnostic(`${path}/id`, `Duplicate interaction rule ID '${rule.id}'.`));
    seen.add(rule.id);
    const verb = project.verbs[rule.verb.$ref.id];
    const verbData = verb ? parseVerbData(verb.data) : null;
    if (!verbData)
      diagnostics.push(
        diagnostic(`${path}/verb/$ref`, `Missing or invalid verb '${rule.verb.$ref.id}'.`),
      );
    else {
      const expectedSlots = new Set(verbData.bindingOrder);
      const actualSlots = rule.slots.map((slot) => slot.slotId);
      if (
        actualSlots.length !== expectedSlots.size ||
        new Set(actualSlots).size !== actualSlots.length ||
        actualSlots.some((slotId) => !expectedSlots.has(slotId))
      )
        diagnostics.push(
          diagnostic(
            `${path}/slots`,
            `Interaction rule slots must bind every named slot of Verb '${rule.verb.$ref.id}' exactly once.`,
          ),
        );
    }
    for (const [slotIndex, slot] of rule.slots.entries())
      for (const [selectorIndex, selector] of slot.selectors.entries())
        validateSubjectSelector(
          project,
          selector,
          `${path}/slots/${slotIndex}/selectors/${selectorIndex}`,
          diagnostics,
        );
    if (rule.context.kind === 'active-room' && !project.rooms[rule.context.room.$ref.id])
      diagnostics.push(
        diagnostic(`${path}/context/room/$ref`, `Missing room '${rule.context.room.$ref.id}'.`),
      );
    if (rule.context.kind === 'room-placement')
      validateRoomPlacement(
        project,
        rule.context.placement.room,
        rule.context.placement.placement,
        `${path}/context/placement`,
        diagnostics,
      );
    if (
      rule.context.kind === 'predicate' &&
      rule.context.condition.kind === 'variable-comparison'
    ) {
      const condition = rule.context.condition;
      const variableId = condition.variable.$ref.id;
      if (condition.value === undefined) {
        if (!project.variables[variableId])
          diagnostics.push(
            diagnostic(
              `${path}/context/condition/variable/$ref`,
              `Missing variable '${variableId}'.`,
            ),
          );
      } else {
        const result = validateVariableRuntimeValue(project, variableId, condition.value);
        if (!result.ok)
          diagnostics.push(
            diagnostic(
              result.kind === 'missing'
                ? `${path}/context/condition/variable/$ref`
                : `${path}/context/condition/value`,
              result.message,
            ),
          );
      }
    }
    diagnostics.push(...validateInteractionProgram(project, rule.program, `${path}/program`));
    const key = JSON.stringify({
      verb: rule.verb.$ref.id,
      slots: [...rule.slots].sort((left, right) => left.slotId.localeCompare(right.slotId)),
      context: rule.context,
    });
    const earlier = matchKeys.get(key);
    if (earlier !== undefined)
      diagnostics.push(
        diagnostic(
          path,
          `Rule has equal matching specificity to rule '${parsed.data.rules[earlier]?.id}'. Declared order is the tie-break.`,
          'warning',
        ),
      );
    else matchKeys.set(key, index);
  }
  return diagnostics;
}

export { defaultInteractionProgram };
