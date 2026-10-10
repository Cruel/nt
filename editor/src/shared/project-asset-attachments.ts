import type { AssetAttachmentPurpose } from './project-schema/authoring-assets';

export interface ProjectAttachmentFileInfo {
  path: string;
  byteSize: number;
}

export interface ProjectAttachmentFilesResponse {
  files: ProjectAttachmentFileInfo[];
}

export interface ProjectAttachmentImportRequest {
  projectSessionId: string;
  purpose: AssetAttachmentPurpose;
  destinationDirectory?: string;
}

export interface ProjectAttachmentImportResponse {
  paths: string[];
  reused: string[];
  canceled?: boolean;
  error?: string;
}

export interface ProjectAttachmentInspection {
  path: string;
  exists: boolean;
  contentHash?: `sha256:${string}`;
  byteSize?: number;
  preview?: string;
  previewLimited?: boolean;
  error?: string;
  /** File-specific Distribution Notice eligibility, independent of ordinary attachment use. */
  noticeError?: string;
}
