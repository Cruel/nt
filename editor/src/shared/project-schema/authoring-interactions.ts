import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { conditionSchema, verbRefSchema } from './authoring-flow';
import type { FeatureRefData } from './authoring-features';
import {
  defaultInteractionProgram,
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

export const interactionOfferSchema = strict({
  slotId: entityIdSchema,
  condition: conditionSchema.optional(),
  rank: z.number().int(),
  primary: z.boolean(),
});

export const interactionRuleSchema = strict({
  id: entityIdSchema,
  verb: verbRefSchema,
  slots: z.array(interactionSlotSelectorSchema),
  offer: interactionOfferSchema.nullable(),
  guard: conditionSchema,
  priority: z.number().int(),
  program: interactionProgramSchema,
});

export const interactionDataSchema = strict({
  kind: z.literal('interaction'),
  rules: z.array(interactionRuleSchema),
});

export type InteractionSlotSelector = z.infer<typeof interactionSlotSelectorSchema>;
export type InteractionOffer = z.infer<typeof interactionOfferSchema>;
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

  const terminalKinds = new Set(['notify', 'call-scene', 'call-dialogue']);
  const terminals = program.instructions
    .map((instruction, index) => ({ instruction, index }))
    .filter(
      ({ instruction }) =>
        terminalKinds.has(instruction.kind) ||
        (instruction.kind === 'apply-effect' && instruction.effect.kind === 'run-lua-effect'),
    );
  if (program.outcome === 'unhandled') {
    if (program.instructions.length !== 0)
      diagnostics.push(
        diagnostic(
          path,
          'An unhandled compact Interaction behavior must be empty so fallback cannot follow committed work.',
        ),
      );
  } else {
    if (terminals.length > 1)
      diagnostics.push(
        diagnostic(path, 'Compact Interaction behavior permits at most one terminal action.'),
      );
    if (terminals.length === 1 && terminals[0]!.index !== program.instructions.length - 1)
      diagnostics.push(
        diagnostic(
          `${path}/instructions/${terminals[0]!.index}`,
          'The terminal Interaction action must be the final instruction.',
        ),
      );
    if (terminals.length === 1 && program.completion.kind !== 'return')
      diagnostics.push(
        diagnostic(
          `${path}/completion`,
          'A compact Interaction behavior cannot combine a terminal instruction with a terminal Flow target.',
        ),
      );
  }
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
      if (rule.offer && !expectedSlots.has(rule.offer.slotId))
        diagnostics.push(
          diagnostic(
            `${path}/offer/slotId`,
            `Rule Offer slot '${rule.offer.slotId}' must name a slot of Verb '${rule.verb.$ref.id}'.`,
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
    if (rule.guard.kind === 'variable-comparison') {
      const variableId = rule.guard.variable.$ref.id;
      if (rule.guard.value === undefined) {
        if (!project.variables[variableId])
          diagnostics.push(
            diagnostic(`${path}/guard/variable/$ref`, `Missing variable '${variableId}'.`),
          );
      } else {
        const result = validateVariableRuntimeValue(project, variableId, rule.guard.value);
        if (!result.ok)
          diagnostics.push(
            diagnostic(
              result.kind === 'missing' ? `${path}/guard/variable/$ref` : `${path}/guard/value`,
              result.message,
            ),
          );
      }
    }
    diagnostics.push(...validateInteractionProgram(project, rule.program, `${path}/program`));
    const key = JSON.stringify({
      verb: rule.verb.$ref.id,
      slots: [...rule.slots].sort((left, right) => left.slotId.localeCompare(right.slotId)),
    });
    const earlier = matchKeys.get(key);
    if (earlier !== undefined) {
      const previous = parsed.data.rules[earlier]!;
      if (previous.priority === rule.priority) {
        if (previous.guard.kind === 'always' && rule.guard.kind === 'always')
          diagnostics.push(
            diagnostic(
              path,
              `Rule conflicts with unconditional rule '${previous.id}' at equal structural specificity and priority ${rule.priority}.`,
            ),
          );
        else
          diagnostics.push(
            diagnostic(
              path,
              `Rule may be ambiguous with guarded rule '${previous.id}' when both Guards pass at priority ${rule.priority}.`,
              'warning',
            ),
          );
      }
    } else matchKeys.set(key, index);
  }
  return diagnostics;
}

export { defaultInteractionProgram };
