import type { AuthoringProject } from './project-schema/authoring-project';
import type { InteractionRule } from './project-schema/authoring-interactions';
import { parseInteractableData } from './project-schema/authoring-interactables';
import { parseRoomData } from './project-schema/authoring-rooms';
import { parseVerbData, type SubjectSelector } from './project-schema/authoring-verbs';
import type { InteractionSubjectData } from './project-schema/authoring-features';

export type AnalysisTruth = 'yes' | 'no' | 'unknown';

export interface ResolverSubjectSnapshot {
  kind: InteractionSubjectData['kind'];
  identity: string;
  authoringSubject?: InteractionSubjectData;
  traits?: readonly string[] | null;
  itemDefinition?: string | null;
}

export interface ResolverVariableSnapshot {
  id: string;
  value: unknown;
}

export interface RuleRelation {
  left: InteractionRule;
  right: InteractionRule;
  overlap: AnalysisTruth;
  leftContainedByRight: AnalysisTruth;
  rightContainedByLeft: AnalysisTruth;
}

export function exactIdentity(subject: InteractionSubjectData): string {
  switch (subject.kind) {
    case 'character':
      return subject.character.$ref.id;
    case 'interactable':
      return subject.interactable.$ref.id;
    case 'item-stack':
      return subject.itemStack.$ref.id;
    case 'feature':
      return subject.feature.ownerKind === 'room'
        ? `room:${subject.feature.room.$ref.id}#${subject.feature.featureId}`
        : `interactable:${subject.feature.interactable.$ref.id}#${subject.feature.featureId}`;
  }
}

function exactTraits(
  project: AuthoringProject,
  subject: InteractionSubjectData,
): Set<string> | null {
  if (subject.kind === 'character') {
    const traits = project.characters[subject.character.$ref.id]?.traits;
    return traits ? new Set(traits) : null;
  }
  if (subject.kind === 'interactable') {
    const traits = project.interactables[subject.interactable.$ref.id]?.traits;
    return traits ? new Set(traits) : null;
  }
  if (subject.kind === 'item-stack') return null;
  if (subject.feature.ownerKind === 'room') {
    const data = parseRoomData(project.rooms[subject.feature.room.$ref.id]?.data);
    const feature = data?.features.find((item) => item.id === subject.feature.featureId);
    return feature ? new Set(feature.traits) : null;
  }
  const data = parseInteractableData(
    project.interactables[subject.feature.interactable.$ref.id]?.data,
  );
  const feature = data?.features.find((item) => item.id === subject.feature.featureId);
  return feature ? new Set(feature.traits) : null;
}

function exactItemDefinition(_project: AuthoringProject, _subject: InteractionSubjectData): null {
  return null;
}

function patternPrefix(selector: Extract<SubjectSelector, { kind: 'qualified-pattern' }>) {
  return selector.pattern.slice(0, -1);
}

export function subjectSnapshot(subject: InteractionSubjectData): ResolverSubjectSnapshot {
  return { kind: subject.kind, identity: exactIdentity(subject), authoringSubject: subject };
}

export function selectorMatchesSubject(
  project: AuthoringProject,
  selector: SubjectSelector,
  subject: ResolverSubjectSnapshot,
): AnalysisTruth {
  switch (selector.kind) {
    case 'any-subject':
      return 'yes';
    case 'family':
      return selector.family === subject.kind ? 'yes' : 'no';
    case 'exact':
      return selector.subject.kind === subject.kind &&
        exactIdentity(selector.subject) === subject.identity
        ? 'yes'
        : 'no';
    case 'qualified-pattern':
      return selector.family === subject.kind &&
        subject.identity.startsWith(patternPrefix(selector))
        ? 'yes'
        : 'no';
    case 'trait': {
      const traits =
        subject.traits !== undefined
          ? subject.traits
          : subject.authoringSubject
            ? [...(exactTraits(project, subject.authoringSubject) ?? [])]
            : null;
      return traits ? (traits.includes(selector.trait.$ref.id) ? 'yes' : 'no') : 'unknown';
    }
    case 'item-definition': {
      if (subject.kind !== 'item-stack') return 'no';
      const definition =
        subject.itemDefinition !== undefined
          ? subject.itemDefinition
          : subject.authoringSubject
            ? exactItemDefinition(project, subject.authoringSubject)
            : null;
      return definition === null || definition === undefined
        ? 'unknown'
        : definition === selector.itemDefinition.$ref.id
          ? 'yes'
          : 'no';
    }
  }
}

