import type {
  AuthoringFieldGraphEffect,
  AuthoringGraphInputClassification,
} from '../authoring-dependency-contracts';
import { parseJsonPointer, type JsonPointer } from '../json-pointer';
import { authoringProjectSchema } from './authoring-project';

interface ZodDefinition {
  type?: string;
  shape?: Record<string, unknown>;
  element?: unknown;
  valueType?: unknown;
  options?: readonly unknown[];
  items?: readonly unknown[];
  innerType?: unknown;
  left?: unknown;
  right?: unknown;
  getter?: () => unknown;
}
export interface AuthoringGraphFieldMetadata extends AuthoringGraphInputClassification {
  schemaRoot: string;
}

const NONE = Object.freeze({ kind: 'none' } as const);
const OWNER = Object.freeze({ kind: 'owner-contribution' } as const);
const SOURCE = Object.freeze({ kind: 'source-analysis' } as const);
const SYMBOL = Object.freeze({ kind: 'symbol-definition' } as const);

function valueDependent(classify: string): AuthoringFieldGraphEffect {
  return Object.freeze({ kind: 'value-dependent', classify });
}

function schemaDefinition(schema: unknown): ZodDefinition | undefined {
  return (schema as { _zod?: { def?: ZodDefinition } })._zod?.def;
}

function collectSchemaLeafPaths(schema: unknown, output: Set<JsonPointer>): void {
  // Keep this iterative so deeply composed schema graphs do not depend on host recursion depth.
  const pending: Array<{
    schema: unknown;
    path: readonly string[];
    ancestors: ReadonlySet<unknown>;
  }> = [{ schema, path: [], ancestors: new Set() }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;

    if (current.ancestors.has(current.schema)) {
      output.add(`/${current.path.join('/')}`);
      continue;
    }

    const nextAncestors = new Set(current.ancestors);
    nextAncestors.add(current.schema);
    const definition = schemaDefinition(current.schema);
    if (!definition) {
      output.add(`/${current.path.join('/')}`);
      continue;
    }

    if (definition.type === 'object' && definition.shape) {
      for (const key of Object.keys(definition.shape)) {
        if (current.path.length === 0 && key === 'editor') continue;
        pending.push({
          schema: definition.shape[key],
          path: [...current.path, key],
          ancestors: nextAncestors,
        });
      }
      continue;
    }
    if (definition.type === 'array' && definition.element) {
      pending.push({
        schema: definition.element,
        path: [...current.path, '*'],
        ancestors: nextAncestors,
      });
      continue;
    }
    if (definition.type === 'record' && definition.valueType) {
      pending.push({
        schema: definition.valueType,
        path: [...current.path, '*'],
        ancestors: nextAncestors,
      });
      continue;
    }
    if (definition.type === 'union' && definition.options) {
      for (const option of definition.options) {
        pending.push({ schema: option, path: current.path, ancestors: nextAncestors });
      }
      continue;
    }
    if (definition.type === 'tuple' && definition.items) {
      for (const item of definition.items) {
        pending.push({ schema: item, path: [...current.path, '*'], ancestors: nextAncestors });
      }
      continue;
    }
    if (definition.type === 'intersection' && definition.left && definition.right) {
      pending.push({ schema: definition.left, path: current.path, ancestors: nextAncestors });
      pending.push({ schema: definition.right, path: current.path, ancestors: nextAncestors });
      continue;
    }
    if (definition.innerType) {
      pending.push({ schema: definition.innerType, path: current.path, ancestors: nextAncestors });
      continue;
    }
    if (definition.getter) {
      pending.push({ schema: definition.getter(), path: current.path, ancestors: nextAncestors });
      continue;
    }
    output.add(`/${current.path.join('/')}`);
  }
}

function schemaRootForPath(path: JsonPointer): string {
  return parseJsonPointer(path)[0] ?? '';
}

type ReviewedFieldEffectCode = 'n' | 'o' | 's' | 'y' | 't' | 'a' | 'l' | 'p' | 'v';

// One explicitly reviewed effect code for every sorted schema leaf. The shape fingerprints below
// pin the leaf ordering. There is deliberately no inferred leaf-name rule and no implicit `none`.
// n=none, o=owner, s=source, y=symbol, t=structural, a=asset reverse impact,
// l=localization reverse impact, p=property assignment, v=structural variant.
const REVIEWED_FIELD_EFFECT_CODES =
  'nnaanannnnnnannyonnnnnnnnonoonoonnonnnnvoonnnnonoonnnoonoyopooonnsssssssssvnsnoonsnooonnnsoonnssssss' +
  'sssovsnnonnoooonnsssssssssvnsnoonsnoooonnsssssssssovsnnoonnnnoyopoonnnnoooonoyopnsssssssssvnsnoonooo' +
  'oonoooonoooonsnoonooonnsssssssssovsnoonoonnoonoyopoooooooooooonnnoonsnnnoonnoonsnnnnsssssssssnnnnyol' +
  'yyooooononsssssssssovsnnnoonnnnoonoonsssssssssovsnnoyoponnnnnnnoonnoonnnnnnnnnnyonnnnnnnnyonnnoonno' +
  'ooosssssssssvnsnoononnonnsssssssssoonsssssssssovsnnoonnnnnsssssssssvnsnooooonnnnnnsssssssssvnsnoonon' +
  'oonnnnsssssssssvnsnoonooononnnsnoonsnoonsnoonsnoosssssssssnnsnoosssssssssnnsnoosssssssssvnsnooooonnn' +
  'nnnonnsssssssssovsnoooosssssssssvnsnooooononnoyopoooonnoooonnnoonsssssssssvnsnoooonoonoooonnnooooonn' +
  'nnnnnnnnnsssssssssvnsnoooonnnnononoonoonnnsssssssssvnsnoonsnooonsssssssssovsnonnnsssssssssovsnnnnnnn' +
  'soonnnsssssssssovsnnnnnoonnnnnoyopnnnoovsnyonnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn' +
  'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnoonnnnnnoooooooooooooooooonnoonoonnnnnnoonnnnnnnnnnnnnnnyossnoonsnn' +
  'nnoonoonnonnnnoosnnnosnnnnnnoooooonoooooonoonnnnnyonnnnnnyonsssssssssovsnnsssssssssnnsnoooooonsnoono' +
  'oonnsssssssssovssnoonoonnnnnnoyop';

