/** Pre-#521 legacy-only nested symbol introspection. The native compiler
 * receives native-admitted records and does not parse them through TS. */
import {
  authoringCollectionKeys,
  type AuthoringCollectionKey,
} from './project-schema/authoring-collections';
import { parseCharacterData } from './project-schema/authoring-characters';
import { parseDialogueData } from './project-schema/authoring-dialogues';
import { parseInteractionData } from './project-schema/authoring-interactions';
import { parseMapData } from './project-schema/authoring-maps';
import type { AuthoringProject, AuthoringRecordBase } from './project-schema/authoring-project';
import { parseRoomData } from './project-schema/authoring-rooms';
import { parseSceneData } from './project-schema/authoring-scenes';
import { parseTestData } from './project-schema/authoring-tests';
import { parseVerbData } from './project-schema/authoring-verbs';
import { escapeJsonPointerSegment } from './json-pointer';

export const compilerNestedNamespaces = [
  'character-pose',
  'character-expression',
  'room-overlay',
  'room-cast',
  'room-prop',
  'room-placement',
  'room-exit',
  'scene-step',
  'scene-branch',
  'scene-choice-option',
  'dialogue-block',
  'dialogue-segment',
  'dialogue-edge',
  'interaction-rule',
  'interaction-instruction',
  'map-location',
  'map-connection',
  'test-step',
] as const;

export type CompilerNestedNamespace = (typeof compilerNestedNamespaces)[number];

export interface NestedAuthoringSymbol {
  id: string;
  ownerId: string;
  sourcePath: string;
}

export interface AuthoringSymbolTables {
  collections: ReadonlyMap<AuthoringCollectionKey, ReadonlyMap<string, AuthoringRecordBase>>;
  nested: ReadonlyMap<CompilerNestedNamespace, ReadonlyMap<string, NestedAuthoringSymbol>>;
}

function nestedSymbolKey(ownerId: string, id: string): string {
  return `${ownerId}\u0000${id}`;
}

function addNestedSymbol(
  nested: Map<CompilerNestedNamespace, Map<string, NestedAuthoringSymbol>>,
  namespace: CompilerNestedNamespace,
  ownerId: string,
  id: string,
  sourcePath: string,
): void {
  let table = nested.get(namespace);
  if (!table) {
    table = new Map<string, NestedAuthoringSymbol>();
    nested.set(namespace, table);
  }
  table.set(nestedSymbolKey(ownerId, id), { id, ownerId, sourcePath });
}

