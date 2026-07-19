import type { ComponentType } from 'react';
import {
  Archive,
  Bolt,
  Box,
  Clapperboard,
  DoorOpen,
  EyeOff,
  FileCode,
  FlaskConical,
  Folder,
  Image,
  Layers,
  Map,
  MessageSquareText,
  Palette,
  Route,
  ScrollText,
  SlidersHorizontal,
  User,
} from 'lucide-react';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';

export interface VisualIdentity {
  icon: ComponentType<{ className?: string }>;
  colorClassName: string;
}

export const collectionVisuals: Record<AuthoringCollectionKey, VisualIdentity> = {
  interactions: { icon: Bolt, colorClassName: 'text-emerald-700 dark:text-emerald-300' },
  assets: { icon: Image, colorClassName: 'text-blue-700 dark:text-blue-300' },
  characters: { icon: User, colorClassName: 'text-violet-700 dark:text-violet-300' },
  dialogues: { icon: MessageSquareText, colorClassName: 'text-sky-700 dark:text-sky-300' },
  layouts: { icon: Layers, colorClassName: 'text-indigo-700 dark:text-indigo-300' },
  maps: { icon: Map, colorClassName: 'text-lime-700 dark:text-lime-300' },
  materials: { icon: Palette, colorClassName: 'text-orange-700 dark:text-orange-300' },
  interactables: { icon: Box, colorClassName: 'text-stone-700 dark:text-stone-300' },
  rooms: { icon: DoorOpen, colorClassName: 'text-amber-700 dark:text-amber-300' },
  scenes: { icon: Clapperboard, colorClassName: 'text-fuchsia-700 dark:text-fuchsia-300' },
  scripts: { icon: ScrollText, colorClassName: 'text-slate-700 dark:text-slate-300' },
  shaders: { icon: FileCode, colorClassName: 'text-cyan-700 dark:text-cyan-300' },
  tests: { icon: FlaskConical, colorClassName: 'text-rose-700 dark:text-rose-300' },
  variables: { icon: SlidersHorizontal, colorClassName: 'text-teal-700 dark:text-teal-300' },
  verbs: { icon: Route, colorClassName: 'text-green-700 dark:text-green-300' },
};

export const chapterVisual: VisualIdentity = {
  icon: Folder,
  colorClassName: 'text-purple-700 dark:text-purple-300',
};

export const hiddenVisual: VisualIdentity = {
  icon: EyeOff,
  colorClassName: 'text-muted-foreground',
};

export const archiveVisual: VisualIdentity = {
  icon: Archive,
  colorClassName: 'text-muted-foreground',
};

export function visualForCollection(collection: AuthoringCollectionKey): VisualIdentity {
  return collectionVisuals[collection];
}

export function visualForEditorType(
  editorType: string,
  collection?: string | null,
): VisualIdentity | null {
  if (collection && Object.prototype.hasOwnProperty.call(collectionVisuals, collection)) {
    return collectionVisuals[collection as AuthoringCollectionKey];
  }
  if (editorType === 'asset-detail' || editorType === 'asset-library')
    return collectionVisuals.assets;
  if (editorType === 'variables') return collectionVisuals.variables;
  if (editorType === 'test-detail' || editorType === 'test-suite') return collectionVisuals.tests;
  if (editorType === 'shader-detail') return collectionVisuals.shaders;
  if (editorType === 'material-detail') return collectionVisuals.materials;
  if (editorType === 'layout-detail') return collectionVisuals.layouts;
  if (editorType === 'character-detail') return collectionVisuals.characters;
  if (editorType === 'room-detail') return collectionVisuals.rooms;
  if (editorType === 'interactable-detail') return collectionVisuals.interactables;
  if (editorType === 'dialogue-detail') return collectionVisuals.dialogues;
  if (editorType === 'scene-detail') return collectionVisuals.scenes;
  return null;
}
