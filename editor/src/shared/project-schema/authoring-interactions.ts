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
import { analyzeInteractionRules, selectorUnionOverlap } from '../interaction-resolver-analysis';

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
      for (const [slotIndex, slot] of rule.slots.entries()) {
        const verbSlot = verbData.slots.find((candidate) => candidate.id === slot.slotId);
        if (!verbSlot) continue;
        const overlap = selectorUnionOverlap(project, slot.selectors, verbSlot.selectors);
        if (overlap === 'no')
          diagnostics.push(
            diagnostic(
              `${path}/slots/${slotIndex}/selectors`,
              `Rule '${rule.id}' can never match Verb '${rule.verb.$ref.id}' slot '${slot.slotId}' because their subject selector sets do not overlap.`,
            ),
          );
        else if (overlap === 'unknown')
          diagnostics.push(
            diagnostic(
              `${path}/slots/${slotIndex}/selectors`,
              `Rule '${rule.id}' may match Verb '${rule.verb.$ref.id}' slot '${slot.slotId}' only for runtime-dependent Trait or identity facts.`,
              'info',
            ),
          );
      }
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
  }
  const analyses = analyzeInteractionRules(project, parsed.data.rules);
  for (const [index, analysis] of analyses.entries()) {
    const path = `${base}/rules/${index}`;
    if (analysis.unreachable === 'yes')
      diagnostics.push(
        diagnostic(
          path,
          `Rule '${analysis.rule.id}' is unreachable because an unconditional equal-match rule with higher priority always wins first.`,
        ),
      );
    else if (analysis.unreachable === 'unknown')
      diagnostics.push(
        diagnostic(
          path,
          `Rule '${analysis.rule.id}' may be unreachable depending on runtime Guard results.`,
          'warning',
        ),
      );
    for (const conflict of analysis.conflicts) {
      const otherIndex = parsed.data.rules.findIndex((rule) => rule.id === conflict.ruleId);
      if (otherIndex < 0 || otherIndex >= index) continue;
      diagnostics.push(
        diagnostic(
          path,
          conflict.certainty === 'yes'
            ? `Rule conflicts with unconditional rule '${conflict.ruleId}' at ${conflict.reason}.`
            : `Rule may be ambiguous with rule '${conflict.ruleId}' at ${conflict.reason}.`,
          conflict.certainty === 'yes' ? 'error' : 'warning',
        ),
      );
    }
  }
  return diagnostics;
}

export function validateInteractionResolverProject(
  project: AuthoringProject,
): InteractionSchemaDiagnostic[] {
  const diagnostics: InteractionSchemaDiagnostic[] = [];
  const entries = Object.entries(project.interactions).flatMap(([interactionId, record]) => {
    const data = parseInteractionData(record.data);
    return (data?.rules ?? []).map((rule, ruleIndex) => ({ interactionId, rule, ruleIndex }));
  });
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const left = entries[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const right = entries[rightIndex]!;
      if (left.interactionId === right.interactionId) continue;
      const analysis = analyzeInteractionRules(project, [left.rule, right.rule]);
      const leftAnalysis = analysis[0]!;
      const rightAnalysis = analysis[1]!;
      const rightPath = `/interactions/${right.interactionId}/data/rules/${right.ruleIndex}`;
      const leftPath = `/interactions/${left.interactionId}/data/rules/${left.ruleIndex}`;
      const conflict = rightAnalysis.conflicts.find((item) => item.ruleId === left.rule.id);
      if (conflict)
        diagnostics.push(
          diagnostic(
            rightPath,
            conflict.certainty === 'yes'
              ? `Rule conflicts with unconditional rule '${left.interactionId}:${left.rule.id}' at ${conflict.reason}.`
              : `Rule may be ambiguous with rule '${left.interactionId}:${left.rule.id}' at ${conflict.reason}.`,
            conflict.certainty === 'yes' ? 'error' : 'warning',
          ),
        );
      if (leftAnalysis.unreachable === 'yes')
        diagnostics.push(
          diagnostic(
            leftPath,
            `Rule '${left.rule.id}' is unreachable because rule '${right.interactionId}:${right.rule.id}' has the same match space, an unconditional Guard, and higher priority.`,
          ),
        );
      if (rightAnalysis.unreachable === 'yes')
        diagnostics.push(
          diagnostic(
            rightPath,
            `Rule '${right.rule.id}' is unreachable because rule '${left.interactionId}:${left.rule.id}' has the same match space, an unconditional Guard, and higher priority.`,
          ),
        );
    }
  }
  return diagnostics;
}

export { defaultInteractionProgram };
