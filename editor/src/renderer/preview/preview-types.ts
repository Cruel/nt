import type {
  PreviewConnectionState,
  PreviewDocument,
  PreviewMode,
  PreviewTarget,
} from '../../shared/preview-protocol';

export type { PreviewDocument, PreviewMode, PreviewTarget } from '../../shared/preview-protocol';

export type PreviewSessionKind =
  | 'primary-runtime'
  | 'entity'
  | 'thumbnail-worker'
  | 'test-playback';
export type PreviewSessionStatus = PreviewConnectionState | 'idle' | 'disposed';
export type PreviewDiagnosticSeverity = 'info' | 'warning' | 'error';
export type PreviewDiagnosticSource =
  | 'protocol'
  | 'transport'
  | 'runtime'
  | 'manager'
  | 'thumbnail';
export type ThumbnailStatus = 'queued' | 'rendering' | 'ready' | 'error' | 'fallback';

export interface PreviewDiagnosticRecord {
  id: string;
  sessionId?: string;
  target?: PreviewTarget;
  severity: PreviewDiagnosticSeverity;
  source: PreviewDiagnosticSource;
  message: string;
  path?: string;
  timestamp: number;
}

export interface PreviewSessionRecord {
  id: string;
  kind: PreviewSessionKind;
  ownerId: string;
  target?: PreviewTarget;
  status: PreviewSessionStatus;
  capabilities: string[];
  active: boolean;
  createdAt: number;
  lastUsedAt: number;
  diagnosticIds: string[];
  transport?: {
    url: string;
    origin: string;
  };
}

export interface PreviewReplayState {
  documentsBySessionId: Record<string, PreviewDocument>;
  modeBySessionId: Record<string, PreviewMode>;
}

export interface ThumbnailRequest {
  id: string;
  target: PreviewTarget;
  cacheKey: string;
  document: PreviewDocument;
  status: ThumbnailStatus;
  dataUrl?: string;
  error?: string;
  requestedAt: number;
  updatedAt: number;
}

export interface EntityPreviewRequest {
  ownerId: string;
  target: PreviewTarget;
  document?: PreviewDocument;
  mode?: PreviewMode;
  now?: number;
}

export interface ThumbnailRequestInput {
  target: PreviewTarget;
  document: PreviewDocument;
  revision: string;
  now?: number;
}
