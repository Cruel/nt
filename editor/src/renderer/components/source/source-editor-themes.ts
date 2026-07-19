import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import {
  abcdef,
  abyss,
  androidStudio,
  andromeda,
  basicDark,
  basicLight,
  catppuccinMocha,
  cobalt2,
  forest,
  githubDark,
  githubLight,
  gruvboxDark,
  gruvboxLight,
  highContrastDark,
  highContrastLight,
  materialDark,
  materialLight,
  materialOcean,
  monokai,
  nord,
  palenight,
  solarizedDark,
  solarizedLight,
  synthwave84,
  tokyoNightDay,
  tokyoNightStorm,
  volcano,
  vsCodeDark,
  vsCodeLight,
} from '@fsegurai/codemirror-theme-bundle';
import type { CodeEditorThemeId } from './source-editor-theme-types';

export interface CodeEditorThemeOption {
  id: CodeEditorThemeId;
  label: string;
  variant: 'light' | 'dark';
}

const novelteaTheme: Extension = [
  EditorView.theme({
    '&': {
      backgroundColor: 'hsl(var(--background))',
      color: 'hsl(var(--foreground))',
    },
    '.cm-content': {
      caretColor: 'hsl(var(--foreground))',
    },
    '.cm-gutters': {
      backgroundColor: 'hsl(var(--muted))',
      color: 'hsl(var(--muted-foreground))',
      borderRightColor: 'hsl(var(--border))',
    },
    '.cm-activeLine': {
      backgroundColor: 'hsl(var(--accent) / 0.55)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'hsl(var(--accent))',
      color: 'hsl(var(--accent-foreground))',
    },
    '.cm-selectionBackground': {
      backgroundColor: 'hsl(var(--ring) / 0.22) !important',
    },
    '.cm-cursor': {
      borderLeftColor: 'hsl(var(--foreground))',
    },
  }),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: t.keyword, color: 'hsl(var(--primary))' },
      { tag: [t.tagName, t.attributeName], color: 'hsl(var(--chart-2))' },
      { tag: [t.string, t.special(t.string)], color: 'hsl(var(--chart-3))' },
      { tag: t.number, color: 'hsl(var(--chart-4))' },
      {
        tag: [t.comment, t.lineComment, t.blockComment],
        color: 'hsl(var(--muted-foreground))',
        fontStyle: 'italic',
      },
      {
        tag: [t.function(t.variableName), t.function(t.propertyName)],
        color: 'hsl(var(--chart-1))',
      },
      { tag: [t.variableName, t.propertyName], color: 'hsl(var(--foreground))' },
    ]),
  ),
];

export const codeEditorThemeOptions: CodeEditorThemeOption[] = [
  { id: 'noveltea', label: 'NovelTea', variant: 'light' },
  { id: 'abcdef', label: 'Abcdef', variant: 'dark' },
  { id: 'abyss', label: 'Abyss', variant: 'dark' },
  { id: 'androidStudio', label: 'Android Studio', variant: 'dark' },
  { id: 'andromeda', label: 'Andromeda', variant: 'dark' },
  { id: 'basicDark', label: 'Basic Dark', variant: 'dark' },
  { id: 'basicLight', label: 'Basic Light', variant: 'light' },
  { id: 'catppuccinMocha', label: 'Catppuccin Mocha', variant: 'dark' },
  { id: 'cobalt2', label: 'Cobalt2', variant: 'dark' },
  { id: 'forest', label: 'Forest', variant: 'dark' },
  { id: 'githubDark', label: 'GitHub Dark', variant: 'dark' },
  { id: 'githubLight', label: 'GitHub Light', variant: 'light' },
  { id: 'gruvboxDark', label: 'Gruvbox Dark', variant: 'dark' },
  { id: 'gruvboxLight', label: 'Gruvbox Light', variant: 'light' },
  { id: 'highContrastDark', label: 'High Contrast Dark', variant: 'dark' },
  { id: 'highContrastLight', label: 'High Contrast Light', variant: 'light' },
  { id: 'materialDark', label: 'Material Dark', variant: 'dark' },
  { id: 'materialLight', label: 'Material Light', variant: 'light' },
  { id: 'materialOcean', label: 'Material Ocean', variant: 'dark' },
  { id: 'monokai', label: 'Monokai', variant: 'dark' },
  { id: 'nord', label: 'Nord', variant: 'dark' },
  { id: 'palenight', label: 'Palenight', variant: 'dark' },
  { id: 'solarizedDark', label: 'Solarized Dark', variant: 'dark' },
  { id: 'solarizedLight', label: 'Solarized Light', variant: 'light' },
  { id: 'synthwave84', label: 'Synthwave 84', variant: 'dark' },
  { id: 'tokyoNightDay', label: 'Tokyo Night Day', variant: 'light' },
  { id: 'tokyoNightStorm', label: 'Tokyo Night Storm', variant: 'dark' },
  { id: 'volcano', label: 'Volcano', variant: 'dark' },
  { id: 'vsCodeDark', label: 'VS Code Dark', variant: 'dark' },
  { id: 'vsCodeLight', label: 'VS Code Light', variant: 'light' },
];

const codeEditorThemes: Record<CodeEditorThemeId, Extension> = {
  noveltea: novelteaTheme,
  abcdef,
  abyss,
  androidStudio,
  andromeda,
  basicDark,
  basicLight,
  catppuccinMocha,
  cobalt2,
  forest,
  githubDark,
  githubLight,
  gruvboxDark,
  gruvboxLight,
  highContrastDark,
  highContrastLight,
  materialDark,
  materialLight,
  materialOcean,
  monokai,
  nord,
  palenight,
  solarizedDark,
  solarizedLight,
  synthwave84,
  tokyoNightDay,
  tokyoNightStorm,
  volcano,
  vsCodeDark,
  vsCodeLight,
};

export function codeEditorThemeLabel(themeId: CodeEditorThemeId): string {
  return (
    codeEditorThemeOptions.find((option) => option.id === themeId)?.label ??
    codeEditorThemeOptions[0]!.label
  );
}

export function sourceEditorThemeExtension(themeId: CodeEditorThemeId): Extension {
  return codeEditorThemes[themeId] ?? codeEditorThemes.noveltea;
}