export function selectorMatchesExactSubject(
  project: AuthoringProject,
  selector: SubjectSelector,
  subject: InteractionSubjectData,
): AnalysisTruth {
  return selectorMatchesSubject(project, selector, subjectSnapshot(subject));
}

export function selectorContainedBy(
  project: AuthoringProject,
  narrow: SubjectSelector,
  broad: SubjectSelector,
): AnalysisTruth {
  if (broad.kind === 'any-subject') return 'yes';
  if (narrow.kind === 'any-subject') return 'no';
  if (narrow.kind === 'exact') {
    if (broad.kind === 'trait') return 'unknown';
    return selectorMatchesExactSubject(project, broad, narrow.subject);
  }
  if (broad.kind === 'exact') return 'no';
  if (narrow.kind === 'family')
    return broad.kind === 'family' && narrow.family === broad.family ? 'yes' : 'no';
  if (narrow.kind === 'qualified-pattern') {
    if (broad.kind === 'family') return narrow.family === broad.family ? 'yes' : 'no';
    if (broad.kind === 'qualified-pattern')
      return narrow.family === broad.family &&
        patternPrefix(narrow).startsWith(patternPrefix(broad))
        ? 'yes'
        : 'no';
    return 'no';
  }
  if (narrow.kind === 'item-definition') {
    if (broad.kind === 'family') return broad.family === 'item-stack' ? 'yes' : 'no';
    if (broad.kind === 'item-definition')
      return narrow.itemDefinition.$ref.id === broad.itemDefinition.$ref.id ? 'yes' : 'no';
    return 'no';
  }
  if (narrow.kind === 'trait') {
    if (broad.kind === 'trait') return narrow.trait.$ref.id === broad.trait.$ref.id ? 'yes' : 'no';
    return 'no';
  }
  return 'no';
}

function truthAny(values: AnalysisTruth[]): AnalysisTruth {
  if (values.includes('yes')) return 'yes';
  return values.includes('unknown') ? 'unknown' : 'no';
}

function truthAll(values: AnalysisTruth[]): AnalysisTruth {
  if (values.includes('no')) return 'no';
  return values.includes('unknown') ? 'unknown' : 'yes';
}

export function selectorUnionContainedBy(
  project: AuthoringProject,
  narrow: readonly SubjectSelector[],
  broad: readonly SubjectSelector[],
): AnalysisTruth {
  return truthAll(
    narrow.map((selector) =>
      truthAny(broad.map((candidate) => selectorContainedBy(project, selector, candidate))),
    ),
  );
}

export function selectorOverlap(
  project: AuthoringProject,
  left: SubjectSelector,
  right: SubjectSelector,
): AnalysisTruth {
  const leftWithin = selectorContainedBy(project, left, right);
  const rightWithin = selectorContainedBy(project, right, left);
  if (leftWithin === 'yes' || rightWithin === 'yes') return 'yes';
  if (leftWithin === 'unknown' || rightWithin === 'unknown') return 'unknown';
  if (left.kind === 'family' && right.kind === 'family')
    return left.family === right.family ? 'yes' : 'no';
  if (left.kind === 'qualified-pattern' && right.kind === 'qualified-pattern') {
    if (left.family !== right.family) return 'no';
    const a = patternPrefix(left);
    const b = patternPrefix(right);
    return a.startsWith(b) || b.startsWith(a) ? 'yes' : 'no';
  }
  if (left.kind === 'trait' && right.kind === 'trait') return 'unknown';
  if (left.kind === 'trait' || right.kind === 'trait') return 'unknown';
  if (left.kind === 'item-definition' && right.kind === 'item-definition')
    return left.itemDefinition.$ref.id === right.itemDefinition.$ref.id ? 'yes' : 'no';
  return 'no';
}

export function selectorUnionOverlap(
  project: AuthoringProject,
  left: readonly SubjectSelector[],
  right: readonly SubjectSelector[],
): AnalysisTruth {
  return truthAny(left.flatMap((a) => right.map((b) => selectorOverlap(project, a, b))));
}

function slotMap(rule: InteractionRule) {
  return new Map(rule.slots.map((slot) => [slot.slotId, slot.selectors] as const));
}

