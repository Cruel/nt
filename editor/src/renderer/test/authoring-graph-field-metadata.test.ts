import { describe, expect, it } from 'vite-plus/test';
import {
  AUTHORING_GRAPH_FIELD_METADATA,
  CURRENT_AUTHORING_GRAPH_FIELD_FINGERPRINTS,
  EXPECTED_AUTHORING_GRAPH_FIELD_FINGERPRINTS,
} from '../../shared/project-schema/authoring-graph-field-metadata';
import {
  AUTHORING_GRAPH_FIELD_METADATA as REVIEWED_AUTHORING_GRAPH_FIELD_METADATA,
  CURRENT_AUTHORING_GRAPH_FIELD_FINGERPRINTS as REVIEWED_CURRENT_FINGERPRINTS,
  EXPECTED_AUTHORING_GRAPH_FIELD_FINGERPRINTS as REVIEWED_EXPECTED_FINGERPRINTS,
} from '../../shared/project-schema/authoring-graph-field-metadata-review';

describe('generated authoring graph field metadata', () => {
  it('preserves the exact schema-derived paths, effects and order', () => {
    expect(AUTHORING_GRAPH_FIELD_METADATA).toEqual(REVIEWED_AUTHORING_GRAPH_FIELD_METADATA);
    expect(CURRENT_AUTHORING_GRAPH_FIELD_FINGERPRINTS).toEqual(REVIEWED_CURRENT_FINGERPRINTS);
    expect(EXPECTED_AUTHORING_GRAPH_FIELD_FINGERPRINTS).toEqual(REVIEWED_EXPECTED_FINGERPRINTS);
  });
});
