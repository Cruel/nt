import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ToolDiagnostic } from '../../shared/editor-tooling';
import { useCommandStore } from '../commands/command-store';
import { useProjectStore } from './project-store';

function identity() {
  const project = useProjectStore.getState();
  const commands = useCommandStore.getState();
  if (
    !project.nativeSession ||
    !project.projectSessionId ||
    !project.projectInstanceId ||
    commands.nativeProjectSessionId !== project.projectSessionId ||
    commands.nativeWorkingRevision === null ||
    commands.nativeProjectionRevision !== project.projectRevision ||
    commands.nativeMutationPending ||
    commands.nativeMutationFailure
  )
    return null;
  return {
    session: project.projectSessionId,
    instance: project.projectInstanceId,
    revision: commands.nativeWorkingRevision,
    projection: project.projectRevision,
  };
}

const EMPTY_DIAGNOSTICS: ToolDiagnostic[] = [];
let requested = '';
let diagnostics: ToolDiagnostic[] = [];
let visibleSession: string | null = null;
let completed = false;
let generation = 0;
let version = 0;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
function notify() {
  version++;
  for (const listener of listeners) listener();
}

export function currentNativeProjectDiagnostics(): ToolDiagnostic[] {
  const project = useProjectStore.getState();
  const commands = useCommandStore.getState();
  // A pending revision keeps the last completed findings. A fatal mutation
  // instead shows its own diagnostic once refresh has observed the failure.
  if (!project.nativeSession) return EMPTY_DIAGNOSTICS;
  if (commands.nativeMutationFailure) return requested === 'null' ? diagnostics : EMPTY_DIAGNOSTICS;
  return project.projectSessionId === visibleSession ? diagnostics : EMPTY_DIAGNOSTICS;
}

export function nativeProjectDiagnosticsReady(): boolean {
  return completed && identity() !== null && requested === JSON.stringify(identity());
}

/** Native validation is read-only and pinned to both session and renderer projection. */
export function refreshNativeProjectDiagnostics(force = false): Promise<void> {
  const current = identity();
  const key = JSON.stringify(current);
  if (!force && key === requested) return pending ?? Promise.resolve();
  requested = key;
  completed = false;
  if (!current || current.session !== visibleSession) {
    if (useProjectStore.getState().projectSessionId !== visibleSession) {
      diagnostics = [];
      visibleSession = null;
    }
  }
  const token = ++generation;
  if (
    !current &&
    useProjectStore.getState().nativeSession &&
    useCommandStore.getState().nativeMutationFailure
  ) {
    diagnostics = [
      {
        code: 'editor.native-validation.failed',
        severity: 'error',
        path: '/',
        category: 'Native authoring validation',
        message:
          useCommandStore.getState().nativeMutationFailure ??
          'Native Project revision is not available for validation.',
      },
    ];
  }
  notify();
  if (!current) {
    pending = null;
    return Promise.resolve();
  }
  pending = Promise.resolve()
    .then(() => window.noveltea.nativeProjectValidate(current.session, current.revision))
    .then((reply) => {
      if (token !== generation || key !== JSON.stringify(identity())) return;
      diagnostics = reply.diagnostics;
      visibleSession = current.session;
      completed = true;
      notify();
    })
    .catch((error: unknown) => {
      if (token !== generation || key !== JSON.stringify(identity())) return;
      diagnostics = [
        {
          code: 'editor.native-validation.failed',
          severity: 'error',
          path: '/',
          category: 'Native authoring validation',
          message: error instanceof Error ? error.message : String(error),
        },
      ];
      visibleSession = current.session;
      notify();
    });
  return pending;
}

let consumers = 0;
let stop: (() => void) | null = null;
export function useNativeProjectDiagnostics(ownerPath?: string) {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => version,
    () => version,
  );
  useEffect(() => {
    if (consumers++ === 0) {
      const synchronize = () => {
        void refreshNativeProjectDiagnostics();
      };
      const project = useProjectStore.subscribe(synchronize);
      const commands = useCommandStore.subscribe(synchronize);
      stop = () => {
        project();
        commands();
      };
      synchronize();
    }
    return () => {
      if (--consumers === 0) {
        stop?.();
        stop = null;
        requested = '';
        diagnostics = [];
        visibleSession = null;
        generation++;
      }
    };
  }, []);
  const current = currentNativeProjectDiagnostics();
  return useMemo(
    () =>
      ownerPath
        ? current.filter((item) => item.path === ownerPath || item.path.startsWith(`${ownerPath}/`))
        : current,
    [current, ownerPath],
  );
}