export function ruleRelation(
  project: AuthoringProject,
  left: InteractionRule,
  right: InteractionRule,
): RuleRelation {
  if (left.verb.$ref.id !== right.verb.$ref.id)
    return { left, right, overlap: 'no', leftContainedByRight: 'no', rightContainedByLeft: 'no' };
  const leftSlots = slotMap(left);
  const rightSlots = slotMap(right);
  if (leftSlots.size !== rightSlots.size || [...leftSlots.keys()].some((id) => !rightSlots.has(id)))
    return { left, right, overlap: 'no', leftContainedByRight: 'no', rightContainedByLeft: 'no' };
  const slotIds = [...leftSlots.keys()];
  const overlap = truthAll(
    slotIds.map((id) => selectorUnionOverlap(project, leftSlots.get(id)!, rightSlots.get(id)!)),
  );
  const leftContainedByRight = truthAll(
    slotIds.map((id) => selectorUnionContainedBy(project, leftSlots.get(id)!, rightSlots.get(id)!)),
  );
  const rightContainedByLeft = truthAll(
    slotIds.map((id) => selectorUnionContainedBy(project, rightSlots.get(id)!, leftSlots.get(id)!)),
  );
  return { left, right, overlap, leftContainedByRight, rightContainedByLeft };
}

export interface RuleAnalysis {
  rule: InteractionRule;
  broader: string[];
  narrower: string[];
  overlaps: Array<{ ruleId: string; certainty: AnalysisTruth }>;
  conflicts: Array<{ ruleId: string; certainty: AnalysisTruth; reason: string }>;
  unreachable: AnalysisTruth;
  uncertainty: boolean;
}

export interface OfferCandidateAnalysis {
  source: 'verb' | 'rule';
  sourceId: string;
  slotId: string;
  rank: number;
  primary: boolean;
  specificity: { tier: number; detail: number };
  selectorMatch: AnalysisTruth;
  condition: AnalysisTruth;
  selected: AnalysisTruth;
  shadowedBy?: string;
}

export interface VerbSubjectAnalysis {
  verbId: string;
  availability: AnalysisTruth;
  candidates: OfferCandidateAnalysis[];
  winner: OfferCandidateAnalysis | null;
  winnerStatus: AnalysisTruth;
  primaryStatus: 'primary' | 'ordinary' | 'conditional' | 'none';
}

function compareScalar(left: unknown, right: unknown, operator: string): boolean | null {
  if (operator === 'truthy') return Boolean(left);
  if (operator === 'falsy') return !left;
  if (operator === 'equal') return left === right;
  if (operator === 'not-equal') return left !== right;
  if (typeof left === 'number' && typeof right === 'number') {
    if (operator === 'less') return left < right;
    if (operator === 'less-equal') return left <= right;
    if (operator === 'greater') return left > right;
    if (operator === 'greater-equal') return left >= right;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    if (operator === 'less') return left < right;
    if (operator === 'less-equal') return left <= right;
    if (operator === 'greater') return left > right;
    if (operator === 'greater-equal') return left >= right;
  }
  return null;
}

export function evaluateConditionForAnalysis(
  condition: InteractionRule['guard'] | undefined,
  variables: readonly ResolverVariableSnapshot[] = [],
): AnalysisTruth {
  if (!condition || condition.kind === 'always') return 'yes';
  if (condition.kind === 'lua-predicate') return 'unknown';
  const current = variables.find((item) => item.id === condition.variable.$ref.id);
  if (!current) return 'unknown';
  const result = compareScalar(current.value, condition.value, condition.operator);
  return result === null ? 'unknown' : result ? 'yes' : 'no';
}

function specificity(selector: SubjectSelector) {
  switch (selector.kind) {
    case 'exact':
      return { tier: 5, detail: 0 };
    case 'qualified-pattern':
      return { tier: 4, detail: selector.pattern.length };
    case 'trait':
    case 'item-definition':
      return { tier: 3, detail: 0 };
    case 'family':
      return { tier: 2, detail: 0 };
    case 'any-subject':
      return { tier: 1, detail: 0 };
  }
}

function compareSpecificity(
  left: { tier: number; detail: number },
  right: { tier: number; detail: number },
) {
  return left.tier === right.tier ? left.detail - right.detail : left.tier - right.tier;
}

