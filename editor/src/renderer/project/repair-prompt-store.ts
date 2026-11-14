import { create } from 'zustand';
import { useProjectStore } from './project-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useCandidateRepairStore } from './candidate-repair-store';
import {
  buildRepairPrompt,
  candidateFormatRisk,
  repairDiagnosticFingerprint,
  selectedRepairDiagnostics,
  type CandidateFormatRisk,
  type RepairPromptInput,
  type RepairPromptScope,
} from './repair-prompt';

export interface RepairPromptRequest {
  kind: 'active' | 'candidate';
  id: string;
  scope: RepairPromptScope;
  selectedKey?: string;
}

export interface RepairPromptDraft extends RepairPromptRequest {
  root: string;
  text: string;
  diagnosticFingerprint: string;
  sourceFingerprint: string;
  candidateRevision?: string;
  recognition?: 'strong' | 'weak';
  formatRisk: CandidateFormatRisk;
  manifestAbsent: boolean;
  authorizeWeak: boolean;
  authorizeOlder: boolean;
  authorizeNewer: boolean;
}

function currentInput(
  request: RepairPromptRequest,
): { input: RepairPromptInput; sourceFingerprint: string } | null {
  if (request.kind === 'candidate') {
    const entry = useCandidateRepairStore.getState().entries[request.id];
    // Failed-open diagnostics describe the source on disk, not an unvalidated
    // candidate edit buffer or source that changed since the last failed Open.
    if (
      !entry ||
      entry.admitted ||
      entry.diagnosticsNeedRefresh ||
      (entry.source && entry.buffer !== entry.source.text)
    )
      return null;
    return {
      input: {
        root: entry.root,
        kind: 'candidate',
        scope: request.scope,
        selectedKey: request.selectedKey,
        diagnostics: entry.diagnostics,
        recognition: entry.recognition,
        manifest: entry.source?.text,
      },
      sourceFingerprint: `${entry.source?.revision ?? 'unloaded'}:${entry.buffer ?? ''}`,
    };
  }
  const project = useProjectStore.getState();
  if (
    !project.projectPath ||
    (project.projectSessionId ?? project.projectInstanceId) !== request.id
  )
    return null;
  return {
    input: {
      root: project.projectPath,
      kind: 'active',
      scope: request.scope,
      selectedKey: request.selectedKey,
      diagnostics: useWorkspaceStore.getState().diagnostics,
      savedDocument: project.savedDocument,
      workingDocument: project.document,
    },
    sourceFingerprint: String(project.projectRevision),
  };
}

export function repairPromptIsCurrent(draft: RepairPromptDraft): boolean {
  const current = currentInput(draft);
  if (!current || current.input.root !== draft.root) return false;
  const selected = selectedRepairDiagnostics(
    current.input.diagnostics,
    draft.scope,
    draft.selectedKey,
  );
  return (
    selected.length > 0 &&
    current.sourceFingerprint === draft.sourceFingerprint &&
    repairDiagnosticFingerprint(selected) === draft.diagnosticFingerprint
  );
}

function makeDraft(request: RepairPromptRequest): RepairPromptDraft | null {
  const current = currentInput(request);
  if (!current) return null;
  const prompt = buildRepairPrompt(current.input);
  if (!prompt) return null;
  return {
    ...request,
    root: current.input.root,
    ...(request.kind === 'candidate'
      ? {
          candidateRevision:
            useCandidateRepairStore.getState().entries[request.id]?.source?.revision,
        }
      : {}),
    recognition: current.input.recognition,
    formatRisk: candidateFormatRisk(current.input.manifest),
    manifestAbsent:
      request.kind === 'candidate' &&
      useCandidateRepairStore.getState().entries[request.id]?.source?.revision === 'absent',
    text: prompt,
    sourceFingerprint: current.sourceFingerprint,
    diagnosticFingerprint: repairDiagnosticFingerprint(
      selectedRepairDiagnostics(current.input.diagnostics, request.scope, request.selectedKey),
    ),
    authorizeWeak: false,
    authorizeOlder: false,
    authorizeNewer: false,
  };
}

interface RepairPromptStore {
  visible: boolean;
  draft: RepairPromptDraft | null;
  request: (request: RepairPromptRequest) => boolean;
  close: () => void;
  setText: (text: string) => void;
  setAuthorization: (
    kind: 'authorizeWeak' | 'authorizeOlder' | 'authorizeNewer',
    value: boolean,
  ) => void;
}

export const useRepairPromptStore = create<RepairPromptStore>()((set) => ({
  visible: false,
  draft: null,
  request: (request) => {
    const draft = makeDraft(request);
    if (!draft) return false;
    set({ draft, visible: true });
    return true;
  },
  close: () => set({ visible: false }),
  setText: (text) =>
    set((state) => ({
      draft: state.draft ? { ...state.draft, text } : null,
    })),
  setAuthorization: (kind, value) =>
    set((state) => ({
      draft: state.draft ? { ...state.draft, [kind]: value } : null,
    })),
}));

/** Read by the future Run boundary, which must also revalidate main-owned authority. */
export function repairPromptRunAuthorized(draft: RepairPromptDraft): boolean {
  return (
    repairPromptIsCurrent(draft) &&
    (draft.kind !== 'candidate' || draft.formatRisk !== 'unknown' || draft.manifestAbsent) &&
    (draft.recognition !== 'weak' || draft.authorizeWeak) &&
    (draft.formatRisk !== 'newer' || draft.authorizeNewer) &&
    (draft.formatRisk !== 'older' || draft.authorizeOlder)
  );
}