export function buildAuthoringSymbolTables(project: AuthoringProject): AuthoringSymbolTables {
  const collections = new Map<AuthoringCollectionKey, ReadonlyMap<string, AuthoringRecordBase>>();
  for (const collection of authoringCollectionKeys) {
    const records = new Map<string, AuthoringRecordBase>();
    for (const [id, record] of Object.entries(project[collection])) records.set(id, record);
    collections.set(collection, records);
  }

  const nested = new Map<CompilerNestedNamespace, Map<string, NestedAuthoringSymbol>>();
  Object.entries(project.characters).forEach(([ownerId, record]) => {
    const data = parseCharacterData(record.data);
    data?.profiles.forEach((profile, profileIndex) =>
      profile.poses.forEach((pose, poseIndex) =>
        addNestedSymbol(
          nested,
          'character-pose',
          ownerId,
          `${profile.id}:${pose.id}`,
          `/characters/${escapeJsonPointerSegment(ownerId)}/data/profiles/${profileIndex}/poses/${poseIndex}`,
        ),
      ),
    );
    data?.expressions.forEach((expression, index) =>
      addNestedSymbol(
        nested,
        'character-expression',
        ownerId,
        expression.id,
        `/characters/${escapeJsonPointerSegment(ownerId)}/data/expressions/${index}`,
      ),
    );
  });
  Object.entries(project.rooms).forEach(([ownerId, record]) => {
    const data = parseRoomData(record.data);
    data?.overlays.forEach((overlay, index) =>
      addNestedSymbol(
        nested,
        'room-overlay',
        ownerId,
        overlay.id,
        `/rooms/${escapeJsonPointerSegment(ownerId)}/data/overlays/${index}`,
      ),
    );
    data?.cast.forEach((entry, index) =>
      addNestedSymbol(
        nested,
        'room-cast',
        ownerId,
        entry.id,
        `/rooms/${escapeJsonPointerSegment(ownerId)}/data/cast/${index}`,
      ),
    );
    data?.props.forEach((entry, index) =>
      addNestedSymbol(
        nested,
        'room-prop',
        ownerId,
        entry.id,
        `/rooms/${escapeJsonPointerSegment(ownerId)}/data/props/${index}`,
      ),
    );
    data?.placements.forEach((placement, index) =>
      addNestedSymbol(
        nested,
        'room-placement',
        ownerId,
        placement.id,
        `/rooms/${escapeJsonPointerSegment(ownerId)}/data/placements/${index}`,
      ),
    );
    data?.exits.forEach((exit, index) =>
      addNestedSymbol(
        nested,
        'room-exit',
        ownerId,
        exit.id,
        `/rooms/${escapeJsonPointerSegment(ownerId)}/data/exits/${index}`,
      ),
    );
  });
  Object.entries(project.scenes).forEach(([ownerId, record]) => {
    const data = parseSceneData(record.data);
    data?.events.forEach((step, index) => {
      const stepPath = `/scenes/${escapeJsonPointerSegment(ownerId)}/data/events/${index}`;
      addNestedSymbol(nested, 'scene-step', ownerId, step.id, stepPath);
      if (step.type === 'conditional-branch')
        step.branches.forEach((branch, branchIndex) =>
          addNestedSymbol(
            nested,
            'scene-branch',
            ownerId,
            branch.id,
            `${stepPath}/branches/${branchIndex}`,
          ),
        );
      if (step.type === 'choice')
        step.options.forEach((option, optionIndex) =>
          addNestedSymbol(
            nested,
            'scene-choice-option',
            ownerId,
            option.id,
            `${stepPath}/options/${optionIndex}`,
          ),
        );
    });
  });
  Object.entries(project.dialogues).forEach(([ownerId, record]) => {
    const data = parseDialogueData(record.data);
    data?.blocks.forEach((block, blockIndex) => {
      const blockPath = `/dialogues/${escapeJsonPointerSegment(ownerId)}/data/blocks/${blockIndex}`;
      addNestedSymbol(nested, 'dialogue-block', ownerId, block.id, blockPath);
      if (block.type === 'sequence')
        block.segments.forEach((segment, segmentIndex) =>
          addNestedSymbol(
            nested,
            'dialogue-segment',
            ownerId,
            segment.id,
            `${blockPath}/segments/${segmentIndex}`,
          ),
        );
    });
    data?.edges.forEach((edge, index) =>
      addNestedSymbol(
        nested,
        'dialogue-edge',
        ownerId,
        edge.id,
        `/dialogues/${escapeJsonPointerSegment(ownerId)}/data/edges/${index}`,
      ),
    );
  });
  Object.entries(project.verbs).forEach(([ownerId, record]) => {
    const data = parseVerbData(record.data);
    data?.defaultProgram.instructions.forEach((instruction, index) =>
      addNestedSymbol(
        nested,
        'interaction-instruction',
        `verb:${ownerId}`,
        instruction.id,
        `/verbs/${escapeJsonPointerSegment(ownerId)}/data/defaultProgram/instructions/${index}`,
      ),
    );
  });
  Object.entries(project.interactions).forEach(([ownerId, record]) => {
    const data = parseInteractionData(record.data);
    data?.rules.forEach((rule, ruleIndex) => {
      addNestedSymbol(
        nested,
        'interaction-rule',
        ownerId,
        rule.id,
        `/interactions/${escapeJsonPointerSegment(ownerId)}/data/rules/${ruleIndex}`,
      );
      rule.program.instructions.forEach((instruction, instructionIndex) =>
        addNestedSymbol(
          nested,
          'interaction-instruction',
          `interaction:${ownerId}:${rule.id}`,
          instruction.id,
          `/interactions/${escapeJsonPointerSegment(ownerId)}/data/rules/${ruleIndex}/program/instructions/${instructionIndex}`,
        ),
      );
    });
  });
  Object.entries(project.maps).forEach(([ownerId, record]) => {
    const data = parseMapData(record.data);
    data?.locations.forEach((location, index) =>
      addNestedSymbol(
        nested,
        'map-location',
        ownerId,
        location.id,
        `/maps/${escapeJsonPointerSegment(ownerId)}/data/locations/${index}`,
      ),
    );
    data?.connections.forEach((connection, index) =>
      addNestedSymbol(
        nested,
        'map-connection',
        ownerId,
        connection.id,
        `/maps/${escapeJsonPointerSegment(ownerId)}/data/connections/${index}`,
      ),
    );
  });
  Object.entries(project.tests).forEach(([ownerId, record]) => {
    const data = parseTestData(record.data);
    data?.steps.forEach((step, stepIndex) => {
      const stepPath = `/tests/${escapeJsonPointerSegment(ownerId)}/data/steps/${stepIndex}`;
      addNestedSymbol(nested, 'test-step', ownerId, step.id, stepPath);
    });
  });
  return { collections, nested };
}

export function resolveAuthoringSymbol(
  symbols: AuthoringSymbolTables,
  collection: AuthoringCollectionKey,
  id: string,
): AuthoringRecordBase | undefined {
  return symbols.collections.get(collection)?.get(id);
}

export function resolveNestedAuthoringSymbol(
  symbols: AuthoringSymbolTables,
  namespace: CompilerNestedNamespace,
  ownerId: string,
  id: string,
): NestedAuthoringSymbol | undefined {
  return symbols.nested.get(namespace)?.get(nestedSymbolKey(ownerId, id));
}
