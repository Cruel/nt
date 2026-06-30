import { useEffect, useRef } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import { cn } from '@/lib/utils';

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
  language?: 'json' | 'lua' | 'rml' | 'rcss' | 'shader' | 'text';
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

export function SourceEditor({ value, onChange, readOnly = false, diagnostics = [], language: _language = 'text', className }: SourceEditorProps) {
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
        lintGutter(),
        linter((view) => diagnosticsRef.current.map((item) => toCodemirrorDiagnostic(item, view.state.doc.length))),
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '12px' },
          '.cm-scroller': { fontFamily: 'var(--font-mono, monospace)' },
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={hostRef} className={cn('min-h-48 overflow-hidden rounded border bg-background', className)} />;
}
