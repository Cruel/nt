import type { AssetKind } from './project-schema/authoring-assets';
import type {
  ProjectOriginalAssetBoundaryCode,
  ProjectOriginalAssetFailureCode,
} from './project-original-asset';

export type AssetMetadataValueKind = 'text' | 'number' | 'boolean' | 'json';
export type AssetMetadataValue = string | number | boolean;

export interface AssetMetadataInspectionItem {
  id: string;
  key: string;
  value: AssetMetadataValue;
  valueKind: AssetMetadataValueKind;
}

export interface AssetMetadataInspectionGroup {
  id: string;
  namespace: string;
  items: AssetMetadataInspectionItem[];
}

export type AssetProvenanceTrust = 'unverified' | 'verified' | 'invalid';
export type AssetProvenanceRole = 'generated' | 'edited' | 'processed';

export interface AssetProvenanceEntity {
  id: string;
  label: string;
}

export interface AssetProvenanceStage {
  id: string;
  role: AssetProvenanceRole;
  provider?: AssetProvenanceEntity;
  tool?: AssetProvenanceEntity;
  model?: AssetProvenanceEntity;
  description?: string;
}

export interface AssetRecognizedProvenance {
  stages: AssetProvenanceStage[];
}

export interface AssetRecognizedGenerationFact {
  id: 'model' | 'seed' | 'steps' | 'cfg' | 'dimensions';
  value: string;
}

export interface AssetRecognizedGeneration {
  prompt?: string;
  negativePrompt?: string;
  facts: AssetRecognizedGenerationFact[];
}

export interface AssetC2paStatus {
  trust: AssetProvenanceTrust;
}

export interface AssetWorkflowMetadata {
  tool: AssetProvenanceEntity;
  kind: 'workflow';
}

export interface AssetMetadataInspectionReadyResponse {
  ok: true;
  status: 'ready';
  kind: AssetKind;
  contentHash: string;
  groups: AssetMetadataInspectionGroup[];
  c2pa?: AssetC2paStatus;
  provenance?: AssetRecognizedProvenance;
  generation?: AssetRecognizedGeneration;
  workflowMetadata?: AssetWorkflowMetadata[];
  warnings?: string[];
}

export interface AssetMetadataInspectionUnsupportedResponse {
  ok: true;
  status: 'unsupported';
  kind: AssetKind;
  contentHash?: string;
  groups: [];
}

export type AssetMetadataInspectionFailureCode = ProjectOriginalAssetFailureCode | 'decode-failed';

export interface AssetMetadataInspectionFailureResponse {
  ok: false;
  status: 'failure';
  code: AssetMetadataInspectionFailureCode;
  boundaryCode?: ProjectOriginalAssetBoundaryCode;
  message: string;
}

export type AssetMetadataInspectionResponse =
  | AssetMetadataInspectionReadyResponse
  | AssetMetadataInspectionUnsupportedResponse
  | AssetMetadataInspectionFailureResponse;
