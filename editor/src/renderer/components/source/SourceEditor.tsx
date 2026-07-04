import { useEffect, useRef } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { linter, type Diagnostic } from '@codemirror/lint';
import { css } from '@codemirror/lang-css';
import { cpp } from '@codemirror/lang-cpp';
import { html, type TagSpec } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { StreamLanguage } from '@codemirror/language';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { cn } from '@/lib/utils';
import { usePreferencesStore } from '@/stores/preferences-store';
import {
  createSourceEditorCompletionSource,
  rmlAttributeCompletions,
  rmlElementCompletions,
  type SourceEditorCompletionContext,
  type SourceEditorLanguage,
} from './source-editor-completions';
import type { CodeEditorThemeId } from './source-editor-theme-types';
import { sourceEditorThemeExtension } from './source-editor-themes';

export interface SourceEditorDiagnostic {
  from?: number;
  to?: number;
  message: string;
  severity?: 'info' | 'warning' | 'error';
}

export interface SourceEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  diagnostics?: SourceEditorDiagnostic[];
  language?: SourceEditorLanguage;
  completionContext?: SourceEditorCompletionContext;
  themeId?: CodeEditorThemeId;
  className?: string;
}

function toCodemirrorDiagnostic(item: SourceEditorDiagnostic, docLength: number): Diagnostic {
  return {
    from: Math.max(0, Math.min(item.from ?? 0, docLength)),
    to: Math.max(0, Math.min(item.to ?? item.from ?? 0, docLength)),
    severity: item.severity ?? 'error',
    message: item.message,
  };
}

const rmlExtraTags = Object.fromEntries(rmlElementCompletions.map((completion) => [completion.label, {} satisfies TagSpec]));
const rmlExtraAttributes = Object.fromEntries(rmlAttributeCompletions.map((completion) => [completion.label, null]));

function languageExtensions(language: SourceEditorLanguage, completionContext?: SourceEditorCompletionContext): Extension[] {
  const completionData = EditorState.languageData.of(() => [
    { autocomplete: createSourceEditorCompletionSource(language, completionContext) },
  ]);
  if (language === 'json') return [json()];
  if (language === 'rml') return [html({ selfClosingTags: true, extraTags: rmlExtraTags, extraGlobalAttributes: rmlExtraAttributes }), completionData];
  if (language === 'rcss') return [css(), completionData];
  if (language === 'lua') return [StreamLanguage.define(lua), completionData];
  if (language === 'shader') return [cpp(), completionData];
  return [];
}

export function SourceEditor({ value, onChange, readOnly = false, diagnostics = [], language = 'text', completionContext, themeId, className }: SourceEditorProps) {
  const preferredTheme = usePreferencesStore((state) => state.codeEditorTheme);
  const activeTheme = themeId ?? preferredTheme;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const diagnosticsRef = useRef(diagnostics);
  onChangeRef.current = onChange;
  diagnosticsRef.current = diagnostics;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: [
        basicSetup,
        linter((view) => diagnosticsRef.current.map((item) => toCodemirrorDiagnostic(item, view.state.doc.length))),
        languageExtensions(language, completionContext),
        sourceEditorThemeExtension(activeTheme),
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '12px' },
          '.cm-scroller': { fontFamily: 'var(--font-mono, monospace)' },
          '.cm-gutters': { paddingRight: '0 !important' },
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [activeTheme, completionContext, language, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={hostRef} className={cn('min-h-48 overflow-hidden rounded border bg-background', className)} />;
}