const EXPLICIT_FIELD_EFFECTS: readonly [RegExp, AuthoringFieldGraphEffect][] = Object.freeze([
  // #122 replaces the Interaction-only instruction union and Dialogue-only effect union with the
  // shared recursive Gameplay Command vocabulary. Legacy-equivalent leaves are path-mapped below;
  // genuinely new typed operands, result bindings, quantity/configuration forms, and recursive
  // branch structure contribute to the owning host. Lua command source remains source-analyzed.
  [
    /^(?:\/undefinedInteractionProgram\/instructions\/\*|\/verbs\/\*\/data\/defaultProgram\/instructions\/\*|\/interactions\/\*\/data\/rules\/\*\/program\/instructions\/\*|\/dialogues\/\*\/data\/(?:blocks\/\*\/segments\/\*|edges\/\*)\/effects\/\*)(?:\/(?:then|else)\/\*)+\/source$/,
    SOURCE,
  ],
  [
    /^(?:\/undefinedInteractionProgram\/instructions\/\*|\/verbs\/\*\/data\/defaultProgram\/instructions\/\*|\/interactions\/\*\/data\/rules\/\*\/program\/instructions\/\*|\/dialogues\/\*\/data\/(?:blocks\/\*\/segments\/\*|edges\/\*)\/effects\/\*)\/condition\/source$/,
    SOURCE,
  ],
  [
    /^(?:\/undefinedInteractionProgram\/instructions\/\*|\/verbs\/\*\/data\/defaultProgram\/instructions\/\*|\/interactions\/\*\/data\/rules\/\*\/program\/instructions\/\*|\/dialogues\/\*\/data\/(?:blocks\/\*\/segments\/\*|edges\/\*)\/effects\/\*)\/condition(?:\/|$)/,
    OWNER,
  ],
  [
    /^(?:\/undefinedInteractionProgram\/instructions\/\*|\/verbs\/\*\/data\/defaultProgram\/instructions\/\*|\/interactions\/\*\/data\/rules\/\*\/program\/instructions\/\*|\/dialogues\/\*\/data\/(?:blocks\/\*\/segments\/\*|edges\/\*)\/effects\/\*)(?=.*\/(?:then|else)\/\*)/,
    OWNER,
  ],
  [
    /^(?:\/undefinedInteractionProgram\/instructions\/\*|\/verbs\/\*\/data\/defaultProgram\/instructions\/\*|\/interactions\/\*\/data\/rules\/\*\/program\/instructions\/\*|\/dialogues\/\*\/data\/(?:blocks\/\*\/segments\/\*|edges\/\*)\/effects\/\*)\/(?:owner|trait|subject|location|result|matcher|sourceInventory|definition|receiver|donor|instance)(?:\/|$)/,
    OWNER,
  ],
  [
    /^(?:\/undefinedInteractionProgram\/instructions\/\*|\/verbs\/\*\/data\/defaultProgram\/instructions\/\*|\/interactions\/\*\/data\/rules\/\*\/program\/instructions\/\*|\/dialogues\/\*\/data\/(?:blocks\/\*\/segments\/\*|edges\/\*)\/effects\/\*)\/(?:propertyId|mode|quantity|result)$/,
    OWNER,
  ],
  [
    /^\/dialogues\/\*\/data\/(?:blocks\/\*\/segments\/\*|edges\/\*)\/effects\/\*\/(?:id|enabled|visible|message|scene|dialogue)(?:\/|$)/,
    OWNER,
  ],
  [
    /^(?:\/undefinedInteractionProgram\/instructions\/\*|\/verbs\/\*\/data\/defaultProgram\/instructions\/\*|\/interactions\/\*\/data\/rules\/\*\/program\/instructions\/\*|\/dialogues\/\*\/data\/(?:blocks\/\*\/segments\/\*|edges\/\*)\/effects\/\*)\/source\//,
    OWNER,
  ],
  // #123 adopts the same Gameplay Command vocabulary for Scene mutation batches and choice
  // effects. Scene command operands/results remain part of the owning Scene contribution, while
  // Lua command/predicate source stays source-analyzed just like the other Gameplay Command hosts.
  [
    /^\/scenes\/\*\/data\/events\/\*\/(?:operations\/\*|options\/\*\/effects\/\*)(?:\/(?:then|else)\/\*)*\/source$/,
    SOURCE,
  ],
  [
    /^\/scenes\/\*\/data\/events\/\*\/(?:operations\/\*|options\/\*\/effects\/\*)(?:\/(?:then|else)\/\*)*\/condition\/source$/,
    SOURCE,
  ],
  [/^\/scenes\/\*\/data\/events\/\*\/options\/\*\/effects\/\*/, OWNER],
  // #121 expands every existing Condition host into the same recursive typed Condition contract.
  // These are genuinely new leaves relative to the prior Always/Variable/Lua union. Keep the
  // previously reviewed legacy leaves aligned while classifying recursive structure and typed
  // operand/matcher leaves as owner contributions. Lua `source` leaves retain their existing
  // source-analysis classifications below/through preserved review slots.
  [
    /^(?!.*\/additionalDependencies\/).*\/(?:condition|guard|availability|visibility|canEnter|canLeave|waitCondition)(?=\/|$)(?=.*(?:\/conditions\/\*|\/condition$|\/owner\/|\/propertyId$|\/trait\/|\/present$|\/subject\/|\/location\/|\/inventory\/|\/matcher\/|\/quantity$|\/bindingId$|\/slotId$))/,
    OWNER,
  ],
  [/^\/bootstrapModule\//, OWNER],
  [/^\/assets\/\*\/data\/imageMetadata\//, OWNER],
  [/\/inventor(?:y|ies)\//, OWNER],
  // #116 introduces the canonical project-level declared Interactable Instance registry. Every
  // registry field contributes directly to the runtime world projection; definition records remain
  // reusable immutable configuration and no longer own initial state.
  [/^\/interactableInstances\//, OWNER],
  // #117 adds intrinsic stackability and an optional quantity ceiling to reusable Interactable
  // definitions. Both alter the owning definition's compiled/runtime quantity contract.
  [/^\/interactables\/\*\/data\/(?:stackable|stackLimit)$/, OWNER],
  [/^\/interactables\/\*\/data\/features\//, OWNER],
  // #139 makes Feature Property declarations owner-local. Interactable-definition Features
  // contribute reusable schemas/Defaults; Room Features contribute concrete local Values.
  [
    /^\/interactables\/\*\/data\/features\/\*\/(?:defaultProperties|localProperties)(?:\/|$)/,
    OWNER,
  ],
  [/^\/interactables\/\*\/data\/presentation\/hotspots\//, OWNER],
  [/\/feature\//, OWNER],
  [/\/featureId$/, OWNER],
  [/^\/rooms\/\*\/data\/features\//, OWNER],
  [/^\/rooms\/\*\/data\/features\/\*\/(?:defaultProperties|localProperties)(?:\/|$)/, OWNER],
  [/^\/rooms\/\*\/data\/hotspots\//, OWNER],
  // #74 adds direct Room Hook Registry mappings at the preserved authoring schema version.
  // Hook kind, stable module reference, and named export all contribute runtime dependencies.
  [/^\/rooms\/\*\/data\/scriptHooks\//, OWNER],
  // #88 adds logical world framing without changing the preserved authoring schema version.
  // Presentation-space, Camera View, and Anchor leaves all affect the owning Room's compiled
  // presentation contribution and focused-preview invalidation.
  [/^\/rooms\/\*\/data\/(?:presentationSpace|anchors)\//, OWNER],
  // #80/#81 add the reusable Layout Mount contract at the preserved authoring schema version.
  // Inputs, signals, and recursive State Shapes change the Layout runtime/save contribution and preview.
  [/^\/layouts\/\*\/data\/contract\//, OWNER],
  // #86 adds the replaceable Command Builder System Layout at the preserved authoring schema
  // version. Its Layout reference contributes to runtime/UI dependency and preview invalidation.
  [/^\/settings\/ui\/systemLayouts\/command-builder\//, OWNER],
  [/^\/settings\/ui\/systemLayouts\/scene-text\//, OWNER],
  [/^\/settings\/ui\/systemLayouts\/scene-choice\//, OWNER],
  // #96 replaces provisional Scene steps/default presentation with ordered Events and an
  // invocation-local Stage at the preserved authoring schema version. Timeline/dependency leaves
  // and the Stage discriminator/staged-Room reference are genuinely new owner contributions;
  // equivalent Event operation and blank-Stage presentation leaves are path-mapped below to their
  // previously reviewed step/default presentation effects.
  [/^\/scenes\/\*\/data\/stage\/kind$/, OWNER],
  [/^\/scenes\/\*\/data\/stage\/room\//, OWNER],
  [/^\/scenes\/\*\/data\/(?:steps|events)\/\*\/timeline\//, OWNER],
  [/^\/scenes\/\*\/data\/(?:steps|events)\/\*\/completionDependencies\//, OWNER],
  // #97 replaces the generic Scene continuation target with explicit typed Scene inputs,
  // Outcomes, Scene call/detached-start bindings, and terminal control. These are all owner-local
  // execution contract fields and therefore directly affect the Scene dependency contribution.
  [/^\/scenes\/\*\/data\/(?:inputs|outcomes|terminal)\//, OWNER],
  [/^\/scenes\/\*\/data\/(?:steps|events)\/\*\/(?:scene|inputs)(?:\/|$)/, OWNER],
  [/^\/scenes\/\*\/data\/(?:steps|events)\/\*\/owner$/, OWNER],
  // #99 adds explicit Scene presentation ownership plus typed semantic waits at the preserved
  // authoring schema version. Wait targets and pure-condition structure contribute to the owning
  // Scene program; Lua predicate source keeps source-analysis semantics.
  [/^\/scenes\/\*\/data\/(?:steps|events)\/\*\/waitCondition\/source$/, SOURCE],
  [/^\/scenes\/\*\/data\/(?:steps|events)\/\*\/waitCondition(?:\/|$)/, OWNER],
  [/^\/scenes\/\*\/data\/(?:steps|events)\/\*\/(?:eventId|signalId)$/, OWNER],
  // #100 adds typed Scene gameplay/runtime-world transactions plus Room/Interaction orchestration
  // at the preserved authoring schema version. Every new field is part of the owning Scene runtime
  // program and therefore contributes to that Scene's dependency and preview invalidation surface.
  [
    /^\/scenes\/\*\/data\/(?:steps|events)\/\*\/(?:operations|bindings|verb|room|exitId)(?:\/|$)/,
    OWNER,
  ],
  // #89 adds Project audio mixing policy and expands Scene audio cues at the preserved authoring
  // schema version. Project mix fields and the genuinely new cue dimensions all contribute to
  // runtime projection; purpose/lifetime/gain replace the retired channel/loop/volume leaves and
  // are path-mapped below so the pre-#89 reviewed sequence remains aligned.
  [/^\/settings\/audio\//, OWNER],
  [
    /^\/scenes\/\*\/data\/(?:steps|events)\/\*\/(?:pausePolicy|pan|panSource|causality|synchronized|skipBehavior|instanceId|replacementGroup)(?:\/|$)/,
    OWNER,
  ],
  // #90 adds occurrence-local Material Parameters and bounded postprocess effects without changing
  // the preserved authoring schema version. Every field in those Scene step variants affects the
  // owning Scene's compiled presentation program and preview invalidation.
  [
    /^\/scenes\/\*\/data\/(?:steps|events)\/\*\/(?:target|parameters)(?:\/|$)|^\/scenes\/\*\/data\/(?:steps|events)\/\*\/(?:parameter|easing|clock|scope|order)$|^\/scenes\/\*\/data\/(?:steps|events)\/\*\/value\/(?:\*|r|g|b|a)$/,
    OWNER,
  ],
  // #91 replaces the provisional Character pose/expression sprite pair with named Presentation
  // Profiles, ordered Layers, profile-local Poses, semantic Expression overrides, and optional
  // Appearance at the preserved authoring schema version. These fields all contribute to the
  // Character's compiled presentation definition and focused-preview dependency surface.
  [/^\/characters\/\*\/data\/defaults\/(?:profileId|appearanceId)$/, OWNER],
  [/^\/characters\/\*\/data\/profiles\//, OWNER],
  [/^\/characters\/\*\/data\/expressions\/\*\/profiles\//, OWNER],
  [/^\/characters\/\*\/data\/appearances\//, OWNER],
  // #92 adds transient Gesture definitions and restricted cue events at the preserved authoring
  // schema version. Gesture profile mappings, clip references, and presentation/audio cue fields
  // contribute to the Character's compiled presentation and asset dependency surface.
  [/^\/characters\/\*\/data\/gestures\//, OWNER],
  [/^\/rooms\/\*\/data\/cast\/\*\/(?:profileId|appearanceId)$/, OWNER],
  [/^\/scenes\/\*\/data\/(?:steps|events)\/\*\/(?:profileId|appearanceId)$/, OWNER],
  [/^\/scenes\/\*\/data\/(?:steps|events)\/\*\/children\/\*\/(?:profileId|appearanceId)$/, OWNER],
  // #83 atomically replaces positional Verb arity/operand contracts with named slots, stable
  // binding order, completed-command text, and reusable Subject Selectors at the preserved authoring
  // schema version. These leaves all contribute to the owning Verb or Interaction projection.
  [/^\/verbs\/\*\/data\/completedCommandText(?:\/|$)/, OWNER],
  [/^\/verbs\/\*\/data\/slots\/\*\/(?:label|prompt|selectors)(?:\/|$)/, OWNER],
  [/^\/interactions\/\*\/data\/rules\/\*\/slots\/\*\/slotId$/, OWNER],
  [
    /^\/interactions\/\*\/data\/rules\/\*\/slots\/\*\/selectors\/\*\/(?:family|trait|interactableDefinition|interactableFeature|pattern)(?:\/|$)/,
    OWNER,
  ],
  [/^\/tests\/\*\/data\/steps\/\*\/runInteraction\/bindings\/\*\/slotId$/, OWNER],
  [/^\/tests\/\*\/data\/steps\/\*\/subjectAction\//, OWNER],
  // #84 adds explicit Verb Offers and opt-in rule-derived Offers at the preserved authoring schema
  // version. Discovery selectors, optional pure conditions, starting slots, rank, and primary intent
  // all contribute to the owning Verb/Interaction runtime projection.
  [/^\/verbs\/\*\/data\/offers\//, OWNER],
  [/^\/interactions\/\*\/data\/rules\/\*\/offer(?:\/|$)/, OWNER],
  // #85 replaces semantic Interaction contexts with pure Guards and explicit priority, and adds an
  // optional Project undefined-interaction behavior at the preserved authoring schema version.
  // Guard/program Lua source remains source-analyzed; all other leaves contribute to runtime shape.
  [/^\/interactions\/\*\/data\/rules\/\*\/guard\/source$/, SOURCE],
  [/^\/interactions\/\*\/data\/rules\/\*\/(?:guard|priority)(?:\/|$)/, OWNER],
  [/^\/undefinedInteractionProgram\/instructions\/\*\/effect\/source$/, SOURCE],
  [/^\/undefinedInteractionProgram(?:\/|$)/, OWNER],
  // #82 atomically replaces provisional Map point/shape and authored endpoint fields at the preserved
  // authoring schema version. New geometry, visibility, presentation, ordering, and exit-pair leaves
  // all contribute to the owning Map runtime projection.
  [
    /^\/maps\/\*\/data\/locations\/\*\/(?:regions|icon|style|labelAnchor|connectionAnchor|visibility|pickOrder|logicalOrder)(?:\/|$)/,
    OWNER,
  ],
  [
    /^\/maps\/\*\/data\/connections\/\*\/(?:exits|label|icon|style|visibility|logicalOrder|path|hitRegions)(?:\/|$)/,
    OWNER,
  ],
  // #93 adds Dialogue-owned Stage/Media Slot declarations. #94 atomically replaces the retained
  // per-Line presentation blob with typed inline cues at the preserved authoring schema version.
  // Every field changes the owning Dialogue's compiled/runtime projection; none creates an
  // independent dependency-graph identity.
  [/^\/dialogues\/\*\/data\/(?:stageSlots|mediaSlots)(?:\/|$)/, OWNER],
  [/^\/dialogues\/\*\/data\/blocks\/\*\/segments\/\*\/cues(?:\/|$)/, OWNER],
  // #98 adds Dialogue child-Scene bindings/UI policy and Handoff payload at the preserved authoring
  // schema version. These leaves alter the owning Dialogue runtime program but do not introduce a
  // separately addressable dependency-graph node.
  [
    /^\/dialogues\/\*\/data\/blocks\/\*\/segments\/\*\/(?:scene|inputs|uiPolicy|payload)(?:\/|$)/,
    OWNER,
  ],
  // #102 cuts editor-authored Tests over to semantic runtime identities. These editor-only fields
  // select an already-compiled runtime input and do not alter the Authoring dependency graph.
  [
    /^\/tests\/\*\/data\/steps\/\*\/(?:dialogueChoice\/edgeId|sceneChoice\/optionId|navigate\/exitId|saveSlot\/slotId)$/,
    NONE,
  ],
  [/^\/shaders\/\*\/data\/samplers\/\*\/binding$/, OWNER],
  // #136 introduces ordered owner-local Property declarations on migrated Room/Character owners.
  // Every declaration field contributes directly to that exact owner's compiled/runtime state.
  [/^\/(?:rooms|characters)\/\*\/localProperties(?:\/|$)/, OWNER],
  // #138 adds reusable Interactable-definition Property contracts and exact Instance-local
  // Properties at the preserved authoring version. Both change the owning semantic object's
  // compiled/runtime Property projection rather than creating an independent graph identity.
  [/^\/interactables\/\*\/defaultProperties(?:\/|$)/, OWNER],
  [/^\/interactableInstances\/\*\/localProperties(?:\/|$)/, OWNER],
  // #120 gives each Room one optional catchall placement for semantically present Interactable
  // Instances that have no exact authored occurrence. It changes only the owning Room projection.
  [/^\/rooms\/\*\/data\/fallbackInteractablePlacementId$/, OWNER],
  // Nullable is a new Variable runtime semantic in #136. The renamed authored `value` leaf is
  // preserved against the previous `defaultValue` review slot below.
  [/^\/variables\/\*\/data\/nullable$/, OWNER],
]);

function explicitFieldEffect(path: JsonPointer): AuthoringFieldGraphEffect | undefined {
  return EXPLICIT_FIELD_EFFECTS.find(([pattern]) => pattern.test(path))?.[1];
}

function reviewedFieldEffect(
  code: string | undefined,
  path: JsonPointer,
): AuthoringFieldGraphEffect {
  switch (code as ReviewedFieldEffectCode | undefined) {
    case 'n':
      return NONE;
    case 'o':
      return OWNER;
    case 's':
      return SOURCE;
    case 'y':
      return SYMBOL;
    case 't':
      return Object.freeze({ kind: 'structural' });
    case 'a':
      return valueDependent('asset-source-impact');
    case 'l':
      return valueDependent('localization-catalog-entry');
    case 'p':
      return valueDependent('property-assignment');
    case 'v':
      return valueDependent('structural-variant');
    default:
      throw new Error(`Authoring graph field '${path}' has no reviewed effect declaration.`);
  }
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const schemaLeafPaths = new Set<JsonPointer>();
collectSchemaLeafPaths(authoringProjectSchema, schemaLeafPaths);
const sortedSchemaLeafPaths = [...schemaLeafPaths].sort();

// Export configuration moved from /settings/{export,platformExport} to /export. It has no
// dependency-graph effect, but the reviewed code sequence predates that top-level reclassification.
// Relocate the old export-config code block to the new schema position and normalize it to `none` so
// unrelated field classifications retain their reviewed alignment.
const exportLeafCount = sortedSchemaLeafPaths.filter((path) => path.startsWith('/export/')).length;
const retiredExportLeafCount = 3; // capabilityOverrides, signingProfileId, and formatVersion
const legacyExportLeafCount = exportLeafCount + retiredExportLeafCount;
const exportFirstLeafIndex = sortedSchemaLeafPaths.findIndex((path) => path.startsWith('/export/'));
const settingsPresentationLeafIndex = sortedSchemaLeafPaths.findIndex((path) =>
  path.startsWith('/settings/presentation/'),
);
const reviewedCountBefore = (leafIndex: number) =>
  sortedSchemaLeafPaths
    .slice(0, leafIndex)
    .filter(
      (path) =>
        !explicitFieldEffect(path) && roomLifecycleGameplayCommandEffect(path) === undefined,
    ).length;
const exportInsertReviewedIndex = reviewedCountBefore(exportFirstLeafIndex);
const legacyExportReviewedIndex =
  reviewedCountBefore(settingsPresentationLeafIndex) - legacyExportLeafCount;
const reviewedWithoutLegacyExport =
  REVIEWED_FIELD_EFFECT_CODES.slice(0, legacyExportReviewedIndex) +
  REVIEWED_FIELD_EFFECT_CODES.slice(legacyExportReviewedIndex + legacyExportLeafCount);
const PRE_TRAIT_REVIEWED_FIELD_EFFECT_CODES =
  reviewedWithoutLegacyExport.slice(0, exportInsertReviewedIndex) +
  'n'.repeat(exportLeafCount) +
  reviewedWithoutLegacyExport.slice(exportInsertReviewedIndex);

// #68 replaces the universal same-type `extends` leaf on Property-bearing records with a Trait
// attachment array and adds top-level Trait declarations. #69 then adds explicit Archetype records
// plus one Archetype attachment/override map on declared Gameplay Instances. Preserve every
// previously reviewed field effect by path, then classify only the new Trait and Archetype leaves
// explicitly as owner contributions. Both are atomic contract replacements at the already-selected
// authoring version.
const legacyTraitBearingRoots = new Set([
  'characters',
  'dialogues',
  'interactables',
  'interactions',
  'maps',
  'rooms',
  'scenes',
  'verbs',
]);
const retiredPropertyBearingRoots = [
  'dialogues',
  'interactions',
  'maps',
  'scenes',
  'verbs',
] as const;
function isArchetypeContractLeaf(path: JsonPointer): boolean {
  if (path.startsWith('/archetypes/')) return true;
  const segments = parseJsonPointer(path);
  return (
    segments.length >= 3 &&
    ['characters', 'rooms', 'interactables'].includes(segments[0] ?? '') &&
    segments[1] === '*' &&
    (segments[2] === 'archetype' || segments[2] === 'archetypeOverrides')
  );
}

function isItemContractLeaf(path: JsonPointer): boolean {
  return (
    path.startsWith('/itemDefinitions/') ||
    path.startsWith('/itemStacks/') ||
    path.includes('/itemStack/')
  );
}

function isSceneChoiceGameplayCommandLeaf(path: JsonPointer): boolean {
  return path.startsWith('/scenes/*/data/events/*/options/*/effects/*');
}

function roomLifecycleGameplayCommandEffect(
  path: JsonPointer,
): ReviewedFieldEffectCode | undefined {
  if (
    !/^\/rooms\/\*\/data\/(?:lifecycle\/(?:beforeEnter|afterEnter|beforeLeave|afterLeave|onEnterRejected|onLeaveRejected)\/\*|exits\/\*\/onRejected\/\*)/.test(
      path,
    )
  )
    return undefined;
  return /(?:^|\/)source$/.test(path) ? 's' : 'o';
}

function preservedReviewedPath(path: JsonPointer): JsonPointer {
  // #122 preserves the reviewed Interaction instruction contribution for the legacy-compatible
  // Global Property/Lua leaves after removing the `apply-effect` wrapper.
  if (
    /^(?:\/undefinedInteractionProgram\/instructions\/\*|\/verbs\/\*\/data\/defaultProgram\/instructions\/\*|\/interactions\/\*\/data\/rules\/\*\/program\/instructions\/\*)\/(?:variable\/\$ref\/(?:collection|id)|value|source)$/.test(
      path,
    )
  )
    return path.replace('/instructions/*/', '/instructions/*/effect/') as JsonPointer;
  const interactionProgramHost =
    /^(?:\/verbs\/\*\/data\/defaultProgram|\/interactions\/\*\/data\/rules\/\*\/program)\/instructions\/\*/;
  if (interactionProgramHost.test(path) && path.endsWith('/subject/interactable/$ref/registry'))
    return path.replace(
      '/subject/interactable/$ref/registry',
      '/interactable/$ref/collection',
    ) as JsonPointer;
  if (interactionProgramHost.test(path) && path.endsWith('/subject/interactable/$ref/id'))
    return path.replace('/subject/interactable/$ref/id', '/interactable/$ref/id') as JsonPointer;
  if (interactionProgramHost.test(path) && path.endsWith('/location/kind'))
    return path.replace('/location/kind', '/target/kind') as JsonPointer;
  if (interactionProgramHost.test(path) && path.endsWith('/location/room/room/$ref/collection'))
    return path.replace(
      '/location/room/room/$ref/collection',
      '/target/room/$ref/collection',
    ) as JsonPointer;
  if (interactionProgramHost.test(path) && path.endsWith('/location/room/room/$ref/id'))
    return path.replace('/location/room/room/$ref/id', '/target/room/$ref/id') as JsonPointer;
  const segments = parseJsonPointer(path);
  if (path === ('/variables/*/data/value' as JsonPointer))
    return '/variables/*/data/defaultValue' as JsonPointer;
  if (
    segments.length >= 5 &&
    segments[0] === 'scenes' &&
    segments[1] === '*' &&
    segments[2] === 'data' &&
    segments[3] === 'events' &&
    segments[4] === '*'
  ) {
    const legacy = [...segments];
    legacy[3] = 'steps';
    if (legacy.length === 6) {
      if (legacy[5] === 'purpose') legacy[5] = 'channel';
      if (legacy[5] === 'lifetime') legacy[5] = 'loop';
      if (legacy[5] === 'gain') legacy[5] = 'volume';
    }
    return `/${legacy.join('/')}` as JsonPointer;
  }
  if (
    segments.length >= 6 &&
    segments[0] === 'scenes' &&
    segments[1] === '*' &&
    segments[2] === 'data' &&
    segments[3] === 'stage' &&
    segments[4] === 'background'
  )
    return `/scenes/*/data/defaultBackground/${segments.slice(5).join('/')}` as JsonPointer;
  if (
    segments.length >= 5 &&
    segments[0] === 'scenes' &&
    segments[1] === '*' &&
    segments[2] === 'data' &&
    segments[3] === 'stage' &&
    segments[4] === 'layout'
  )
    return `/scenes/*/data/defaultLayout/${segments.slice(5).join('/')}` as JsonPointer;
  if (
    segments.length === 6 &&
    segments[0] === 'scenes' &&
    segments[1] === '*' &&
    segments[2] === 'data' &&
    segments[3] === 'steps' &&
    segments[4] === '*'
  ) {
    if (segments[5] === 'purpose') return '/scenes/*/data/steps/*/channel';
    if (segments[5] === 'lifetime') return '/scenes/*/data/steps/*/loop';
    if (segments[5] === 'gain') return '/scenes/*/data/steps/*/volume';
  }
  if (
    segments.length === 6 &&
    segments[0] === 'verbs' &&
    segments[1] === '*' &&
    segments[2] === 'data' &&
    segments[3] === 'slots' &&
    segments[4] === '*' &&
    segments[5] === 'id'
  )
    return '/verbs/*/data/arity';
  if (
    segments.length === 5 &&
    segments[0] === 'verbs' &&
    segments[1] === '*' &&
    segments[2] === 'data' &&
    segments[3] === 'bindingOrder' &&
    segments[4] === '*'
  )
    return '/verbs/*/data/operandRoles/*';
  if (
    segments.length === 10 &&
    segments[0] === 'interactions' &&
    segments[1] === '*' &&
    segments[2] === 'data' &&
    segments[3] === 'rules' &&
    segments[4] === '*' &&
    segments[5] === 'slots' &&
    segments[6] === '*' &&
    segments[7] === 'selectors' &&
    segments[8] === '*' &&
    segments[9] === 'kind'
  )
    return '/interactions/*/data/rules/*/operands/*/kind';
  if (
    segments.length >= 11 &&
    segments[0] === 'interactions' &&
    segments[1] === '*' &&
    segments[2] === 'data' &&
    segments[3] === 'rules' &&
    segments[4] === '*' &&
    segments[5] === 'slots' &&
    segments[6] === '*' &&
    segments[7] === 'selectors' &&
    segments[8] === '*' &&
    segments[9] === 'subject'
  )
    return `/interactions/*/data/rules/*/operands/*/subject/${segments
      .slice(10)
      .join('/')}` as JsonPointer;
  if (
    segments.length >= 10 &&
    segments[0] === 'tests' &&
    segments[1] === '*' &&
    segments[2] === 'data' &&
    segments[3] === 'steps' &&
    segments[4] === '*' &&
    segments[5] === 'runInteraction' &&
    segments[6] === 'bindings' &&
    segments[7] === '*' &&
    segments[8] === 'subject'
  )
    return `/tests/*/data/steps/*/runInteraction/operands/*/${segments
      .slice(9)
      .join('/')}` as JsonPointer;
  if (
    segments.length === 4 &&
    legacyTraitBearingRoots.has(segments[0] ?? '') &&
    segments[1] === '*' &&
    segments[2] === 'traits' &&
    segments[3] === '*'
  )
    return `/${segments[0]}/*/extends` as JsonPointer;
  return path;
}

const legacySchemaLeafPaths = [
  ...sortedSchemaLeafPaths
    .filter(
      (path) =>
        !path.startsWith('/traits/') &&
        !isArchetypeContractLeaf(path) &&
        !isItemContractLeaf(path) &&
        !isSceneChoiceGameplayCommandLeaf(path) &&
        roomLifecycleGameplayCommandEffect(path) === undefined,
    )
    .map(preservedReviewedPath),
  // The assembled AuthoringProject no longer owns a compatibility epoch. Preserve its retired
  // top-level version leaf only for alignment with the reviewed pre-refactor graph-effect sequence.
  '/schemaVersion' as JsonPointer,
  ...retiredPropertyBearingRoots.flatMap((root) => [
    `/${root}/*/extends` as JsonPointer,
    `/${root}/*/properties/*` as JsonPointer,
  ]),
  // #141 contracts the temporary global identity Property registry and the last value-only
  // assignment maps. Preserve those retired same-version leaves only to keep the pre-#141 reviewed
  // field-effect sequence aligned; owner-local/default Property leaves are classified by their
  // existing owner contributions.
  '/properties/*/defaultValue' as JsonPointer,
  '/properties/*/description' as JsonPointer,
  '/properties/*/enumValues/*' as JsonPointer,
  '/properties/*/id' as JsonPointer,
  '/properties/*/label' as JsonPointer,
  '/properties/*/nullable' as JsonPointer,
  '/properties/*/ownerKinds/*' as JsonPointer,
  '/properties/*/type' as JsonPointer,
  '/characters/*/properties/*' as JsonPointer,
  '/rooms/*/properties/*' as JsonPointer,
  '/interactables/*/properties/*' as JsonPointer,
  // #71 moves semantic enabled state off Room presentation occurrences and introduces canonical
  // Interactable Location in its place. Keep the retired leaf only to preserve the pre-#71
  // reviewed-effect alignment; the new Location leaves are classified explicitly above.
  '/rooms/*/data/interactables/*/enabled' as JsonPointer,
  // #116 moves declared Interactable enabled/visible state from reusable definitions to the exact
  // project-level Instance registry. Registry leaves are classified explicitly above; retain the
  // two removed definition-state leaves solely to preserve the reviewed sequence alignment.
  '/interactables/*/data/initialState/enabled' as JsonPointer,
  '/interactables/*/data/initialState/visible' as JsonPointer,
  // #72 atomically replaces the one-leaf startupHook source with a two-leaf typed Script Module
  // reference at the same schema version. The new reference leaves are classified explicitly above;
  // retain the retired source leaf only so the preserved pre-replacement reviewed sequence does not
  // shift unrelated field effects.
  '/startupHook/source' as JsonPointer,
  // #84 replaces the provisional Verb quickAction leaf with explicit/rule-derived Offer semantics
  // at the preserved authoring schema version. Retain the retired leaf only to preserve the
  // pre-replacement reviewed-effect alignment; all Offer leaves are classified explicitly above.
  '/verbs/*/data/quickAction' as JsonPointer,
  // #79 removes the provisional Room lifecycle effect arrays and standalone composition Script
  // surface. Lifecycle handlers and Compose are now resolved exclusively through the #74 Hook
  // Registry mappings. Retain the removed same-version leaves so unrelated reviewed graph effects
  // remain aligned with the pre-#79 schema contract.
  ...['afterEnter', 'afterLeave', 'beforeEnter', 'beforeLeave'].flatMap((hook) => [
    `/rooms/*/data/lifecycle/${hook}/*/kind` as JsonPointer,
    `/rooms/*/data/lifecycle/${hook}/*/source` as JsonPointer,
    `/rooms/*/data/lifecycle/${hook}/*/value` as JsonPointer,
    `/rooms/*/data/lifecycle/${hook}/*/variable/$ref/collection` as JsonPointer,
    `/rooms/*/data/lifecycle/${hook}/*/variable/$ref/id` as JsonPointer,
  ]),
  '/rooms/*/data/compose/additionalDependencies/targets/*/collection' as JsonPointer,
  '/rooms/*/data/compose/additionalDependencies/targets/*/exitId' as JsonPointer,
  '/rooms/*/data/compose/additionalDependencies/targets/*/id' as JsonPointer,
  '/rooms/*/data/compose/additionalDependencies/targets/*/kind' as JsonPointer,
  '/rooms/*/data/compose/additionalDependencies/targets/*/owner/id' as JsonPointer,
  '/rooms/*/data/compose/additionalDependencies/targets/*/owner/kind' as JsonPointer,
  '/rooms/*/data/compose/additionalDependencies/targets/*/placementId' as JsonPointer,
  '/rooms/*/data/compose/additionalDependencies/targets/*/propertyId' as JsonPointer,
  '/rooms/*/data/compose/additionalDependencies/targets/*/roomId' as JsonPointer,
  '/rooms/*/data/compose/script/$ref/collection' as JsonPointer,
  '/rooms/*/data/compose/script/$ref/id' as JsonPointer,
  // #85 removes semantic Interaction contexts. Retain those same-version leaves solely to keep the
  // pre-#85 reviewed graph-effect alignment while the replacement Guard/priority leaves above are
  // classified explicitly.
  ...sortedSchemaLeafPaths
    .filter((path) => /^\/interactions\/\*\/data\/rules\/\*\/guard(?:\/|$)/.test(path))
    .map((path) => path.replace('/guard', '/context/condition') as JsonPointer),
  '/interactions/*/data/rules/*/context/kind' as JsonPointer,
  '/interactions/*/data/rules/*/context/room/$ref/collection' as JsonPointer,
  '/interactions/*/data/rules/*/context/room/$ref/id' as JsonPointer,
  '/interactions/*/data/rules/*/context/placement/room' as JsonPointer,
  '/interactions/*/data/rules/*/context/placement/placement' as JsonPointer,
  // #122 removes the nested Apply Effect discriminator while preserving equivalent Global Property
  // and Lua commands at the instruction level. The top-level command discriminator already occupies
  // the old instruction-kind review slot, so retain only this removed nested discriminator for the
  // two reviewed Interaction-program hosts.
  '/interactions/*/data/rules/*/program/instructions/*/effect/kind' as JsonPointer,
  '/verbs/*/data/defaultProgram/instructions/*/effect/kind' as JsonPointer,
  // #82 removes provisional Map position/shape and separately-authored Connection endpoint fields.
  // Retain those removed same-version leaves solely to preserve reviewed-effect alignment; every new
  // #82 Map leaf is classified explicitly above.
  '/maps/*/data/locations/*/position/x' as JsonPointer,
  '/maps/*/data/locations/*/position/y' as JsonPointer,
  '/maps/*/data/locations/*/shape/kind' as JsonPointer,
  '/maps/*/data/locations/*/shape/radius' as JsonPointer,
  '/maps/*/data/locations/*/shape/width' as JsonPointer,
  '/maps/*/data/locations/*/shape/height' as JsonPointer,
  '/maps/*/data/connections/*/exit/room' as JsonPointer,
  '/maps/*/data/connections/*/exit/exit' as JsonPointer,
  '/maps/*/data/connections/*/sourceLocation' as JsonPointer,
  '/maps/*/data/connections/*/targetLocation' as JsonPointer,
  // #91 atomically replaces the old Character-wide Pose visual and Expression sprite/material
  // overrides. Retain those removed same-version leaves only to keep unrelated reviewed graph
  // effects aligned; every replacement presentation leaf is classified explicitly above.
  '/characters/*/data/defaults/poseId' as JsonPointer,
  '/characters/*/data/poses/*/id' as JsonPointer,
  '/characters/*/data/poses/*/label' as JsonPointer,
  '/characters/*/data/poses/*/sprite/$ref/collection' as JsonPointer,
  '/characters/*/data/poses/*/sprite/$ref/id' as JsonPointer,
  '/characters/*/data/poses/*/material/$ref/collection' as JsonPointer,
  '/characters/*/data/poses/*/material/$ref/id' as JsonPointer,
  '/characters/*/data/poses/*/offset/x' as JsonPointer,
  '/characters/*/data/poses/*/offset/y' as JsonPointer,
  '/characters/*/data/poses/*/scale' as JsonPointer,
  '/characters/*/data/poses/*/anchor/x' as JsonPointer,
  '/characters/*/data/poses/*/anchor/y' as JsonPointer,
  '/characters/*/data/expressions/*/poseId' as JsonPointer,
  '/characters/*/data/expressions/*/sprite/$ref/collection' as JsonPointer,
  '/characters/*/data/expressions/*/sprite/$ref/id' as JsonPointer,
  '/characters/*/data/expressions/*/material/$ref/collection' as JsonPointer,
  '/characters/*/data/expressions/*/material/$ref/id' as JsonPointer,
  // #97 atomically replaces the generic Scene continuation target with explicit Scene terminal
  // control. Retain the two removed continuation leaves solely to preserve the reviewed pre-#97
  // field-effect sequence; all replacement terminal/input/outcome leaves are classified above.
  '/scenes/*/data/continuation/kind' as JsonPointer,
  '/scenes/*/data/continuation/id' as JsonPointer,
  // #123 replaces the legacy two-variant Scene choice Effect payload with the canonical Gameplay
  // Command union. Preserve the five removed Effect leaves only for pre-#123 reviewed-effect
  // alignment; every replacement command leaf is classified explicitly above.
  '/scenes/*/data/steps/*/options/*/effects/*/kind' as JsonPointer,
  '/scenes/*/data/steps/*/options/*/effects/*/source' as JsonPointer,
  '/scenes/*/data/steps/*/options/*/effects/*/value' as JsonPointer,
  '/scenes/*/data/steps/*/options/*/effects/*/variable/$ref/collection' as JsonPointer,
  '/scenes/*/data/steps/*/options/*/effects/*/variable/$ref/id' as JsonPointer,
  // #102 removes provisional Test-local setup/assertion/UI-gesture forms and replaces the executable
  // step vocabulary with semantic runtime identities. Retain the removed same-version leaves only
  // for alignment with the reviewed pre-#102 graph-effect sequence; the four replacement semantic
  // identity leaves are explicitly `none` above because Tests are editor-only runtime inputs.
  '/tests/*/data/checkScript' as JsonPointer,
  '/tests/*/data/entrypoint/$ref/collection' as JsonPointer,
  '/tests/*/data/entrypoint/$ref/id' as JsonPointer,
  '/tests/*/data/fixedDeltaSeconds' as JsonPointer,
  '/tests/*/data/initScript' as JsonPointer,
  '/tests/*/data/startingInventory/*/$ref/collection' as JsonPointer,
  '/tests/*/data/startingInventory/*/$ref/id' as JsonPointer,
  '/tests/*/data/steps/*/assertions/*/enabled' as JsonPointer,
  '/tests/*/data/steps/*/assertions/*/entity/$ref/collection' as JsonPointer,
  '/tests/*/data/steps/*/assertions/*/entity/$ref/id' as JsonPointer,
  '/tests/*/data/steps/*/assertions/*/expected' as JsonPointer,
  '/tests/*/data/steps/*/assertions/*/expected/*' as JsonPointer,
  '/tests/*/data/steps/*/assertions/*/id' as JsonPointer,
  '/tests/*/data/steps/*/assertions/*/key' as JsonPointer,
  '/tests/*/data/steps/*/assertions/*/label' as JsonPointer,
  '/tests/*/data/steps/*/assertions/*/type' as JsonPointer,
  '/tests/*/data/steps/*/assertions/*/value' as JsonPointer,
  '/tests/*/data/steps/*/assertions/*/variable/$ref/collection' as JsonPointer,
  '/tests/*/data/steps/*/assertions/*/variable/$ref/id' as JsonPointer,
  '/tests/*/data/steps/*/checkScript' as JsonPointer,
  '/tests/*/data/steps/*/deltaSeconds' as JsonPointer,
  '/tests/*/data/steps/*/dialogueOption/optionIndex' as JsonPointer,
  '/tests/*/data/steps/*/initScript' as JsonPointer,
  '/tests/*/data/steps/*/loadSave/payload' as JsonPointer,
  '/tests/*/data/steps/*/loadSave/payload/*' as JsonPointer,
  '/tests/*/data/steps/*/loadSave/slotId' as JsonPointer,
  '/tests/*/data/steps/*/navigate/direction' as JsonPointer,
  '/tests/*/data/steps/*/navigate/target/$ref/collection' as JsonPointer,
  '/tests/*/data/steps/*/navigate/target/$ref/id' as JsonPointer,
  '/tests/*/data/steps/*/setEntrypoint/entrypoint/$ref/collection' as JsonPointer,
  '/tests/*/data/steps/*/setEntrypoint/entrypoint/$ref/id' as JsonPointer,
  '/tests/*/data/steps/*/uiClick/documentId' as JsonPointer,
  '/tests/*/data/steps/*/uiClick/selector' as JsonPointer,
  '/tests/*/data/steps/*/uiClick/target' as JsonPointer,
].sort();
const legacyReviewedPaths = legacySchemaLeafPaths.filter((path) => !explicitFieldEffect(path));
if (legacyReviewedPaths.length !== PRE_TRAIT_REVIEWED_FIELD_EFFECT_CODES.length) {
  throw new Error(
    `Authoring graph Trait contract replacement changed the legacy reviewed leaf set: expected ${PRE_TRAIT_REVIEWED_FIELD_EFFECT_CODES.length}, received ${legacyReviewedPaths.length}.`,
  );
}
const legacyReviewedEffects = new Map(
  legacyReviewedPaths.map(
    (path, index) => [path, PRE_TRAIT_REVIEWED_FIELD_EFFECT_CODES[index]!] as const,
  ),
);
const ACTIVE_REVIEWED_FIELD_EFFECT_CODES = sortedSchemaLeafPaths
  .filter((path) => !explicitFieldEffect(path))
  .map((path) => {
    const roomLifecycleEffect = roomLifecycleGameplayCommandEffect(path);
    if (roomLifecycleEffect) return roomLifecycleEffect;
    if (path.startsWith('/traits/') || isArchetypeContractLeaf(path) || isItemContractLeaf(path))
      return 'o';
    const segments = parseJsonPointer(path);
    if (
      segments.length === 4 &&
      legacyTraitBearingRoots.has(segments[0] ?? '') &&
      segments[1] === '*' &&
      segments[2] === 'traits' &&
      segments[3] === '*'
    )
      return 'o';
    const preserved = legacyReviewedEffects.get(preservedReviewedPath(path));
    if (!preserved)
      throw new Error(
        `Authoring graph field '${path}' has no preserved pre-Trait effect declaration.`,
      );
    return preserved;
  })
  .join('');

const explicitLeafCount = sortedSchemaLeafPaths.filter((path) => explicitFieldEffect(path)).length;
if (
  ACTIVE_REVIEWED_FIELD_EFFECT_CODES.length + explicitLeafCount !==
  sortedSchemaLeafPaths.length
) {
  throw new Error(
    `Authoring graph field effect declarations changed: expected ${ACTIVE_REVIEWED_FIELD_EFFECT_CODES.length + explicitLeafCount} schema leaves, received ${sortedSchemaLeafPaths.length}. Review every leaf and update the declaration sequence.`,
  );
}

export const AUTHORING_GRAPH_FIELD_METADATA: readonly AuthoringGraphFieldMetadata[] = Object.freeze(
  (() => {
    let reviewedIndex = 0;
    return sortedSchemaLeafPaths.map((path) => {
      const explicitEffect = explicitFieldEffect(path);
      const effect =
        explicitEffect ??
        reviewedFieldEffect(ACTIVE_REVIEWED_FIELD_EFFECT_CODES[reviewedIndex++], path);
      return Object.freeze({ path, effect, schemaRoot: schemaRootForPath(path) });
    });
  })(),
);

export const CURRENT_AUTHORING_GRAPH_FIELD_FINGERPRINTS: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      [...new Set(AUTHORING_GRAPH_FIELD_METADATA.map((field) => field.schemaRoot))]
        .sort()
        .map((root) => [
          root,
          fnv1a(
            AUTHORING_GRAPH_FIELD_METADATA.filter((field) => field.schemaRoot === root)
              .map((field) => field.path)
              .join('\n'),
          ),
        ]),
    ),
  );

// Changing an authoring schema field requires reviewing its intrinsic graph effect and updating the
// corresponding fingerprint in the same change. This intentionally has no generated fallback.
export const EXPECTED_AUTHORING_GRAPH_FIELD_FINGERPRINTS: Readonly<Record<string, string>> =
  Object.freeze({
    archetypes: 'f71e0c56',
    assets: 'e718127a',
    bootstrapModule: 'd01eb484',
    characters: '53873c0e',
    dialogues: 'ce13bade',
    entrypoint: 'a61673d4',
    export: 'cb4dc794',
    interactableInstances: '287ef173',
    interactables: '81498bf0',
    interactions: '5fccdb49',
    inventories: 'a8c38dae',
    layouts: '35da7f67',
    localization: '3f6d0d11',
    maps: '9d711bea',
    materials: '546711ca',
    project: 'da3be83d',
    rooms: '568ad3a3',
    scenes: '775ab0fe',
    schema: '63fb9bb9',
    scripts: 'f3482815',
    settings: 'e2c61a79',
    shaders: '94d3aa6e',
    tests: '99f1bf10',
    traits: 'f6534a48',
    undefinedInteractionProgram: '96fc1f59',
    variables: '9c9e4800',
    verbs: '4ad9edd8',
  });

function patternSegmentMatches(pattern: string, actual: string): boolean {
  return pattern === '*' || pattern === actual;
}

function patternMatchesConcretePath(pattern: JsonPointer, path: JsonPointer): boolean {
  const patternSegments = parseJsonPointer(pattern);
  const pathSegments = parseJsonPointer(path);
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, index) =>
    patternSegmentMatches(segment, pathSegments[index]!),
  );
}

function concretePathIsSchemaAncestor(path: JsonPointer, pattern: JsonPointer): boolean {
  const pathSegments = parseJsonPointer(path);
  const patternSegments = parseJsonPointer(pattern);
  if (pathSegments.length >= patternSegments.length) return false;
  return pathSegments.every((segment, index) =>
    patternSegmentMatches(patternSegments[index]!, segment),
  );
}

export function classifyAuthoringGraphInputPath(
  path: JsonPointer,
): AuthoringGraphInputClassification | undefined {
  const direct = AUTHORING_GRAPH_FIELD_METADATA.filter((field) =>
    patternMatchesConcretePath(field.path, path),
  ).sort(
    (left, right) => parseJsonPointer(right.path).length - parseJsonPointer(left.path).length,
  )[0];
  if (direct) return Object.freeze({ path, effect: direct.effect });
  if (
    AUTHORING_GRAPH_FIELD_METADATA.some((field) => concretePathIsSchemaAncestor(path, field.path))
  ) {
    return Object.freeze({ path, effect: { kind: 'structural' as const } });
  }
  return undefined;
}
export function assertAuthoringGraphFieldMetadataComplete(): void {
  const expectedRoots = Object.keys(EXPECTED_AUTHORING_GRAPH_FIELD_FINGERPRINTS).sort();
  const currentRoots = Object.keys(CURRENT_AUTHORING_GRAPH_FIELD_FINGERPRINTS).sort();
  if (JSON.stringify(expectedRoots) !== JSON.stringify(currentRoots)) {
    throw new Error(
      `Authoring graph field metadata roots changed. Expected ${JSON.stringify(expectedRoots)}, received ${JSON.stringify(currentRoots)}.`,
    );
  }
  for (const root of currentRoots) {
    const expected = EXPECTED_AUTHORING_GRAPH_FIELD_FINGERPRINTS[root];
    const current = CURRENT_AUTHORING_GRAPH_FIELD_FINGERPRINTS[root];
    if (expected !== current) {
      throw new Error(
        `Authoring graph field metadata for '${root}' changed: expected ${expected}, received ${current}. Review every new or removed field effect and update the fingerprint.`,
      );
    }
  }
}