function matchingSpecificity(
  project: AuthoringProject,
  selectors: readonly SubjectSelector[],
  subject: ResolverSubjectSnapshot,
): { match: AnalysisTruth; specificity: { tier: number; detail: number } } | null {
  const matches = selectors
    .map((selector) => ({ selector, match: selectorMatchesSubject(project, selector, subject) }))
    .filter((entry) => entry.match !== 'no');
  if (!matches.length) return null;
  const best = matches.reduce((winner, entry) =>
    compareSpecificity(specificity(entry.selector), specificity(winner.selector)) > 0
      ? entry
      : winner,
  );
  return {
    match: best.match,
    specificity: specificity(best.selector),
  };
}

export function analyzeSubjectOffers(
  project: AuthoringProject,
  subject: ResolverSubjectSnapshot,
  variables: readonly ResolverVariableSnapshot[] = [],
): VerbSubjectAnalysis[] {
  const result: VerbSubjectAnalysis[] = [];
  for (const [verbId, record] of Object.entries(project.verbs)) {
    const parsed = parseVerbData(record.data);
    if (!parsed) continue;
    const availability = evaluateConditionForAnalysis(parsed.availability, variables);
    const raw: Array<Omit<OfferCandidateAnalysis, 'selected' | 'shadowedBy'>> = [];
    for (const offer of parsed.offers) {
      const match = matchingSpecificity(project, offer.selectors, subject);
      if (!match) continue;
      raw.push({
        source: 'verb',
        sourceId: `verb:${offer.id}`,
        slotId: offer.slotId,
        rank: offer.rank,
        primary: offer.primary,
        specificity: match.specificity,
        selectorMatch: match.match,
        condition: evaluateConditionForAnalysis(offer.condition, variables),
      });
    }
    for (const [interactionId, interactionRecord] of Object.entries(project.interactions)) {
      const interaction =
        (interactionRecord.data as { kind?: unknown }).kind === 'interaction'
          ? (interactionRecord.data as { rules?: InteractionRule[] })
          : null;
      for (const rule of interaction?.rules ?? []) {
        if (rule.verb.$ref.id !== verbId || !rule.offer) continue;
        const slot = rule.slots.find((item) => item.slotId === rule.offer!.slotId);
        if (!slot) continue;
        const match = matchingSpecificity(project, slot.selectors, subject);
        if (!match) continue;
        raw.push({
          source: 'rule',
          sourceId: `rule:${interactionId}:${rule.id}`,
          slotId: rule.offer.slotId,
          rank: rule.offer.rank,
          primary: rule.offer.primary,
          specificity: match.specificity,
          selectorMatch: match.match,
          condition: evaluateConditionForAnalysis(rule.offer.condition, variables),
        });
      }
    }
    raw.sort((left, right) => {
      const bySpecificity = compareSpecificity(right.specificity, left.specificity);
      if (bySpecificity) return bySpecificity;
      if (left.rank !== right.rank) return left.rank - right.rank;
      return left.sourceId.localeCompare(right.sourceId);
    });
    const top = raw[0] ?? null;
    let winnerStatus: AnalysisTruth = 'no';
    if (top && availability !== 'no' && top.selectorMatch !== 'no' && top.condition !== 'no') {
      winnerStatus =
        availability === 'yes' && top.selectorMatch === 'yes' && top.condition === 'yes'
          ? 'yes'
          : 'unknown';
    }
    const candidates = raw.map(
      (candidate, index): OfferCandidateAnalysis => ({
        ...candidate,
        selected: index === 0 ? winnerStatus : 'no',
        shadowedBy: index === 0 ? undefined : top?.sourceId,
      }),
    );
    const winner = candidates[0] ?? null;
    result.push({
      verbId,
      availability,
      candidates,
      winner,
      winnerStatus,
      primaryStatus:
        !winner || winnerStatus === 'no'
          ? 'none'
          : winnerStatus === 'unknown'
            ? 'conditional'
            : winner.primary
              ? 'primary'
              : 'ordinary',
    });
  }
  return result;
}

export interface ResolverBindingSnapshot {
  slotId: string;
  subject: ResolverSubjectSnapshot;
}

export interface RuleCandidateResolution {
  interactionId: string;
  ruleId: string;
  match: AnalysisTruth;
  guard: AnalysisTruth;
  priority: number;
  tier: number | null;
  status: 'candidate' | 'winner' | 'shadowed' | 'guard-failed' | 'conditional' | 'ambiguous';
  shadowedBy?: string;
}

