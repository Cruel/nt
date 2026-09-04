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

export interface AssetMetadataInspectionReadyResponse {
  ok: true;
  status: 'ready';
  kind: AssetKind;
  contentHash: string;
  groups: AssetMetadataInspectionGroup[];
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
