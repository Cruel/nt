import { parseCharacterData } from './authoring-characters';
import {
  parseDialogueData,
  validateDialogueData,
  type DialogueBlockData,
  type DialogueCharacterRef,
  type DialogueData,
  type DialogueSegmentData,
} from './authoring-dialogues';
import type { AuthoringProject } from './authoring-project';

export const DIALOGUE_PREVIEW_SCHEMA = 'noveltea.dialogue-preview.v1' as const;

export interface DialogueProjectDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(path: string, message: string, severity: 'error' | 'warning' | 'info' = 'error'): DialogueProjectDiagnostic {
  return { severity, path, message, category: 'dialogue-project' };
}

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

function speakerForSegment(project: AuthoringProject, data: DialogueData, block: DialogueBlockData, segment: DialogueSegmentData): Record<string, unknown> | null {
  return characterMetadata(project, segment.speaker ?? block.defaultSpeaker ?? data.defaultSpeaker);
}

function dependencyRevision(project: AuthoringProject, data: DialogueData): string[] {
  const dependencies = new Set<string>();
  if (data.defaultSpeaker) {
    const id = data.defaultSpeaker.$ref.id;
    dependencies.add(`character:${id}:${JSON.stringify(project.characters[id]?.data ?? null)}`);
  }
  for (const block of data.blocks) {
    if (block.defaultSpeaker) {
      const id = block.defaultSpeaker.$ref.id;
      dependencies.add(`character:${id}:${JSON.stringify(project.characters[id]?.data ?? null)}`);
    }
    for (const segment of block.segments) {
      if (segment.speaker) {
        const id = segment.speaker.$ref.id;
        dependencies.add(`character:${id}:${JSON.stringify(project.characters[id]?.data ?? null)}`);
      }
    }
  }
  return [...dependencies].sort();
}

function selectedBlock(data: DialogueData): DialogueBlockData | null {
  return data.blocks.find((block) => block.id === data.preview.selectedBlockId)
    ?? data.blocks.find((block) => block.id === data.entryBlockId)
    ?? data.blocks[0]
    ?? null;
}

function selectedSegment(block: DialogueBlockData | null, data: DialogueData): DialogueSegmentData | null {
  if (!block) return null;
  return block.segments.find((segment) => segment.id === data.preview.selectedSegmentId)
    ?? block.segments[0]
    ?? null;
}

export function dialoguePreviewRevision(project: AuthoringProject, dialogueId: string): string {
  const record = project.dialogues[dialogueId];
  const data = parseDialogueData(record?.data);
  if (!record || !data) return `${dialogueId}:missing-or-invalid`;
  return JSON.stringify({ dialogueId, label: record.label, data, dependencies: dependencyRevision(project, data) });
}

export function buildDialoguePreviewDocumentData(project: AuthoringProject, dialogueId: string): Record<string, unknown> {
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

  const block = selectedBlock(data);
  const segment = selectedSegment(block, data);
  const outgoingEdges = block
    ? data.edges
      .filter((edge) => edge.fromBlockId === block.id)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    : [];

  return {
    schema: DIALOGUE_PREVIEW_SCHEMA,
    dialogueId,
    label: record.label,
    displayName: data.displayName,
    entryBlockId: data.entryBlockId,
    selectedBlockId: block?.id ?? null,
    selectedSegmentId: segment?.id ?? null,
    selectedBlock: block ? {
      ...block,
      speakerMetadata: characterMetadata(project, block.defaultSpeaker ?? data.defaultSpeaker),
      segments: block.segments.map((item) => ({
        ...item,
        speakerMetadata: speakerForSegment(project, data, block, item),
      })),
    } : null,
    selectedSegment: segment ? {
      ...segment,
      speakerMetadata: block ? speakerForSegment(project, data, block, segment) : null,
    } : null,
    choices: outgoingEdges.map((edge) => ({
      ...edge,
      targetLabel: project.dialogues[dialogueId]?.data ? data.blocks.find((item) => item.id === edge.toBlockId)?.label ?? edge.toBlockId : edge.toBlockId,
    })),
    settings: data.settings,
    preview: data.preview,
    diagnostics: validateDialogueData(project, dialogueId, record),
  };
}
