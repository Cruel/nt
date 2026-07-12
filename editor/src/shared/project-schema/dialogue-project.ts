import { parseCharacterData } from './authoring-characters';
import {
  parseDialogueData,
  validateDialogueData,
  type DialogueBlockData,
  type DialogueCharacterRef,
  type DialogueData,
  type DialoguePreviewBackground,
  type DialogueSegmentData,
  type DialogueSequenceBlockData,
} from './authoring-dialogues';
import type { Condition, Effect } from './authoring-flow';
import type { AuthoringProject } from './authoring-project';

export const DIALOGUE_PREVIEW_SCHEMA = 'noveltea.dialogue-preview.v2' as const;

export interface DialoguePreviewOptions {
  selectedBlockId?: string | null;
  selectedSegmentId?: string | null;
  showConditions?: boolean;
  background?: DialoguePreviewBackground;
}

export interface DialogueProjectDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

const diagnostic = (
  path: string,
  message: string,
  severity: DialogueProjectDiagnostic['severity'] = 'error',
): DialogueProjectDiagnostic => ({ severity, path, message, category: 'dialogue-project' });

function characterMetadata(project: AuthoringProject, ref: DialogueCharacterRef | null): Record<string, unknown> | null {
  if (!ref) return null;
  const id = ref.$ref.id;
  const record = project.characters[id];
  const data = parseCharacterData(record?.data);
  return {
    id,
    label: record?.label ?? id,
    displayName: data?.displayName ?? record?.label ?? id,
    dialogueStyle: data?.dialogue ?? null,
  };
}

function speakerForLine(
  project: AuthoringProject,
  data: DialogueData,
  block: DialogueSequenceBlockData,
  segment: Extract<DialogueSegmentData, { type: 'line' }>,
): Record<string, unknown> | null {
  return characterMetadata(project, segment.speaker ?? block.defaultSpeaker ?? data.defaultSpeaker);
}

function addConditionDependency(project: AuthoringProject, condition: Condition | undefined, dependencies: Set<string>) {
  if (condition?.kind !== 'variable-comparison') return;
  const id = condition.variable.$ref.id;
  dependencies.add(`variable:${id}:${JSON.stringify(project.variables[id]?.data ?? null)}`);
}

function addEffectDependencies(project: AuthoringProject, effects: readonly Effect[], dependencies: Set<string>) {
  for (const effect of effects) {
    if (effect.kind !== 'set-variable') continue;
    const id = effect.variable.$ref.id;
    dependencies.add(`variable:${id}:${JSON.stringify(project.variables[id]?.data ?? null)}`);
  }
}

function dependencyRevision(project: AuthoringProject, data: DialogueData): string[] {
  const dependencies = new Set<string>();
  const addCharacter = (ref: DialogueCharacterRef | null) => {
    if (!ref) return;
    const id = ref.$ref.id;
    dependencies.add(`character:${id}:${JSON.stringify(project.characters[id]?.data ?? null)}`);
  };
  addCharacter(data.defaultSpeaker);
  for (const block of data.blocks) {
    if (block.type !== 'sequence') continue;
    addCharacter(block.defaultSpeaker);
    for (const segment of block.segments) {
      if (segment.type === 'line') {
        addCharacter(segment.speaker);
        addConditionDependency(project, segment.condition, dependencies);
        addEffectDependencies(project, segment.effects, dependencies);
      } else if (segment.type === 'run-lua') {
        addConditionDependency(project, segment.condition, dependencies);
      }
    }
  }
  for (const edge of data.edges) {
    if (edge.kind !== 'choice') continue;
    addConditionDependency(project, edge.condition, dependencies);
    addEffectDependencies(project, edge.effects, dependencies);
  }
  return [...dependencies].sort();
}

function selectedBlock(data: DialogueData, selectedBlockId?: string | null): DialogueBlockData | null {
  return data.blocks.find((block) => block.id === selectedBlockId)
    ?? data.blocks.find((block) => block.id === data.entryBlockId)
    ?? data.blocks[0]
    ?? null;
}

function selectedSegment(
  block: DialogueBlockData | null,
  selectedSegmentId?: string | null,
): DialogueSegmentData | null {
  if (block?.type !== 'sequence') return null;
  return block.segments.find((segment) => segment.id === selectedSegmentId)
    ?? block.segments[0]
    ?? null;
}

function blockPreview(project: AuthoringProject, data: DialogueData, block: DialogueBlockData): Record<string, unknown> {
  if (block.type !== 'sequence') return block;
  return {
    ...block,
    speakerMetadata: characterMetadata(project, block.defaultSpeaker ?? data.defaultSpeaker),
    segments: block.segments.map((segment) => segment.type === 'line'
      ? { ...segment, speakerMetadata: speakerForLine(project, data, block, segment) }
      : segment),
  };
}

export function dialoguePreviewRevision(project: AuthoringProject, dialogueId: string): string {
  const record = project.dialogues[dialogueId];
  const data = parseDialogueData(record?.data);
  if (!record || !data) return `${dialogueId}:missing-or-invalid`;
  return JSON.stringify({ dialogueId, label: record.label, data, dependencies: dependencyRevision(project, data) });
}

export function buildDialoguePreviewDocumentData(
  project: AuthoringProject,
  dialogueId: string,
  options: DialoguePreviewOptions = {},
): Record<string, unknown> {
  const record = project.dialogues[dialogueId];
  const data = parseDialogueData(record?.data);
  if (!record || !data) {
    return {
      schema: DIALOGUE_PREVIEW_SCHEMA,
      dialogueId,
      label: dialogueId,
      diagnostics: [diagnostic(`/dialogues/${dialogueId}/data`, 'Invalid dialogue data.')],
    };
  }

  const block = selectedBlock(data, options.selectedBlockId);
  const segment = selectedSegment(block, options.selectedSegmentId);
  const outgoingEdges = block ? data.edges.filter((edge) => edge.fromBlockId === block.id) : [];
  const selectedLine = segment?.type === 'line' && block?.type === 'sequence'
    ? { ...segment, speakerMetadata: speakerForLine(project, data, block, segment) }
    : segment;

  return {
    schema: DIALOGUE_PREVIEW_SCHEMA,
    dialogueId,
    label: record.label,
    displayName: data.displayName,
    entryBlockId: data.entryBlockId,
    selectedBlockId: block?.id ?? null,
    selectedSegmentId: segment?.id ?? null,
    selectedBlock: block ? blockPreview(project, data, block) : null,
    selectedSegment: selectedLine,
    choices: outgoingEdges.filter((edge) => edge.kind === 'choice').map((edge) => ({
      ...edge,
      targetLabel: data.blocks.find((candidate) => candidate.id === edge.toBlockId)?.label ?? edge.toBlockId,
    })),
    next: outgoingEdges.find((edge) => edge.kind === 'next') ?? null,
    redirect: block?.type === 'redirect' ? {
      targetBlockId: block.targetBlockId,
      targetLabel: data.blocks.find((candidate) => candidate.id === block.targetBlockId)?.label ?? block.targetBlockId,
    } : null,
    settings: data.settings,
    completion: data.completion,
    preview: {
      showConditions: options.showConditions ?? true,
      background: options.background ?? 'dark',
    },
    diagnostics: validateDialogueData(project, dialogueId, record),
  };
}