export interface ConcreteInteractionResolutionAnalysis {
  verbId: string;
  candidates: RuleCandidateResolution[];
  winner: string | null;
  ambiguity: string[];
  fallback: 'rule' | 'verb-default' | 'conditional';
  uncertainty: boolean;
}

export function analyzeConcreteInteractionResolution(
  project: AuthoringProject,
  verbId: string,
  bindings: readonly ResolverBindingSnapshot[],
  variables: readonly ResolverVariableSnapshot[] = [],
): ConcreteInteractionResolutionAnalysis {
  const rules: Array<{ interactionId: string; rule: InteractionRule; match: AnalysisTruth }> = [];
  for (const [interactionId, record] of Object.entries(project.interactions)) {
    const data = record.data as { kind?: unknown; rules?: InteractionRule[] };
    if (data.kind !== 'interaction' || !Array.isArray(data.rules)) continue;
    for (const rule of data.rules) {
      if (rule.verb.$ref.id !== verbId || rule.slots.length !== bindings.length) continue;
      const match = truthAll(
        rule.slots.map((slot) => {
          const binding = bindings.find((item) => item.slotId === slot.slotId);
          if (!binding) return 'no';
          return truthAny(
            slot.selectors.map((selector) =>
              selectorMatchesSubject(project, selector, binding.subject),
            ),
          );
        }),
      );
      if (match !== 'no') rules.push({ interactionId, rule, match });
    }
  }

  const remaining = [...rules];
  const resolutions = new Map<string, RuleCandidateResolution>();
  let tierNumber = 0;
  let uncertainty = false;
  let winner: string | null = null;
  let ambiguity: string[] = [];

  while (remaining.length && !winner && !ambiguity.length) {
    const tier: typeof remaining = [];
    for (const candidate of remaining) {
      let definitelyHasNarrower = false;
      let containmentUnknown = false;
      for (const other of remaining) {
        if (other === candidate) continue;
        const relation = ruleRelation(project, other.rule, candidate.rule);
        if (
          relation.leftContainedByRight === 'unknown' ||
          relation.rightContainedByLeft === 'unknown'
        )
          containmentUnknown = true;
        if (relation.leftContainedByRight === 'yes' && relation.rightContainedByLeft === 'no') {
          definitelyHasNarrower = true;
          break;
        }
      }
      if (!definitelyHasNarrower) tier.push(candidate);
      if (containmentUnknown) uncertainty = true;
    }
    let winningPriority: number | null = null;
    const passing: typeof tier = [];
    const conditional: typeof tier = [];
    for (const candidate of tier) {
      const guard = evaluateConditionForAnalysis(candidate.rule.guard, variables);
      const key = `${candidate.interactionId}:${candidate.rule.id}`;
      if (candidate.match === 'unknown' || guard === 'unknown') uncertainty = true;
      if (candidate.match === 'no' || guard === 'no') {
        resolutions.set(key, {
          interactionId: candidate.interactionId,
          ruleId: candidate.rule.id,
          match: candidate.match,
          guard,
          priority: candidate.rule.priority,
          tier: tierNumber,
          status: 'guard-failed',
        });
        continue;
      }
      if (candidate.match === 'unknown' || guard === 'unknown') conditional.push(candidate);
      if (candidate.match === 'yes' && guard === 'yes') {
        if (winningPriority === null || candidate.rule.priority > winningPriority) {
          winningPriority = candidate.rule.priority;
          passing.splice(0, passing.length, candidate);
        } else if (candidate.rule.priority === winningPriority) passing.push(candidate);
      }
      resolutions.set(key, {
        interactionId: candidate.interactionId,
        ruleId: candidate.rule.id,
        match: candidate.match,
        guard,
        priority: candidate.rule.priority,
        tier: tierNumber,
        status: candidate.match === 'unknown' || guard === 'unknown' ? 'conditional' : 'candidate',
      });
    }
    const possibleHigherOrEqual = conditional.filter(
      (candidate) => winningPriority === null || candidate.rule.priority >= winningPriority,
    );
    if (possibleHigherOrEqual.length) {
      uncertainty = true;
      break;
    }
    if (passing.length > 1) {
      ambiguity = passing.map((candidate) => `${candidate.interactionId}:${candidate.rule.id}`);
      for (const candidate of passing) {
        const key = `${candidate.interactionId}:${candidate.rule.id}`;
        resolutions.set(key, { ...resolutions.get(key)!, status: 'ambiguous' });
      }
      break;
    }
    if (passing.length === 1) {
      const selected = passing[0]!;
      winner = `${selected.interactionId}:${selected.rule.id}`;
      const selectedResolution = resolutions.get(winner)!;
      resolutions.set(winner, { ...selectedResolution, status: 'winner' });
      for (const candidate of remaining) {
        const key = `${candidate.interactionId}:${candidate.rule.id}`;
        if (key === winner || resolutions.has(key)) continue;
        resolutions.set(key, {
          interactionId: candidate.interactionId,
          ruleId: candidate.rule.id,
          match: candidate.match,
          guard: evaluateConditionForAnalysis(candidate.rule.guard, variables),
          priority: candidate.rule.priority,
          tier: null,
          status: 'shadowed',
          shadowedBy: winner,
        });
      }
      break;
    }
    for (const candidate of tier) {
      const index = remaining.indexOf(candidate);
      if (index >= 0) remaining.splice(index, 1);
    }
    tierNumber += 1;
  }

  if (!winner && !ambiguity.length && remaining.length)
    for (const candidate of remaining) {
      const key = `${candidate.interactionId}:${candidate.rule.id}`;
      if (!resolutions.has(key))
        resolutions.set(key, {
          interactionId: candidate.interactionId,
          ruleId: candidate.rule.id,
          match: candidate.match,
          guard: evaluateConditionForAnalysis(candidate.rule.guard, variables),
          priority: candidate.rule.priority,
          tier: null,
          status: 'conditional',
        });
    }

  return {
    verbId,
    candidates: [...resolutions.values()],
    winner,
    ambiguity,
    fallback: winner ? 'rule' : uncertainty ? 'conditional' : 'verb-default',
    uncertainty,
  };
}

export function analyzeInteractionRules(
  project: AuthoringProject,
  rules: readonly InteractionRule[],
): RuleAnalysis[] {
  return rules.map((rule) => {
    const broader: string[] = [];
    const narrower: string[] = [];
    const overlaps: RuleAnalysis['overlaps'] = [];
    const conflicts: RuleAnalysis['conflicts'] = [];
    let unreachable: AnalysisTruth = 'no';
    let uncertainty = rule.guard.kind !== 'always';
    for (const other of rules) {
      if (other === rule) continue;
      const relation = ruleRelation(project, rule, other);
      if (relation.overlap !== 'no')
        overlaps.push({ ruleId: other.id, certainty: relation.overlap });
      if (relation.leftContainedByRight === 'yes' && relation.rightContainedByLeft === 'no')
        broader.push(other.id);
      if (relation.rightContainedByLeft === 'yes' && relation.leftContainedByRight === 'no')
        narrower.push(other.id);
      if (
        relation.overlap === 'unknown' ||
        relation.leftContainedByRight === 'unknown' ||
        relation.rightContainedByLeft === 'unknown'
      )
        uncertainty = true;
      const sameTier = relation.leftContainedByRight === relation.rightContainedByLeft;
      if (relation.overlap !== 'no' && sameTier && rule.priority === other.priority) {
        const bothAlways = rule.guard.kind === 'always' && other.guard.kind === 'always';
        conflicts.push({
          ruleId: other.id,
          certainty: bothAlways && relation.overlap === 'yes' ? 'yes' : 'unknown',
          reason: bothAlways
            ? `equal structural tier and priority ${rule.priority}`
            : `equal structural tier and priority ${rule.priority}; Guard outcome is runtime-dependent`,
        });
      }
      if (
        relation.leftContainedByRight === 'yes' &&
        relation.rightContainedByLeft === 'yes' &&
        other.guard.kind === 'always' &&
        other.priority > rule.priority
      )
        unreachable = 'yes';
      else if (
        unreachable !== 'yes' &&
        relation.leftContainedByRight !== 'no' &&
        relation.rightContainedByLeft !== 'no' &&
        other.priority >= rule.priority &&
        other.guard.kind !== 'always'
      )
        unreachable = 'unknown';
    }
    return { rule, broader, narrower, overlaps, conflicts, unreachable, uncertainty };
  });
}
